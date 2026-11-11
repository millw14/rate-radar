/** Same-origin Sites API. The hosting dispatcher, not browser input, supplies identity. */
import { getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr/interface';
import { getNetworkConfig } from './rings-networks.mjs';
const IDENTITY_HEADER = 'oai-authenticated-user-id';
const CHALLENGE_TTL = 5 * 60 * 1000;
const PAYMENT_EXPIRY_GRACE = 5 * 60 * 1000;
const PAYMENT_REVIEW_REASON = 'Needs review: the signed transaction is no longer valid and no finalized payment was located. This agreement cannot send a replacement payment. Review the transaction and confirm the outcome with your counterparty before creating a new agreement.';
const MAX_BODY = 32 * 1024;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const RPC_METHODS = new Set(['getAccountInfo', 'getProgramAccounts', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash', 'getSignatureStatuses', 'getTransaction', 'getSlot', 'getBlockHeight', 'isBlockhashValid', 'sendTransaction', 'getGenesisHash', 'simulateTransaction', 'getMinimumBalanceForRentExemption', 'getTokenAccountBalance']);
const INDEXER_METHODS = new Set(['getEncryptedUtxosByTags', 'getShieldedTransactionsByTags', 'getShieldedTransactionsByNullifiers', 'getShieldedTransactionsBySignature', 'getUserRecords', 'getMerkleProofs', 'getNonInclusionProofs']);

export const DATABASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallet_links (identity_id TEXT PRIMARY KEY, wallet TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, wallet TEXT NOT NULL, purpose TEXT NOT NULL, deal_id TEXT, version INTEGER, terms_hash TEXT, message TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, owner_identity TEXT NOT NULL, brand_wallet TEXT NOT NULL, creator_wallet TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS deals_brand_idx ON deals(brand_wallet);
CREATE INDEX IF NOT EXISTS deals_creator_idx ON deals(creator_wallet);
CREATE TABLE IF NOT EXISTS deal_approvals (deal_id TEXT NOT NULL REFERENCES deals(id), version INTEGER NOT NULL, wallet TEXT NOT NULL, terms_hash TEXT NOT NULL, signature TEXT NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY(deal_id, version, wallet));
CREATE TABLE IF NOT EXISTS payment_intents (id TEXT PRIMARY KEY, deal_id TEXT NOT NULL UNIQUE REFERENCES deals(id), identity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, snapshot_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created', tx_signature TEXT, event_index INTEGER, output_index INTEGER, disclosure_ciphertext TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(identity_id, idempotency_key));
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, deal_id TEXT NOT NULL UNIQUE REFERENCES deals(id), intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id), network TEXT NOT NULL, tx_signature TEXT NOT NULL, record_json TEXT NOT NULL, verified_at TEXT NOT NULL, UNIQUE(network, tx_signature));
CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
const first = (db, sql, ...values) => query(db, sql, ...values).first();
const run = (db, sql, ...values) => query(db, sql, ...values).run();
const all = async (db, sql, ...values) => (await query(db, sql, ...values).all()).results ?? [];
const changed = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });

export function decodeBase58(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) throw new Error('Invalid base58');
  let integer = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58');
    integer = integer * 58n + BigInt(digit);
  }
  const bytes = [];
  while (integer > 0n) { bytes.push(Number(integer & 255n)); integer >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}
export function encodeBase58(bytes) {
  let integer = 0n;
  for (const byte of bytes) integer = integer * 256n + BigInt(byte);
  let value = '';
  while (integer > 0n) { value = BASE58[Number(integer % 58n)] + value; integer /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; value = '1' + value; }
  return value;
}
const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
function unbase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid base64');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function walletAddress(value) {
  try { if (decodeBase58(value).length === 32) return value; } catch { /* Invalid public key. */ }
  fail(400, 'INVALID_WALLET', 'Enter a valid Solana wallet address.');
}
function transactionSignature(value) {
  try { if (decodeBase58(value).length === 64) return value; } catch { /* Invalid signature. */ }
  fail(400, 'INVALID_SIGNATURE', 'A Solana transaction signature is required.');
}
export async function verifyWalletMessage(wallet, message, signature) {
  try {
    const bytes = unbase64(signature);
    if (bytes.length !== 64) return false;
    const publicKey = await crypto.subtle.importKey('raw', decodeBase58(wallet), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', publicKey, bytes, new TextEncoder().encode(message));
  } catch { return false; }
}
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function parseAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(text)) fail(400, 'INVALID_AMOUNT', 'Enter a USDC amount with at most six decimal places.');
  const [whole, decimal = ''] = text.split('.');
  const atomic = BigInt(whole) * 1000000n + BigInt(decimal.padEnd(6, '0'));
  if (atomic <= 0n || atomic > 10000000000000n) fail(400, 'INVALID_AMOUNT', 'The amount must be greater than zero and at most 10,000,000 USDC.');
  return atomic.toString();
}
export function displayAmount(atomic) {
  const amount = BigInt(atomic);
  const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / 1000000n}${fraction ? '.' + fraction : ''}`;
}
function boundedText(value, name, max, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(400, 'INVALID_TERMS', `${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
function networkConfig(env) {
  let chain;
  try { chain = getNetworkConfig(env.RINGS_NETWORK || 'devnet'); }
  catch { fail(503, 'INVALID_NETWORK_CONFIGURATION', 'The payment network has not been configured correctly.'); }
  let mint = null;
  if (env.RINGS_USDC_MINT) {
    try { mint = walletAddress(env.RINGS_USDC_MINT); } catch { fail(503, 'INVALID_ASSET_CONFIGURATION', 'The payment asset has not been configured correctly.'); }
    if (mint !== chain.usdcMint) fail(503, 'INVALID_ASSET_CONFIGURATION', 'The USDC mint does not match the configured payment network.');
  }
  return { network: chain.network, mint, symbol: 'USDC', decimals: 6 };
}
function missingPayments(env) {
  return ['HELIUS_API_KEY', 'RINGS_USDC_MINT', 'RECEIPT_ENCRYPTION_KEY'].filter((key) => !env[key]);
}
function paymentControls(env) {
  if (env.PAYMENTS_PAUSED && !['true', 'false'].includes(env.PAYMENTS_PAUSED)) fail(503, 'INVALID_PAYMENT_CONTROLS', 'The payment pause setting is invalid.');
  const limit = env.PAYMENT_LIMIT_USDC || ((env.RINGS_NETWORK || 'devnet') === 'mainnet-beta' ? '100' : '10000000');
  let atomic;
  try { atomic = parseAmount(limit); } catch { fail(503, 'INVALID_PAYMENT_CONTROLS', 'The payment limit must be a positive USDC amount.'); }
  return { paymentsPaused: env.PAYMENTS_PAUSED === 'true', paymentLimitUsdc: displayAmount(atomic), paymentLimitAtomic: atomic };
}
function requireNewPayment(env, amount) {
  const controls = paymentControls(env);
  if (controls.paymentsPaused) fail(503, 'PAYMENTS_PAUSED', 'New payments are paused. Existing payments are still being checked.');
  if (BigInt(amount) > BigInt(controls.paymentLimitAtomic)) fail(400, 'PAYMENT_LIMIT_EXCEEDED', `This payment exceeds the workspace limit of ${controls.paymentLimitUsdc} USDC.`);
}
function normalizeTerms(body, env, previous) {
  const chain = previous ? { network: previous.network, mint: previous.mint || networkConfig(env).mint } : networkConfig(env);
  const deadline = boundedText(body.deadline, 'Due date', 10);
  const date = new Date(`${deadline}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== deadline) fail(400, 'INVALID_DATE', 'Choose a valid calendar date.');
  const brandWallet = walletAddress(body.brandWallet);
  const creatorWallet = walletAddress(body.creatorWallet);
  if (brandWallet === creatorWallet) fail(400, 'SAME_PARTY', 'A deal requires two distinct wallets.');
  return {
    schemaVersion: 1,
    title: boundedText(body.title, 'Project title', 120),
    brandWallet, creatorWallet,
    amountAtomic: parseAmount(body.amount),
    mint: chain.mint, network: chain.network,
    category: boundedText(body.category, 'Deliverable', 200),
    usage: boundedText(body.usage, 'Usage rights', 500),
    deadline,
    notes: boundedText(body.notes, 'Notes', 2000, true),
  };
}
async function readLimitedBody(message, limit, response = false) {
  const reject = () => fail(response ? 502 : 413, response ? 'RPC_RESPONSE_TOO_LARGE' : 'BODY_TOO_LARGE', response ? 'The Rings response is too large. Narrow the request.' : 'The request is too large.');
  if (Number(message.headers.get('content-length') || 0) > limit) reject();
  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); reject(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function bodyJson(request, limit = MAX_BODY) {
  if (!request.headers.get('content-type')?.includes('application/json')) fail(415, 'CONTENT_TYPE', 'Send an application/json request.');
  const text = new TextDecoder().decode(await readLimitedBody(request, limit));
  let body;
  try { body = JSON.parse(text); } catch { fail(400, 'INVALID_JSON', 'The request is not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'Send a JSON object.');
  return body;
}
function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'ORIGIN_REJECTED', 'This action must come from this workspace.');
}
async function limited(env, identity, action, maximum, milliseconds = 60000) {
  const window = Math.floor(Date.now() / milliseconds);
  const bucket = `${action}:${identity}:${window}`;
  const row = await query(env.DB, 'INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count', bucket, (window + 1) * milliseconds).first();
  if (row.count > maximum) fail(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
}
async function linkedWallet(env, identity) {
  return identity && env.DB ? (await first(env.DB, 'SELECT wallet FROM wallet_links WHERE identity_id=?', identity))?.wallet ?? null : null;
}
async function requiredWallet(env, identity) {
  const wallet = await linkedWallet(env, identity);
  if (!wallet) fail(403, 'WALLET_REQUIRED', 'Link your wallet before using the deal desk.');
  return wallet;
}
async function authorizedDeal(env, id, wallet) {
  const deal = await first(env.DB, 'SELECT * FROM deals WHERE id=? AND (brand_wallet=? OR creator_wallet=?)', id, wallet, wallet);
  if (!deal) fail(404, 'DEAL_NOT_FOUND', 'This deal is unavailable.');
  return deal;
}
function intentView(row) {
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot_json);
  return { ...snapshot, status: row.status, txSignature: row.tx_signature, eventIndex: row.event_index, outputIndex: row.output_index, reason: row.reason, amount: displayAmount(snapshot.amountAtomic), createdAt: row.created_at, updatedAt: row.updated_at };
}
async function dealView(env, row, wallet) {
  const terms = JSON.parse(row.terms_json);
  const approvals = await all(env.DB, 'SELECT wallet,approved_at AS approvedAt FROM deal_approvals WHERE deal_id=? AND version=?', row.id, row.version);
  const payment = await first(env.DB, 'SELECT * FROM payment_intents WHERE deal_id=?', row.id);
  return { ...terms, id: row.id, amount: displayAmount(terms.amountAtomic), version: row.version, termsHash: row.terms_hash, status: row.status, approvals, role: wallet === row.brand_wallet ? 'brand' : 'creator', createdAt: row.created_at, updatedAt: row.updated_at, paymentIntentId: payment?.id ?? null, paymentStatus: payment?.status ?? null, paymentIntent: intentView(payment) };
}
async function makeChallenge(env, identity, wallet, purpose, origin, deal = null) {
  const id = uid();
  const expires = Date.now() + CHALLENGE_TTL;
  const issued = now();
  let message = `${new URL(origin).host} requests a wallet signature.\n\nAction: ${purpose === 'wallet' ? 'Link this wallet to your signed-in Rate Radar account' : 'Approve these Rate Radar deal terms'}\nWallet: ${wallet}\nURI: ${origin}\nRequest ID: ${id}\nIssued at: ${issued}\nExpires at: ${new Date(expires).toISOString()}`;
  if (deal) message += `\nDeal ID: ${deal.id}\nVersion: ${deal.version}\nSHA-256 terms hash: ${deal.terms_hash}\nTerms: ${deal.terms_json}`;
  message += '\n\nThis message does not authorize a transfer of funds.';
  await run(env.DB, 'INSERT INTO challenges(id,identity_id,wallet,purpose,deal_id,version,terms_hash,message,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, identity, wallet, purpose, deal?.id ?? null, deal?.version ?? null, deal?.terms_hash ?? null, message, expires, Date.now());
  return { challengeId: id, message, expiresAt: new Date(expires).toISOString() };
}
async function validateChallenge(env, identity, body, purpose, deal = null) {
  const challenge = await first(env.DB, 'SELECT * FROM challenges WHERE id=? AND identity_id=? AND purpose=?', body.challengeId ?? '', identity, purpose);
  if (!challenge || challenge.consumed_at || challenge.expires_at <= Date.now()) fail(400, 'INVALID_CHALLENGE', 'This signing request has expired or was already used. Request another.');
  if (deal && (challenge.deal_id !== deal.id || challenge.version !== deal.version || challenge.terms_hash !== deal.terms_hash)) fail(409, 'TERMS_CHANGED', 'The deal terms changed. Review the latest version before signing.');
  if (!(await verifyWalletMessage(challenge.wallet, challenge.message, body.signature))) fail(401, 'INVALID_WALLET_SIGNATURE', 'The wallet signature could not be verified.');
  const consumed = await run(env.DB, 'UPDATE challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?', Date.now(), challenge.id, Date.now());
  if (changed(consumed) !== 1) fail(409, 'CHALLENGE_USED', 'This signing request was already used.');
  return challenge;
}
async function encryptionKey(env) {
  try {
    const bytes = unbase64(env.RECEIPT_ENCRYPTION_KEY);
    if (bytes.length !== 32) throw new Error('Wrong key length');
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { fail(503, 'ENCRYPTION_NOT_CONFIGURED', 'Secure payment reconciliation is not configured.'); }
}
async function encryptDisclosure(env, value, intentId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(intentId) }, await encryptionKey(env), new TextEncoder().encode(value));
  return `${base64(iv)}.${base64(new Uint8Array(cipher))}`;
}
async function decryptDisclosure(env, value, intentId) {
  const [iv, cipher] = value.split('.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: new TextEncoder().encode(intentId) }, await encryptionKey(env), unbase64(cipher));
  return new TextDecoder().decode(plaintext);
}
async function paymentVerification(parameters, env, dependencies) {
  const verify = dependencies?.verifyPayment ?? (await import('./rings-verifier.mjs')).verifyRingsPayment;
  return verify(parameters, env);
}
export async function validateSignedPayment(signedTransaction, signature, payerWallet) {
  try {
    const wire = unbase64(signedTransaction);
    if (wire.length < 100 || wire.length > 8192) throw new Error('Invalid transaction size');
    const decoded = getTransactionDecoder().decode(wire);
    const canonical = getTransactionEncoder().encode(decoded);
    if (canonical.length !== wire.length || canonical.some((byte, index) => byte !== wire[index])) throw new Error('Noncanonical transaction');
    if (getSignatureFromTransaction(decoded) !== signature || Object.keys(decoded.signatures)[0] !== payerWallet) throw new Error('Wrong payer or signature');
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    if (compiled.staticAccounts[0] !== payerWallet || compiled.addressTableLookups?.length) throw new Error('Unsupported payment accounts');
    // Kit exposes version 1 instruction headers separately from their payloads;
    // the SDK's real payment builder emits this shape, not the legacy/v0 array.
    const programs = compiled.version === 1
      ? compiled.instructionHeaders.map((instruction) => compiled.staticAccounts[instruction.programAccountIndex])
      : compiled.version === 0
        ? compiled.instructions.map((instruction) => compiled.staticAccounts[instruction.programAddressIndex])
        : [];
    if (programs.filter((program) => program === SHIELDED_POOL_PROGRAM_ID).length !== 1 || programs.some((program) => ![SHIELDED_POOL_PROGRAM_ID, 'ComputeBudget111111111111111111111111111111'].includes(program))) throw new Error('Unsupported payment instructions');
    for (const [wallet, bytes] of Object.entries(decoded.signatures)) {
      if (!bytes || !(await verifyWalletBytes(wallet, decoded.messageBytes, bytes))) throw new Error('Invalid transaction signature');
    }
    return signedTransaction;
  } catch { fail(400, 'INVALID_SIGNED_TRANSACTION', 'Provide the complete, unchanged Rings payment signed by the approved brand wallet.'); }
}
async function verifyWalletBytes(wallet, message, signature) {
  try {
    const key = await crypto.subtle.importKey('raw', decodeBase58(wallet), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature, message);
  } catch { return false; }
}
async function relaySavedTransaction(env, payload, signature, dependencies) {
  if (!payload.signedTransaction || !env.HELIUS_API_KEY) return;
  try {
    if (dependencies?.broadcastPayment) {
      await dependencies.broadcastPayment({ signedTransaction: payload.signedTransaction, txSignature: signature });
      return;
    }
    const target = new URL(getNetworkConfig(networkConfig(env).network).rpcUrl);
    target.searchParams.set('api-key', env.HELIUS_API_KEY);
    // A retry always resends the stored signed bytes. It can never create a new signature/payment.
    await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [payload.signedTransaction, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }] }), signal: AbortSignal.timeout(8000) });
  } catch { /* An uncertain relay result remains pending and is checked against finalized chain state. */ }
}
async function expiryRpc(env, method, params, dependencies) {
  if (dependencies?.expiryRpc) return dependencies.expiryRpc(method, params);
  const target = new URL(getNetworkConfig(networkConfig(env).network).rpcUrl);
  target.searchParams.set('api-key', env.HELIUS_API_KEY);
  const id = uid();
  const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Expiry lookup unavailable');
  const body = JSON.parse(new TextDecoder().decode(await readLimitedBody(response, 8 * 1024 * 1024, true)));
  if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) throw new Error('Invalid expiry lookup');
  return body.result;
}
// Absence is never permission to spend again. An expired checkpoint is permanently
// locked for review, with its signed wire and disclosure retained for manual recovery.
export async function checkPaymentExpiry({ payload, txSignature, network }, env, dependencies = {}) {
  const checkpoint = typeof payload?.checkpointAt === 'string' ? Date.parse(payload.checkpointAt) : NaN;
  if (network !== networkConfig(env).network || !env.HELIUS_API_KEY || !Number.isFinite(checkpoint) || Date.now() - checkpoint < PAYMENT_EXPIRY_GRACE || !payload.signedTransaction) return false;
  const slotAtLeast = (value, floor) => Number.isSafeInteger(value) && value >= floor;
  try {
    const transaction = getTransactionDecoder().decode(unbase64(payload.signedTransaction));
    if (getSignatureFromTransaction(transaction) !== txSignature) return false;
    const blockhash = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).lifetimeToken;
    if (typeof blockhash !== 'string' || decodeBase58(blockhash).length !== 32) return false;
    const rpc = (method, params = []) => expiryRpc(env, method, params, dependencies);
    const [genesis, floor] = await Promise.all([rpc('getGenesisHash'), rpc('getSlot', [{ commitment: 'finalized' }])]);
    if (genesis !== getNetworkConfig(network).genesisHash || !slotAtLeast(floor, 0)) return false;
    const finalized = await rpc('isBlockhashValid', [blockhash, { commitment: 'finalized', minContextSlot: floor }]);
    if (finalized?.value !== false || !slotAtLeast(finalized?.context?.slot, floor)) return false;
    // During a finality stall a fresh confirmed hash may be absent from the finalized
    // queue. Both commitments must report it invalid before this checkpoint can close.
    const confirmed = await rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed', minContextSlot: finalized.context.slot }]);
    if (confirmed?.value !== false || !slotAtLeast(confirmed?.context?.slot, finalized.context.slot)) return false;
    const signatures = await rpc('getSignatureStatuses', [[txSignature], { searchTransactionHistory: true }]);
    if (!slotAtLeast(signatures?.context?.slot, confirmed.context.slot) || !Array.isArray(signatures.value) || signatures.value.length !== 1 || signatures.value[0] !== null) return false;
    const found = await rpc('getTransaction', [txSignature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }]);
    return found === null;
  } catch { return false; }
}
async function reconcile(env, row, dependencies) {
  if (row.status !== 'pending' || !row.tx_signature || !row.disclosure_ciphertext) return row;
  const intent = JSON.parse(row.snapshot_json);
  let result;
  try {
    if (intent.network !== networkConfig(env).network || intent.mint !== networkConfig(env).mint) throw new Error('Payment network or asset does not match this workspace');
    const saved = await decryptDisclosure(env, row.disclosure_ciphertext, row.id);
    const payload = saved.startsWith('{') ? JSON.parse(saved) : { transactionViewingKey: saved };
    await relaySavedTransaction(env, payload, row.tx_signature, dependencies);
    result = await paymentVerification({ network: intent.network, txSignature: row.tx_signature, eventIndex: row.event_index ?? undefined, outputIndex: row.output_index ?? undefined, transactionViewingKey: payload.transactionViewingKey, intent }, env, dependencies);
    if (result.status === 'pending' && await checkPaymentExpiry({ payload, txSignature: row.tx_signature, network: intent.network }, env, dependencies)) {
      await run(env.DB, "UPDATE payment_intents SET status='failed',reason=?,updated_at=? WHERE id=? AND status='pending' AND tx_signature=?", PAYMENT_REVIEW_REASON, now(), row.id, row.tx_signature);
      return first(env.DB, 'SELECT * FROM payment_intents WHERE id=?', row.id);
    }
    if (result.status === 'pending' && (!payload.checkpointAt || Date.now() - Date.parse(payload.checkpointAt) >= PAYMENT_EXPIRY_GRACE)) result = { ...result, reason: 'Payment outcome remains uncertain. Check settlement again and review the transaction with your counterparty. Do not send a replacement payment.' };
  } catch {
    // Network, provider, or SDK failures are unknown outcomes. Never turn them into a receipt or automatically pay again.
    await run(env.DB, "UPDATE payment_intents SET reason=?,updated_at=? WHERE id=? AND status='pending'", 'Verification is temporarily unavailable. Your transaction will be checked again; do not send another payment.', now(), row.id);
    return first(env.DB, 'SELECT * FROM payment_intents WHERE id=?', row.id);
  }
  if (result.status === 'verified') {
    const evidence = result.evidence;
    if (!evidence || evidence.finalized !== true || evidence.finality !== 'finalized' || evidence.network !== intent.network || evidence.txSignature !== row.tx_signature || evidence.intentId !== row.id || evidence.termsHash !== intent.termsHash || evidence.mint !== intent.mint || evidence.amountAtomic !== intent.amountAtomic || evidence.payerWallet !== intent.payerWallet || evidence.recipientWallet !== intent.recipientWallet || !/^[0-9a-f]{64}$/.test(evidence.outputCommitment || '') || !Number.isInteger(evidence.outputIndex) || !Number.isInteger(evidence.instructionIndex)) fail(502, 'INCOMPLETE_EVIDENCE', 'The verifier did not return complete, matching payment evidence.');
    const timestamp = now();
    const receipt = { id: uid(), dealId: intent.dealId, intentId: row.id, termsHash: intent.termsHash, txSignature: row.tx_signature, network: intent.network, mint: intent.mint, amountAtomic: intent.amountAtomic, amount: displayAmount(intent.amountAtomic), payerWallet: intent.payerWallet, recipientWallet: intent.recipientWallet, verifiedAt: timestamp, evidence: result.evidence, verificationScope: 'payment_only', notice: 'This record verifies a matching finalized payment. It does not verify delivery, identity beyond wallet control, or the commercial authenticity of the deal.' };
    try {
      await env.DB.batch([
        query(env.DB, 'INSERT INTO receipts(id,deal_id,intent_id,network,tx_signature,record_json,verified_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(intent_id) DO NOTHING', receipt.id, receipt.dealId, receipt.intentId, receipt.network, receipt.txSignature, JSON.stringify(receipt), timestamp),
        query(env.DB, "UPDATE payment_intents SET status='verified',reason=NULL,disclosure_ciphertext=NULL,updated_at=? WHERE id=? AND tx_signature=?", timestamp, row.id, row.tx_signature),
        query(env.DB, "UPDATE deals SET status='paid',updated_at=? WHERE id=? AND terms_hash=?", timestamp, intent.dealId, intent.termsHash),
      ]);
    } catch {
      const existing = await first(env.DB, 'SELECT intent_id FROM receipts WHERE network=? AND tx_signature=?', intent.network, row.tx_signature);
      if (existing && existing.intent_id !== row.id) {
        await env.DB.batch([
          query(env.DB, "UPDATE payment_intents SET status='failed',reason=?,disclosure_ciphertext=NULL,updated_at=? WHERE id=? AND status='pending'", 'This transaction has already settled another deal.', now(), row.id),
          query(env.DB, "UPDATE deals SET status='ready',updated_at=? WHERE id=? AND status='payment_pending'", now(), intent.dealId),
        ]);
      } else throw new Error('Could not persist verified payment');
    }
  } else if (result.status === 'failed') {
    await env.DB.batch([
      query(env.DB, "UPDATE payment_intents SET status='failed',reason=?,disclosure_ciphertext=NULL,updated_at=? WHERE id=? AND status='pending'", String(result.reason || 'The transaction did not match the approved payment.').slice(0,500), now(), row.id),
      query(env.DB, "UPDATE deals SET status='ready',updated_at=? WHERE id=? AND status='payment_pending'", now(), intent.dealId),
    ]);
  } else {
    await run(env.DB, "UPDATE payment_intents SET reason=?,updated_at=? WHERE id=? AND status='pending'", String(result.reason || 'Waiting for finalized transaction verification.').slice(0,500), now(), row.id);
  }
  return first(env.DB, 'SELECT * FROM payment_intents WHERE id=?', row.id);
}
async function paymentResponse(env, row) {
  const receipt = await first(env.DB, 'SELECT record_json FROM receipts WHERE intent_id=?', row.id);
  return { intent: intentView(row), ...(receipt ? { receipt: JSON.parse(receipt.record_json) } : {}) };
}

export async function reconcilePendingPayments(env, dependencies) {
  if (!env.DB || missingPayments(env).length) return { checked: 0 };
  const chain = networkConfig(env);
  const limit = Number.isInteger(dependencies?.limit) ? Math.max(1, Math.min(5, dependencies.limit)) : 5;
  const rows = await all(env.DB, "SELECT * FROM payment_intents WHERE status='pending' AND json_extract(snapshot_json,'$.network')=? AND json_extract(snapshot_json,'$.mint')=? ORDER BY updated_at ASC LIMIT ?", chain.network, chain.mint, limit);
  const outcomes = { checked: rows.length, verified: 0, failed: 0, pending: 0, errors: 0 };
  for (const row of rows) {
    try { const result = await reconcile(env, row, dependencies); if (Object.hasOwn(outcomes, result.status)) outcomes[result.status]++; }
    catch { outcomes.errors++; }
  }
  await run(env.DB, 'DELETE FROM rate_limits WHERE expires_at<?', Date.now() - 86400000);
  await run(env.DB, 'DELETE FROM challenges WHERE expires_at<?', Date.now() - 86400000);
  return outcomes;
}

async function rpcProxy(request, env, identity) {
  if (!env.HELIUS_API_KEY) fail(503, 'PAYMENTS_NOT_CONFIGURED', 'The Rings connection is not configured.');
  await requiredWallet(env, identity);
  await limited(env, identity, 'rpc', 120);
  const incoming = new URL(request.url);
  const path = incoming.searchParams.get('path') || '/';
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001F]/.test(path)) fail(400, 'RPC_PATH_REJECTED', 'Unsupported Rings request.');
  const network = networkConfig(env).network;
  const host = new URL(getNetworkConfig(network).rpcUrl).hostname;
  const target = new URL(path, `https://${host}`);
  if (target.hostname !== host || [...target.searchParams.keys()].some((key) => !['nonce','job','jobId'].includes(key))) fail(400, 'RPC_PATH_REJECTED', 'Unsupported Rings request.');
  const pathname = target.pathname;
  const method = request.method;
  let body;
  const headers = new Headers();
  if (pathname === '/' || /^\/v1\/spr\/get[A-Za-z]+$/.test(pathname)) {
    if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'This RPC endpoint requires POST.');
    const rpc = await bodyJson(request, 256 * 1024);
    const indexerMethod = pathname.split('/').at(-1);
    if (rpc.jsonrpc !== '2.0' || !(pathname === '/' ? RPC_METHODS.has(rpc.method) : INDEXER_METHODS.has(rpc.method) && rpc.method === indexerMethod)) fail(400, 'RPC_METHOD_REJECTED', 'Unsupported RPC method.');
    body = JSON.stringify(rpc);
    headers.set('Content-Type', 'application/json');
  } else {
    const allowedGet = /^\/v1\/spr\/(?:attestation|proving-keys|health)$/.test(pathname) || /^\/v1\/spr\/prove\/[A-Za-z0-9_-]{1,120}\/status$/.test(pathname);
    const allowedPost = /^\/v1\/spr\/prove\/[A-Za-z0-9_-]{1,120}(?:\/indexed)?$/.test(pathname);
    if (!((method === 'GET' && allowedGet) || (method === 'POST' && allowedPost))) fail(400, 'RPC_PATH_REJECTED', 'Unsupported Rings endpoint.');
    if (method === 'POST') {
      await limited(env, identity, 'proof', 5);
      body = await readLimitedBody(request, 2 * 1024 * 1024);
      headers.set('Content-Type', request.headers.get('content-type') || 'application/octet-stream');
    }
  }
  for (const name of ['Spr-Tee', 'Spr-Tee-Enc', 'Spr-Tee-Ciphertext']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  for (const name of ['X-Sync', 'X-Async']) if (request.headers.get(name) === 'true') headers.set(name, 'true');
  target.searchParams.set('api-key', env.HELIUS_API_KEY);
  let upstream;
  try { upstream = await fetch(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(55000) }); }
  catch { fail(502, 'RPC_UNAVAILABLE', 'The Rings service is temporarily unavailable.'); }
  // Workers supports manual redirects; never forward credentials to a redirect target.
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    fail(502, 'RPC_REDIRECT_REJECTED', 'The Rings service returned an unexpected redirect.');
  }
  const bytes = await readLimitedBody(upstream, 8 * 1024 * 1024, true);
  const outputHeaders = new Headers({ 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
  if (upstream.headers.has('Spr-Tee')) outputHeaders.set('Spr-Tee', upstream.headers.get('Spr-Tee'));
  // Preserve SDK error/status semantics and authenticated TEE frames while redacting credential-bearing text.
  if (outputHeaders.get('Content-Type').includes('json')) {
    const safe = new TextDecoder().decode(bytes).replaceAll(env.HELIUS_API_KEY, '[redacted]');
    return new Response(safe, { status: upstream.status, headers: outputHeaders });
  }
  if (!upstream.ok && !upstream.headers.has('Spr-Tee')) return json({ error: { code: 'RPC_UPSTREAM_ERROR', message: 'The Rings service rejected this request.', upstreamStatus: upstream.status } }, upstream.status);
  return new Response(bytes, { status: upstream.status, headers: outputHeaders });
}

export async function handleApi(request, env, dependencies = {}) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const identity = request.headers.get(IDENTITY_HEADER);
    if (path === '/api/config' && request.method === 'GET') {
      const chain = networkConfig(env);
      const controls = paymentControls(env);
      const wallet = await linkedWallet(env, identity);
      return json({ ...chain, ...controls, authenticated: Boolean(identity), identity: identity || null, wallet, draftsEnabled: Boolean(identity && wallet && env.DB), paymentsEnabled: Boolean(identity && wallet && env.DB && !controls.paymentsPaused && !missingPayments(env).length), walletOperationsEnabled: Boolean(identity && wallet && env.DB && !missingPayments(env).length), rpcEnabled: Boolean(identity && wallet && env.HELIUS_API_KEY), missingConfiguration: [...(!env.DB ? ['DB'] : []), ...missingPayments(env)], privacyNotice: 'Payment amounts are confidential onchain; wallet addresses remain public. This service can read your deal terms and the payment you disclose for verification.' });
    }
    if (!identity) fail(401, 'SIGN_IN_REQUIRED', 'Sign in to this workspace to continue.');
    if (identity.length > 256) fail(401, 'INVALID_IDENTITY', 'The workspace identity is invalid.');
    if (!env.DB) fail(503, 'DATABASE_NOT_CONFIGURED', 'The shared deal workspace is not configured.');
    if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);
    if (path === '/api/rpc') {
      if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'ORIGIN_REJECTED', 'This action must come from this workspace.');
      return await rpcProxy(request, env, identity);
    }
    if (path === '/api/wallet/challenge' && request.method === 'POST') {
      await limited(env, identity, 'wallet_challenge', 10);
      const body = await bodyJson(request);
      const wallet = walletAddress(body.wallet);
      const existing = await linkedWallet(env, identity);
      if (existing && existing !== wallet) fail(409, 'WALLET_ALREADY_LINKED', 'This account already has a linked wallet. Wallet replacement is not available.');
      return json(await makeChallenge(env, identity, wallet, 'wallet', url.origin));
    }
    if (path === '/api/wallet/verify' && request.method === 'POST') {
      await limited(env, identity, 'wallet_verify', 20);
      const body = await bodyJson(request);
      const challenge = await validateChallenge(env, identity, body, 'wallet');
      try { await run(env.DB, 'INSERT INTO wallet_links(identity_id,wallet,linked_at) VALUES(?,?,?) ON CONFLICT(identity_id) DO NOTHING', identity, challenge.wallet, now()); }
      catch { fail(409, 'WALLET_ALREADY_LINKED', 'That wallet is already linked to another workspace account.'); }
      const wallet = await linkedWallet(env, identity);
      if (wallet !== challenge.wallet) fail(409, 'WALLET_ALREADY_LINKED', 'This account already has a different linked wallet.');
      return json({ wallet });
    }
    const wallet = await requiredWallet(env, identity);
    if (path === '/api/deals' && request.method === 'GET') {
      const rows = await all(env.DB, 'SELECT * FROM deals WHERE brand_wallet=? OR creator_wallet=? ORDER BY updated_at DESC LIMIT 100', wallet, wallet);
      return json({ deals: await Promise.all(rows.map((row) => dealView(env, row, wallet))) });
    }
    if (path === '/api/deals' && request.method === 'POST') {
      await limited(env, identity, 'create_deal', 20, 3600000);
      const terms = normalizeTerms(await bodyJson(request), env);
      if (![terms.brandWallet, terms.creatorWallet].includes(wallet)) fail(403, 'NOT_A_PARTY', 'Your linked wallet must be a party to this deal.');
      const id = uid(); const timestamp = now(); const text = JSON.stringify(terms);
      await run(env.DB, 'INSERT INTO deals(id,owner_identity,brand_wallet,creator_wallet,terms_json,terms_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, identity, terms.brandWallet, terms.creatorWallet, text, await hash(text), timestamp, timestamp);
      return json({ deal: await dealView(env, await authorizedDeal(env, id, wallet), wallet) }, 201);
    }
    if (path === '/api/receipts' && request.method === 'GET') {
      const rows = await all(env.DB, 'SELECT r.record_json FROM receipts r JOIN deals d ON d.id=r.deal_id WHERE d.brand_wallet=? OR d.creator_wallet=? ORDER BY r.verified_at DESC LIMIT 100', wallet, wallet);
      return json({ receipts: rows.map((row) => JSON.parse(row.record_json)) });
    }
    const dealMatch = path.match(/^\/api\/deals\/([a-f0-9-]{36})(?:\/(approval-challenge|approve|payment-intents))?$/);
    if (dealMatch) {
      const [, id, action] = dealMatch;
      let deal = await authorizedDeal(env, id, wallet);
      if (!action && request.method === 'GET') return json({ deal: await dealView(env, deal, wallet) });
      if (!action && request.method === 'PATCH') {
        if (deal.status !== 'draft') fail(409, 'TERMS_LOCKED', 'Approved terms cannot be edited. Create a new agreement for revised terms.');
        const body = await bodyJson(request);
        if (body.version !== deal.version) fail(409, 'VERSION_CONFLICT', 'The draft changed. Refresh before editing.');
        const old = JSON.parse(deal.terms_json);
        const terms = normalizeTerms({ ...old, amount: displayAmount(old.amountAtomic), ...body, brandWallet: old.brandWallet, creatorWallet: old.creatorWallet }, env, old);
        const text = JSON.stringify(terms);
        const result = await run(env.DB, "UPDATE deals SET terms_json=?,terms_hash=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='draft'", text, await hash(text), now(), id, deal.version);
        if (changed(result) !== 1) fail(409, 'VERSION_CONFLICT', 'The draft changed. Refresh before editing.');
        return json({ deal: await dealView(env, await authorizedDeal(env, id, wallet), wallet) });
      }
      if (!action && request.method === 'DELETE') {
        if (deal.owner_identity !== identity || deal.status !== 'draft') fail(409, 'DEAL_CANNOT_BE_DELETED', 'Only the author can delete an unsigned draft.');
        const result = await run(env.DB, "DELETE FROM deals WHERE id=? AND status='draft' AND version=?", id, deal.version);
        if (changed(result) !== 1) fail(409, 'VERSION_CONFLICT', 'The draft changed. Refresh before deleting.');
        return json({ deleted: true });
      }
      if (action === 'approval-challenge' && request.method === 'POST') {
        await bodyJson(request);
        await limited(env, identity, 'approval_challenge', 15);
        if (!['draft', 'awaiting_approval'].includes(deal.status)) fail(409, 'DEAL_ALREADY_APPROVED', 'This agreement is already approved.');
        const terms = JSON.parse(deal.terms_json);
        if (!terms.mint) {
          const configuredMint = networkConfig(env).mint;
          if (!configuredMint) fail(503, 'ASSET_NOT_CONFIGURED', 'The USDC mint must be configured before signing payment terms.');
          if (deal.status !== 'draft') fail(409, 'TERMS_LOCKED', 'Create a new agreement with the configured payment asset.');
          terms.mint = configuredMint;
          const text = JSON.stringify(terms);
          await run(env.DB, "UPDATE deals SET terms_json=?,terms_hash=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='draft'", text, await hash(text), now(), id, deal.version);
          deal = await authorizedDeal(env, id, wallet);
        }
        return json(await makeChallenge(env, identity, wallet, 'approval', url.origin, deal));
      }
      if (action === 'approve' && request.method === 'POST') {
        const body = await bodyJson(request);
        const challenge = await validateChallenge(env, identity, body, 'approval', deal);
        if (challenge.wallet !== wallet) fail(403, 'WRONG_WALLET', 'Sign with the wallet linked to this account.');
        if (!['draft', 'awaiting_approval'].includes(deal.status)) fail(409, 'TERMS_LOCKED', 'This agreement is already approved.');
        const timestamp = now();
        const results = await env.DB.batch([
          query(env.DB, "INSERT INTO deal_approvals(deal_id,version,wallet,terms_hash,signature,approved_at) SELECT id,version,?,terms_hash,?,? FROM deals WHERE id=? AND version=? AND terms_hash=? AND status IN ('draft','awaiting_approval') ON CONFLICT(deal_id,version,wallet) DO NOTHING", wallet, body.signature, timestamp, id, deal.version, deal.terms_hash),
          query(env.DB, "UPDATE deals SET status=CASE WHEN (SELECT COUNT(*) FROM deal_approvals WHERE deal_id=? AND version=?)=2 THEN 'ready' ELSE 'awaiting_approval' END,updated_at=? WHERE id=? AND version=? AND terms_hash=? AND status IN ('draft','awaiting_approval')", id, deal.version, timestamp, id, deal.version, deal.terms_hash),
        ]);
        if (!changed(results[1])) fail(409, 'TERMS_CHANGED', 'The deal changed during approval. Review the latest version.');
        return json({ deal: await dealView(env, await authorizedDeal(env, id, wallet), wallet) });
      }
      if (action === 'payment-intents' && request.method === 'POST') {
        await bodyJson(request);
        if (wallet !== deal.brand_wallet) fail(403, 'PAYER_REQUIRED', 'Only the brand wallet can pay this agreement.');
        networkConfig(env);
        const existing = await first(env.DB, 'SELECT * FROM payment_intents WHERE deal_id=?', id);
        if (existing) return json(await paymentResponse(env, existing));
        if (deal.status !== 'ready') fail(409, 'APPROVALS_REQUIRED', 'Both parties must approve the same terms before payment.');
        if (missingPayments(env).length) fail(503, 'PAYMENTS_NOT_CONFIGURED', 'The Rings connection and secure reconciliation must be configured before payment.');
        await encryptionKey(env);
        const terms = JSON.parse(deal.terms_json);
        requireNewPayment(env, terms.amountAtomic);
        const chain = networkConfig(env);
        if (terms.mint !== chain.mint || terms.network !== chain.network) fail(409, 'PAYMENT_CONFIG_CHANGED', 'The approved payment asset or network no longer matches the workspace. Create a new agreement.');
        const idempotencyKey = request.headers.get('idempotency-key');
        if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key for this payment request.');
        const reused = await first(env.DB, 'SELECT deal_id FROM payment_intents WHERE identity_id=? AND idempotency_key=?', identity, idempotencyKey);
        if (reused && reused.deal_id !== id) fail(409, 'IDEMPOTENCY_CONFLICT', 'That payment request key was already used for another deal.');
        const intentId = uid();
        const snapshot = { id: intentId, dealId: id, termsHash: deal.terms_hash, memo: `rate-radar:v1:${intentId}:${deal.terms_hash}:${uid()}`, amountAtomic: terms.amountAtomic, mint: terms.mint, network: terms.network, payerWallet: deal.brand_wallet, recipientWallet: deal.creator_wallet };
        const timestamp = now();
        try { await run(env.DB, 'INSERT INTO payment_intents(id,deal_id,identity_id,idempotency_key,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', intentId, id, identity, idempotencyKey, JSON.stringify(snapshot), timestamp, timestamp); }
        catch {
          const raced = await first(env.DB, 'SELECT * FROM payment_intents WHERE deal_id=?', id);
          if (raced) return json(await paymentResponse(env, raced));
          fail(409, 'IDEMPOTENCY_CONFLICT', 'That payment request key is already in use.');
        }
        return json(await paymentResponse(env, await first(env.DB, 'SELECT * FROM payment_intents WHERE id=?', intentId)), 201);
      }
    }
    const intentMatch = path.match(/^\/api\/payment-intents\/([a-f0-9-]{36})(?:\/(submit|reconcile))?$/);
    if (intentMatch) {
      const [, id, action] = intentMatch;
      let row = await first(env.DB, 'SELECT * FROM payment_intents WHERE id=?', id);
      if (!row) fail(404, 'INTENT_NOT_FOUND', 'This payment is unavailable.');
      const deal = await authorizedDeal(env, row.deal_id, wallet);
      if (request.method === 'POST' && action === 'submit') {
        if (wallet !== deal.brand_wallet) fail(403, 'PAYER_REQUIRED', 'Only the brand wallet can submit this payment.');
        const approvedPayment = JSON.parse(row.snapshot_json);
        if (networkConfig(env).network !== approvedPayment.network || networkConfig(env).mint !== approvedPayment.mint) fail(409, 'PAYMENT_CONFIG_CHANGED', 'This payment belongs to a different network or asset.');
        await limited(env, identity, 'payment_submit', 20);
        const body = await bodyJson(request);
        const signature = transactionSignature(body.txSignature);
        if (row.tx_signature && row.tx_signature !== signature) fail(409, 'PAYMENT_ALREADY_SUBMITTED', 'A transaction is already linked. Reconcile it before taking any further action; do not send another payment.');
        if (['verified','failed'].includes(row.status)) return json(await paymentResponse(env, row));
        if (row.status === 'pending' && row.tx_signature === signature) {
          row = await reconcile(env, row, dependencies);
          return json(await paymentResponse(env, row), row.status === 'pending' ? 202 : 200);
        }
        requireNewPayment(env, approvedPayment.amountAtomic);
        const viewingKey = boundedText(body.transactionViewingKey, 'Transaction viewing key', 256);
        try { if (unbase64(viewingKey).length !== 32) throw new Error('Invalid key length'); }
        catch { fail(400, 'INVALID_TRANSACTION_VIEWING_KEY', 'Provide the base64 transaction-only viewing key. Never submit a wallet secret or master viewing key.'); }
        for (const key of ['eventIndex', 'outputIndex']) if (body[key] != null && (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 63)) fail(400, 'INVALID_OUTPUT_INDEX', 'Payment output indices must be nonnegative integers.');
        if (body.network != null && body.network !== JSON.parse(row.snapshot_json).network) fail(400, 'WRONG_NETWORK', 'The signed payment uses a different network.');
        const signedTransaction = boundedText(body.signedTransaction, 'Signed transaction', 12000);
        await validateSignedPayment(signedTransaction, signature, deal.brand_wallet);
        const timestamp = now();
        const encrypted = await encryptDisclosure(env, JSON.stringify({ version: 2, transactionViewingKey: viewingKey, signedTransaction, checkpointAt: timestamp }), row.id);
        await env.DB.batch([
          query(env.DB, "UPDATE payment_intents SET status='pending',tx_signature=?,event_index=?,output_index=?,disclosure_ciphertext=?,reason=NULL,updated_at=? WHERE id=? AND status='created' AND tx_signature IS NULL", signature, body.eventIndex ?? null, body.outputIndex ?? null, encrypted, timestamp, id),
          query(env.DB, "UPDATE deals SET status='payment_pending',updated_at=? WHERE id=? AND status='ready'", timestamp, row.deal_id),
        ]);
        row = await first(env.DB, 'SELECT * FROM payment_intents WHERE id=?', id);
        if (row.tx_signature !== signature) fail(409, 'PAYMENT_ALREADY_SUBMITTED', 'Another transaction was submitted. Refresh this payment.');
        row = await reconcile(env, row, dependencies);
        return json(await paymentResponse(env, row), row.status === 'pending' ? 202 : 200);
      }
      if ((request.method === 'GET' && !action) || (request.method === 'POST' && action === 'reconcile')) {
        await limited(env, identity, 'payment_read', 30);
        row = await reconcile(env, row, dependencies);
        return json(await paymentResponse(env, row));
      }
    }
    fail(404, 'NOT_FOUND', 'This API endpoint is unavailable.');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: 'INTERNAL_ERROR', message: 'The workspace could not complete this request. Please try again.' } }, 500);
  }
}
