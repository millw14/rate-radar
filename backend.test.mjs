import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr/interface';
import { compileUnsignedTransaction } from '@heliuslabs/spr/internal';
import { DATABASE_SCHEMA_SQL, checkPaymentExpiry, encodeBase58, handleApi, parseAmount, reconcilePendingPayments, validateSignedPayment } from './backend.mjs';
import { DEVNET_GENESIS_HASH } from './rings-protocol.mjs';
import { getNetworkConfig } from './rings-networks.mjs';
import { handleCronRequest } from './api/index.mjs';

const ORIGIN = 'https://rate-radar.test';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function d1Adapter() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(DATABASE_SCHEMA_SQL);
  const prepare = (sql) => {
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: result.changes } }; },
    };
  };
  return {
    sqlite, prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

async function actor(id) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const wallet = encodeBase58(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  return { id, wallet, sign: async (message) => b64(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(message))), signBytes: async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)) };
}

async function fixture(t, overrides = {}) {
  const DB = d1Adapter();
  t.after(() => DB.sqlite.close());
  const env = { DB, HELIUS_API_KEY: 'test-provider-key', RECEIPT_ENCRYPTION_KEY: b64(crypto.getRandomValues(new Uint8Array(32))), RINGS_NETWORK: 'devnet', RINGS_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', ...overrides };
  const brand = await actor('brand');
  const creator = await actor('creator');
  const stranger = await actor('stranger');
  let verifier = async () => ({ status: 'pending', reason: 'Waiting for finality.' });
  let broadcaster = async () => {};
  let expiryLookup = async () => { throw new Error('No expiry lookup configured'); };
  const api = async (path, { method = 'GET', body, user = brand, headers = {}, origin = ORIGIN } = {}) => {
    const requestHeaders = { ...(user ? { 'oai-authenticated-user-id': user.id } : {}), ...(method !== 'GET' ? { origin, 'Content-Type': 'application/json' } : {}), ...headers };
    const response = await handleApi(new Request(`${ORIGIN}${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { verifyPayment: (...args) => verifier(...args), broadcastPayment: (...args) => broadcaster(...args), expiryRpc: (...args) => expiryLookup(...args) });
    return { status: response.status, body: await response.json() };
  };
  const link = async (user) => {
    const challenge = await api('/api/wallet/challenge', { method: 'POST', body: { wallet: user.wallet }, user });
    assert.equal(challenge.status, 200);
    const result = await api('/api/wallet/verify', { method: 'POST', body: { challengeId: challenge.body.challengeId, signature: await user.sign(challenge.body.message) }, user });
    assert.equal(result.status, 200);
    return result;
  };
  await link(brand); await link(creator); await link(stranger);
  const draft = async (extra = {}) => {
    const result = await api('/api/deals', { method: 'POST', body: { title: 'A creator launch', brandWallet: brand.wallet, creatorWallet: creator.wallet, amount: '1250.123456', category: 'X post / thread', usage: 'Organic only', deadline: '2026-12-01', notes: '', ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.deal;
  };
  const approve = async (deal, user) => {
    const challenge = await api(`/api/deals/${deal.id}/approval-challenge`, { method: 'POST', body: {}, user });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    return api(`/api/deals/${deal.id}/approve`, { method: 'POST', body: { challengeId: challenge.body.challengeId, signature: await user.sign(challenge.body.message) }, user });
  };
  const readyDeal = async (extra = {}) => {
    const deal = await draft(extra);
    const one = await approve(deal, brand);
    assert.equal(one.body.deal.status, 'awaiting_approval');
    const both = await approve(deal, creator);
    assert.equal(both.body.deal.status, 'ready');
    return both.body.deal;
  };
  const intent = async (deal, key = crypto.randomUUID()) => {
    const result = await api(`/api/deals/${deal.id}/payment-intents`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': key } });
    assert([200,201].includes(result.status), JSON.stringify(result.body));
    return result.body.intent;
  };
  return { env, DB, api, brand, creator, stranger, link, draft, approve, readyDeal, intent, setVerifier: (next) => { verifier = next; }, setBroadcaster: (next) => { broadcaster = next; }, setExpiryRpc: (next) => { expiryLookup = next; } };
}

async function disclosure(payer) {
  const { messageBytes } = compileUnsignedTransaction({ feePayer: payer.wallet, lifetime: { blockhash: encodeBase58(crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: 1000n }, instructions: [{ programAddress: SHIELDED_POOL_PROGRAM_ID, accounts: [{ address: payer.wallet, role: 3 }], data: new Uint8Array([0]) }], computeUnitLimit: 450000 });
  const signature = await payer.signBytes(messageBytes);
  const wire = getTransactionEncoder().encode({ messageBytes, signatures: { [payer.wallet]: signature } });
  return { signedTransaction: b64(wire), txSignature: encodeBase58(signature), transactionViewingKey: b64(crypto.getRandomValues(new Uint8Array(32))), eventIndex: 0, outputIndex: 1 };
}
function verified(input) {
  const { intent, txSignature } = input;
  return { status: 'verified', evidence: { finalized: true, finality: 'finalized', network: intent.network, txSignature, intentId: intent.id, termsHash: intent.termsHash, mint: intent.mint, amountAtomic: intent.amountAtomic, payerWallet: intent.payerWallet, recipientWallet: intent.recipientWallet, outputCommitment: 'a'.repeat(64), outputIndex: 1, instructionIndex: 2, slot: '123456', blockTime: 1794355200 } };
}

test('identity and same-origin authorization protect all mutations', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/config', { user: null })).body.authenticated, false);
  assert.equal((await f.api('/api/deals', { user: null })).status, 401);
  assert.equal((await f.api('/api/wallet/challenge', { method: 'POST', body: { wallet: f.brand.wallet }, origin: 'https://attacker.test' })).status, 403);
  const config = await f.api('/api/config');
  assert.equal(config.body.wallet, f.brand.wallet);
  assert.equal(config.body.paymentsEnabled, true);
  assert.equal(JSON.stringify(config.body).includes(f.env.HELIUS_API_KEY), false);
});

test('wallet signatures bind account, wallet, purpose, expiry, and single use', async (t) => {
  const f = await fixture(t);
  const challenge = (await f.api('/api/wallet/challenge', { method: 'POST', body: { wallet: f.brand.wallet } })).body;
  const signature = await f.brand.sign(challenge.message);
  assert.equal((await f.api('/api/wallet/verify', { method: 'POST', body: { challengeId: challenge.challengeId, signature }, user: f.creator })).status, 400);
  assert.equal((await f.api('/api/wallet/verify', { method: 'POST', body: { challengeId: challenge.challengeId, signature: await f.creator.sign(challenge.message) } })).status, 401);
  const first = await f.api('/api/wallet/verify', { method: 'POST', body: { challengeId: challenge.challengeId, signature } });
  assert.equal(first.status, 200);
  assert.equal((await f.api('/api/wallet/verify', { method: 'POST', body: { challengeId: challenge.challengeId, signature } })).status, 400);
  const expired = (await f.api('/api/wallet/challenge', { method: 'POST', body: { wallet: f.brand.wallet } })).body;
  f.DB.sqlite.prepare('UPDATE challenges SET expires_at=1 WHERE id=?').run(expired.challengeId);
  assert.equal((await f.api('/api/wallet/verify', { method: 'POST', body: { challengeId: expired.challengeId, signature: await f.brand.sign(expired.message) } })).status, 400);
});

test('one signing challenge cannot be consumed by concurrent verification requests', async (t) => {
  const f = await fixture(t);
  const challenge = (await f.api('/api/wallet/challenge', { method: 'POST', body: { wallet: f.brand.wallet } })).body;
  const body = { challengeId: challenge.challengeId, signature: await f.brand.sign(challenge.message) };
  const results = await Promise.all([f.api('/api/wallet/verify', { method: 'POST', body }), f.api('/api/wallet/verify', { method: 'POST', body })]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert(results.every((result) => [200,400,409].includes(result.status)));
});

test('amounts use exact atomic integers and dates reject calendar overflow', async (t) => {
  assert.equal(parseAmount('0.000001'), '1');
  assert.equal(parseAmount('1250.123456'), '1250123456');
  for (const value of ['0', '-1', '1e6', '1.0000001', '10000000.000001', 'NaN', '', '01']) assert.throws(() => parseAmount(value));
  const f = await fixture(t);
  const result = await f.api('/api/deals', { method: 'POST', body: { title: 'Invalid date', brandWallet: f.brand.wallet, creatorWallet: f.creator.wallet, amount: '5', category: 'X post', usage: 'Organic only', deadline: '2026-02-30' } });
  assert.equal(result.status, 400);
});

test('only the two wallet parties can read and approve a deal, and client status is ignored', async (t) => {
  const f = await fixture(t);
  const deal = await f.draft({ status: 'paid', synthetic: false });
  assert.equal(deal.status, 'draft');
  assert.equal((await f.api(`/api/deals/${deal.id}`, { user: f.stranger })).status, 404);
  assert.equal((await f.api(`/api/deals/${deal.id}/approval-challenge`, { method: 'POST', body: {}, user: f.stranger })).status, 404);
  assert.equal((await f.api('/api/deals', { user: f.stranger })).body.deals.length, 0);
  assert.equal((await f.api(`/api/deals/${deal.id}/payment-intents`, { method: 'POST', body: {} })).status, 409);
  const ready = await f.readyDeal();
  assert.equal(ready.approvals.length, 2);
  assert.equal((await f.api(`/api/deals/${ready.id}`, { method: 'PATCH', body: { version: ready.version, amount: '1' } })).status, 409);
  assert.equal((await f.api(`/api/deals/${ready.id}`, { method: 'DELETE' })).status, 409);
});

test('editing a draft invalidates old approval signatures and requires a current version', async (t) => {
  const f = await fixture(t);
  const deal = await f.draft();
  const challenge = (await f.api(`/api/deals/${deal.id}/approval-challenge`, { method: 'POST', body: {} })).body;
  const update = await f.api(`/api/deals/${deal.id}`, { method: 'PATCH', body: { version: deal.version, amount: '1400' } });
  assert.equal(update.status, 200);
  assert.notEqual(update.body.deal.termsHash, deal.termsHash);
  assert.equal(update.body.deal.version, deal.version + 1);
  assert.equal((await f.api(`/api/deals/${deal.id}/approve`, { method: 'POST', body: { challengeId: challenge.challengeId, signature: await f.brand.sign(challenge.message) } })).status, 409);
  assert.equal((await f.api(`/api/deals/${deal.id}`, { method: 'PATCH', body: { version: deal.version, amount: '1' } })).status, 409);
});

test('missing payment configuration does not disable shared drafts or agreement signatures', async (t) => {
  const f = await fixture(t, { HELIUS_API_KEY: '' });
  const config = (await f.api('/api/config')).body;
  assert.equal(config.draftsEnabled, true);
  assert.equal(config.paymentsEnabled, false);
  const deal = await f.readyDeal();
  assert.equal((await f.api(`/api/deals/${deal.id}/payment-intents`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': crypto.randomUUID() } })).status, 503);
});

test('payment intent creation is payer-only and idempotent across refresh and new request keys', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  assert.equal((await f.api(`/api/deals/${deal.id}/payment-intents`, { method: 'POST', body: {}, user: f.creator })).status, 403);
  const first = await f.intent(deal);
  const repeated = await f.intent(deal);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.memo, first.memo);
  assert.equal(first.amountAtomic, '1250123456');
  assert.equal(first.termsHash, deal.termsHash);
  const fresh = (await f.api(`/api/deals/${deal.id}`)).body.deal;
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.paymentIntentId, first.id);
});

test('pending and rejected verification never create receipts or mark a deal paid', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  const proof = await disclosure(f.brand);
  let result = await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof });
  assert.equal(result.status, 202);
  assert.equal(result.body.intent.status, 'pending');
  assert.equal(result.body.receipt, undefined);
  assert.equal((await f.api(`/api/deals/${deal.id}`)).body.deal.status, 'payment_pending');
  const stored = f.DB.sqlite.prepare('SELECT disclosure_ciphertext FROM payment_intents WHERE id=?').get(intent.id);
  assert(stored.disclosure_ciphertext);
  assert.equal(stored.disclosure_ciphertext.includes(proof.transactionViewingKey), false);
  assert.equal((await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: await disclosure(f.brand) })).status, 409);
  f.setVerifier(async () => ({ status: 'failed', reason: 'Amount mismatch.' }));
  result = await f.api(`/api/payment-intents/${intent.id}`);
  assert.equal(result.body.intent.status, 'failed');
  assert.equal((await f.api('/api/receipts')).body.receipts.length, 0);
  assert.equal((await f.api(`/api/deals/${deal.id}`)).body.deal.status, 'ready');
});

test('provider failures stay pending and scheduled reconciliation recovers without a second transfer', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  f.setVerifier(async () => { throw new Error('RPC disconnected'); });
  const result = await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: await disclosure(f.brand) });
  assert.equal(result.body.intent.status, 'pending');
  const checked = await reconcilePendingPayments(f.env, { verifyPayment: async (input) => verified(input), broadcastPayment: async () => {} });
  assert.equal(checked.checked, 1);
  assert.equal((await f.api(`/api/deals/${deal.id}`)).body.deal.status, 'paid');
  assert.equal((await f.api('/api/receipts')).body.receipts.length, 1);
});

test('only complete matching finality evidence can issue one authorized payment-only receipt', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  const proof = await disclosure(f.brand);
  f.setVerifier(async (input) => { const result = verified(input); result.evidence.finalized = false; return result; });
  const refused = await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof });
  assert.equal(refused.status, 502);
  assert.equal((await f.api('/api/receipts')).body.receipts.length, 0);
  f.setVerifier(async (input) => verified(input));
  const success = await f.api(`/api/payment-intents/${intent.id}`);
  assert.equal(success.body.intent.status, 'verified');
  assert.equal(success.body.receipt.verificationScope, 'payment_only');
  assert.equal(success.body.receipt.amountAtomic, deal.amountAtomic);
  assert.equal((await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof })).body.receipt.id, success.body.receipt.id);
  assert.equal((await f.api('/api/receipts', { user: f.creator })).body.receipts.length, 1);
  assert.equal((await f.api('/api/receipts', { user: f.stranger })).body.receipts.length, 0);
  assert.equal((await f.api(`/api/payment-intents/${intent.id}`, { user: f.stranger })).status, 404);
  assert.equal(f.DB.sqlite.prepare('SELECT disclosure_ciphertext FROM payment_intents WHERE id=?').get(intent.id).disclosure_ciphertext, null);
});

test('a finalized transaction cannot be claimed by two deals', async (t) => {
  const f = await fixture(t);
  f.setVerifier(async (input) => verified(input));
  const one = await f.readyDeal();
  const firstIntent = await f.intent(one);
  const proof = await disclosure(f.brand);
  assert.equal((await f.api(`/api/payment-intents/${firstIntent.id}/submit`, { method: 'POST', body: proof })).body.intent.status, 'verified');
  const two = await f.readyDeal();
  const secondIntent = await f.intent(two);
  const duplicate = await f.api(`/api/payment-intents/${secondIntent.id}/submit`, { method: 'POST', body: proof });
  assert.equal(duplicate.body.intent.status, 'failed');
  assert.equal((await f.api('/api/receipts')).body.receipts.length, 1);
  assert.notEqual((await f.api(`/api/deals/${two.id}`)).body.deal.status, 'paid');
});

test('RPC proxy rejects arbitrary destinations and unapproved methods before network access', async (t) => {
  const f = await fixture(t);
  for (const path of ['https://attacker.test/', '//attacker.test/', '/v1/spr/../../../admin', '/v1/spr/prove/key?api-key=attacker']) {
    const result = await f.api(`/api/rpc?path=${encodeURIComponent(path)}`, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] } });
    assert.equal(result.status, 400, path);
  }
  const unsupported = await f.api('/api/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [] } });
  assert.equal(unsupported.status, 400);
});

test('signed payment validation rejects altered bytes, wrong signatures, and another payer', async (t) => {
  const f = await fixture(t);
  const proof = await disclosure(f.brand);
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(proof.signedTransaction, 'base64')).messageBytes);
  assert.equal(message.version, 1);
  assert.equal(message.instructions, undefined);
  assert.equal(message.instructionHeaders.length, 1);
  assert.equal(await validateSignedPayment(proof.signedTransaction, proof.txSignature, f.brand.wallet), proof.signedTransaction);
  await assert.rejects(validateSignedPayment(proof.signedTransaction, proof.txSignature, f.creator.wallet));
  await assert.rejects(validateSignedPayment(proof.signedTransaction, encodeBase58(crypto.getRandomValues(new Uint8Array(64))), f.brand.wallet));
  const altered = Buffer.from(proof.signedTransaction, 'base64');
  altered[altered.length - 1] ^= 1;
  await assert.rejects(validateSignedPayment(altered.toString('base64'), proof.txSignature, f.brand.wallet));
});

test('a signed payment is durably stored before relay, and recovery resends identical bytes only', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  const proof = await disclosure(f.brand);
  const relayed = [];
  f.setBroadcaster(async (payload) => {
    const stored = f.DB.sqlite.prepare('SELECT * FROM payment_intents WHERE id=?').get(intent.id);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.tx_signature, proof.txSignature);
    assert(stored.disclosure_ciphertext);
    assert(!stored.disclosure_ciphertext.includes(proof.transactionViewingKey));
    assert(!stored.disclosure_ciphertext.includes(proof.signedTransaction));
    relayed.push(payload);
  });
  const submit = await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof });
  assert.equal(submit.status, 202);
  assert.equal(relayed.length, 1);
  // A refresh has no browser-held disclosure. The server still has the encrypted checkpoint.
  await f.api(`/api/payment-intents/${intent.id}`);
  // The normal post-broadcast callback can also omit the already-persisted signed wire.
  await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: { txSignature: proof.txSignature } });
  assert.equal(relayed.length, 3);
  assert(relayed.every((item) => item.signedTransaction === proof.signedTransaction && item.txSignature === proof.txSignature));
  assert.equal((await f.api('/api/receipts')).body.receipts.length, 0);
});

test('the bounded RPC proxy preserves prover jobId and sync headers and redacts upstream credentials', async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ error: { message: `test ${f.env.HELIUS_API_KEY}` } }), { status: 409, headers: { 'Content-Type': 'application/json', 'Spr-Tee': 'test-frame' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const poll = await f.api(`/api/rpc?path=${encodeURIComponent('/v1/spr/prove/circuit0/status?jobId=job%2B123')}`);
  assert.equal(poll.status, 409);
  assert.equal(calls[0].url.hostname, 'devnet.helius-rpc.com');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].url.searchParams.get('jobId'), 'job+123');
  assert.equal(calls[0].url.searchParams.get('api-key'), f.env.HELIUS_API_KEY);
  assert.equal(JSON.stringify(poll.body).includes(f.env.HELIUS_API_KEY), false);
  await f.api(`/api/rpc?path=${encodeURIComponent('/v1/spr/prove/circuit0')}`, { method: 'POST', body: { test: true }, headers: { 'X-Sync': 'true', 'X-Async': 'true', 'Spr-Tee-Enc': 'cipher', 'Spr-Tee': 'tee', 'Spr-Tee-Ciphertext': 'payload' } });
  assert.equal(calls[1].options.headers.get('X-Sync'), 'true');
  assert.equal(calls[1].options.headers.get('X-Async'), 'true');
  assert.equal(calls[1].options.headers.get('Spr-Tee-Enc'), 'cipher');
  assert.equal(calls[1].options.headers.get('Spr-Tee-Ciphertext'), 'payload');
  const huge = await f.api('/api/wallet/challenge', { method: 'POST', body: { wallet: f.brand.wallet, padding: 'a'.repeat(40000) } });
  assert.equal(huge.status, 413);
});

test('the RPC proxy rejects redirects without exposing or following their location', async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 307, headers: { Location: `https://unexpected.invalid/?api-key=${f.env.HELIUS_API_KEY}` } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await f.api('/api/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] } });
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'RPC_REDIRECT_REJECTED');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result.body).includes(f.env.HELIUS_API_KEY), false);
});

function absentTransactionRpc(method, params) {
  if (method === 'getGenesisHash') return DEVNET_GENESIS_HASH;
  if (method === 'getSlot') { assert.equal(params[0].commitment, 'finalized'); return 100; }
  if (method === 'isBlockhashValid') {
    assert.equal(params[1].minContextSlot, 100);
    return { context: { slot: params[1].commitment === 'finalized' ? 100 : 102 }, value: false };
  }
  if (method === 'getSignatureStatuses') { assert.equal(params[1].searchTransactionHistory, true); return { context: { slot: 104 }, value: [null] }; }
  if (method === 'getTransaction') { assert.equal(params[1].commitment, 'finalized'); assert.equal(params[1].maxSupportedTransactionVersion, 1); return null; }
  throw new Error(`Unexpected expiry RPC: ${method}`);
}

test('expiry requires an old checkpoint, invalid confirmed and finalized hashes, and consistent chain absence', async (t) => {
  const proof = await disclosure(await actor('expiry-payer'));
  const env = { RINGS_NETWORK: 'devnet', HELIUS_API_KEY: 'test-provider-key' };
  const parameters = { network: 'devnet', txSignature: proof.txSignature, payload: { ...proof, checkpointAt: new Date(Date.now() - 600000).toISOString() } };
  assert.equal(await checkPaymentExpiry(parameters, env, { expiryRpc: absentTransactionRpc }), true);
  const cases = [
    ['recent checkpoint', { payload: { ...parameters.payload, checkpointAt: new Date().toISOString() } }, () => assert.fail('Recent payments must not run expiry lookups')],
    ['missing checkpoint', { payload: { ...parameters.payload, checkpointAt: undefined } }, () => assert.fail('Legacy records cannot prove checkpoint age')],
    ['future checkpoint', { payload: { ...parameters.payload, checkpointAt: new Date(Date.now() + 600000).toISOString() } }, () => assert.fail('Future timestamps must not expire')],
    ['wrong signature', { txSignature: encodeBase58(crypto.getRandomValues(new Uint8Array(64))) }, () => assert.fail('Wire signature mismatch must not run lookups')],
    ['valid finalized hash', {}, (method, params) => method === 'isBlockhashValid' ? { context: { slot: 100 }, value: true } : absentTransactionRpc(method, params)],
    ['confirmed hash remains valid during finality stall', {}, (method, params) => method === 'isBlockhashValid' && params[1].commitment === 'confirmed' ? { context: { slot: 102 }, value: true } : absentTransactionRpc(method, params)],
    ['processed signature', {}, (method, params) => method === 'getSignatureStatuses' ? { context: { slot: 104 }, value: [{ confirmationStatus: 'processed', err: null }] } : absentTransactionRpc(method, params)],
    ['confirmed signature', {}, (method, params) => method === 'getSignatureStatuses' ? { context: { slot: 104 }, value: [{ confirmationStatus: 'confirmed', err: null }] } : absentTransactionRpc(method, params)],
    ['failed signature requires verifier classification', {}, (method, params) => method === 'getSignatureStatuses' ? { context: { slot: 104 }, value: [{ confirmationStatus: 'finalized', err: { InstructionError: [0, 'InvalidArgument'] } }] } : absentTransactionRpc(method, params)],
    ['finalized transaction exists', {}, (method, params) => method === 'getTransaction' ? { slot: 99 } : absentTransactionRpc(method, params)],
    ['stale signature context', {}, (method, params) => method === 'getSignatureStatuses' ? { context: { slot: 99 }, value: [null] } : absentTransactionRpc(method, params)],
    ['missing signature result', {}, (method, params) => method === 'getSignatureStatuses' ? { context: { slot: 104 }, value: [] } : absentTransactionRpc(method, params)],
    ['wrong chain', {}, (method, params) => method === 'getGenesisHash' ? 'wrong-chain' : absentTransactionRpc(method, params)],
    ['provider error', {}, () => { throw new Error('RPC unavailable'); }],
  ];
  for (const [name, override, expiryRpc] of cases) await t.test(name, async () => {
    assert.equal(await checkPaymentExpiry({ ...parameters, ...override }, env, { expiryRpc }), false);
  });
});

test('expired absent payments require review, retaining their immutable signature, encrypted checkpoint, and intent lock', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  const proof = await disclosure(f.brand);
  await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof });
  const original = f.DB.sqlite.prepare('SELECT disclosure_ciphertext FROM payment_intents WHERE id=?').get(intent.id).disclosure_ciphertext;
  // A same-signature retry must never overwrite the first durable disclosure or wire.
  await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: { ...proof, signedTransaction: 'invalid', transactionViewingKey: 'invalid' } });
  assert.equal(f.DB.sqlite.prepare('SELECT disclosure_ciphertext FROM payment_intents WHERE id=?').get(intent.id).disclosure_ciphertext, original);
  const [iv, cipher] = original.split('.').map((part) => Buffer.from(part, 'base64'));
  const key = await crypto.subtle.importKey('raw', Buffer.from(f.env.RECEIPT_ENCRYPTION_KEY, 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const additionalData = new TextEncoder().encode(intent.id);
  const payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, cipher)));
  assert(Number.isFinite(Date.parse(payload.checkpointAt)));
  payload.checkpointAt = new Date(Date.now() - 600000).toISOString();
  const newIv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv, additionalData }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const saved = `${b64(newIv)}.${b64(encrypted)}`;
  f.DB.sqlite.prepare('UPDATE payment_intents SET disclosure_ciphertext=? WHERE id=?').run(saved, intent.id);
  f.setExpiryRpc(absentTransactionRpc);
  const result = await f.api(`/api/payment-intents/${intent.id}`);
  assert.equal(result.body.intent.status, 'failed');
  assert.match(result.body.intent.reason, /Needs review/);
  assert.match(result.body.intent.reason, /cannot send a replacement payment/);
  assert.equal(result.body.intent.txSignature, proof.txSignature);
  assert.equal(f.DB.sqlite.prepare('SELECT disclosure_ciphertext FROM payment_intents WHERE id=?').get(intent.id).disclosure_ciphertext, saved);
  assert.equal((await f.api(`/api/deals/${deal.id}`)).body.deal.status, 'payment_pending');
  const retry = await f.intent(deal);
  assert.equal(retry.id, intent.id);
  assert.equal(retry.status, 'failed');
  assert.equal((await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: await disclosure(f.brand) })).status, 409);
  assert.equal((await f.api('/api/receipts')).body.receipts.length, 0);
});

test('cross-network asset configuration rejects new payments and cannot relay an existing checkpoint', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  const proof = await disclosure(f.brand);
  await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof });
  f.env.RINGS_NETWORK = 'mainnet-beta';
  let relays = 0;
  f.setBroadcaster(async () => { relays++; });
  const config = await f.api('/api/config');
  assert.equal(config.status, 503);
  assert.equal(config.body.error.code, 'INVALID_ASSET_CONFIGURATION');
  assert.equal((await f.api(`/api/deals/${deal.id}/payment-intents`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': crypto.randomUUID() } })).status, 503);
  assert.equal((await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof })).status, 503);
  assert.equal((await f.api(`/api/payment-intents/${intent.id}`)).body.intent.status, 'pending');
  assert.equal(relays, 0);
});

test('mainnet uses canonical USDC and a conservative configurable exact payment cap', async (t) => {
  const chain = getNetworkConfig('mainnet-beta');
  const f = await fixture(t, { RINGS_NETWORK: chain.network, RINGS_USDC_MINT: chain.usdcMint });
  const config = (await f.api('/api/config')).body;
  assert.equal(config.network, 'mainnet-beta');
  assert.equal(config.paymentLimitUsdc, '100');
  assert.equal(config.paymentsEnabled, true);
  const above = await f.readyDeal({ amount: '100.000001' });
  const refused = await f.api(`/api/deals/${above.id}/payment-intents`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(refused.body.error.code, 'PAYMENT_LIMIT_EXCEEDED');
  const small = await f.readyDeal({ amount: '100' });
  const intent = await f.intent(small);
  assert.equal(intent.network, chain.network);
  assert.equal(intent.mint, chain.usdcMint);
  f.env.PAYMENT_LIMIT_USDC = '99.999999';
  const proof = await disclosure(f.brand);
  assert.equal((await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof })).body.error.code, 'PAYMENT_LIMIT_EXCEEDED');
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM payment_intents WHERE id=?').get(intent.id).status, 'created');
  f.env.PAYMENT_LIMIT_USDC = '100';
  f.setVerifier(async (input) => verified(input));
  const result = await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: proof });
  assert.equal(result.body.receipt.network, 'mainnet-beta');
  assert.equal(result.body.receipt.mint, chain.usdcMint);
});

test('payment pause blocks new checkpoints but preserves existing settlement and wallet RPC access', async (t) => {
  const f = await fixture(t);
  const active = await f.readyDeal();
  const activeIntent = await f.intent(active);
  const proof = await disclosure(f.brand);
  await f.api(`/api/payment-intents/${activeIntent.id}/submit`, { method: 'POST', body: proof });
  const waiting = await f.readyDeal();
  const waitingIntent = await f.intent(waiting);
  f.env.PAYMENTS_PAUSED = 'true';
  const config = (await f.api('/api/config')).body;
  assert.equal(config.paymentsEnabled, false);
  assert.equal(config.paymentsPaused, true);
  assert.equal(config.walletOperationsEnabled, true);
  assert.equal(config.rpcEnabled, true);
  assert.equal((await f.api(`/api/payment-intents/${waitingIntent.id}/submit`, { method: 'POST', body: await disclosure(f.brand) })).body.error.code, 'PAYMENTS_PAUSED');
  const newDeal = await f.readyDeal();
  assert.equal((await f.api(`/api/deals/${newDeal.id}/payment-intents`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': crypto.randomUUID() } })).body.error.code, 'PAYMENTS_PAUSED');
  f.setVerifier(async (input) => verified(input));
  assert.equal((await f.api(`/api/payment-intents/${activeIntent.id}/submit`, { method: 'POST', body: { txSignature: proof.txSignature } })).body.intent.status, 'verified');
});

test('cron requires server bearer authentication and a durable lease, and reconciles while payments are paused', async (t) => {
  const f = await fixture(t, { CRON_SECRET: 's'.repeat(64) });
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: await disclosure(f.brand) });
  f.env.PAYMENTS_PAUSED = 'true';
  const request = (authorization, method = 'GET') => new Request(`${ORIGIN}/api/cron/reconcile`, { method, headers: authorization ? { Authorization: authorization } : {} });
  let verifiedCalls = 0;
  const dependencies = { broadcastPayment: async () => {}, verifyPayment: async (input) => { verifiedCalls++; return verified(input); } };
  assert.equal((await handleCronRequest(request(), f.env, dependencies)).status, 401);
  assert.equal((await handleCronRequest(request('Bearer wrong'), f.env, dependencies)).status, 401);
  assert.equal((await handleCronRequest(request(`Bearer ${f.env.CRON_SECRET}`, 'POST'), f.env, dependencies)).status, 405);
  assert.equal(verifiedCalls, 0);
  f.DB.sqlite.prepare('INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,?,?)').run('reconciliation-lease:devnet', 12, Date.now() + 150000);
  const skipped = await handleCronRequest(request(`Bearer ${f.env.CRON_SECRET}`), f.env, dependencies);
  assert.equal((await skipped.json()).skipped, 'already_running');
  assert.equal(verifiedCalls, 0);
  f.DB.sqlite.prepare('DELETE FROM rate_limits WHERE bucket=?').run('reconciliation-lease:devnet');
  const result = await handleCronRequest(request(`Bearer ${f.env.CRON_SECRET}`), f.env, dependencies);
  assert.deepEqual(await result.json(), { checked: 1, verified: 1, failed: 0, pending: 0, errors: 0 });
  assert.equal((await f.api(`/api/deals/${deal.id}`)).body.deal.status, 'paid');
  assert.equal(f.DB.sqlite.prepare('SELECT * FROM rate_limits WHERE bucket=?').get('reconciliation-lease:devnet'), undefined);
});

test('scheduled reconciliation never selects a pending payment from another cluster', async (t) => {
  const f = await fixture(t);
  const deal = await f.readyDeal();
  const intent = await f.intent(deal);
  await f.api(`/api/payment-intents/${intent.id}/submit`, { method: 'POST', body: await disclosure(f.brand) });
  f.env.RINGS_NETWORK = 'mainnet-beta';
  f.env.RINGS_USDC_MINT = getNetworkConfig('mainnet-beta').usdcMint;
  const result = await reconcilePendingPayments(f.env, { verifyPayment: async () => assert.fail('Cross-cluster verifier must never run'), broadcastPayment: async () => assert.fail('Cross-cluster relay must never run') });
  assert.equal(result.checked, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM payment_intents WHERE id=?').get(intent.id).status, 'pending');
});
