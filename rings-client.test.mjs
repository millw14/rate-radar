import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { getAddressDecoder, getTransactionDecoder, getTransactionEncoder, getSignatureFromTransaction, getBase58Decoder } from '@solana/kit';
import { createRingsWallet, createProxyFetch } from './rings-client.mjs';
import { toBase64, fromBase64 } from './rings-protocol.mjs';

const seed = new Uint8Array(32).fill(4);
const publicKey = ed25519.getPublicKey(seed);
const owner = getAddressDecoder().decode(publicKey);

function provider({ supportsV1 = true, alterMessage = false } = {}) {
  const account = { address: owner, publicKey, chains: ['solana:devnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
  const messages = [];
  return {
    name: 'Test wallet', accounts: [account], messages,
    features: {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signMessage': { async signMessage({ message }) { messages.push(new Uint8Array(message)); return [{ signedMessage: message, signature: ed25519.sign(message, seed) }]; } },
      'solana:signTransaction': {
        supportedTransactionVersions: supportsV1 ? [1] : ['legacy', 0],
        async signTransaction({ transaction }) {
          const unsigned = getTransactionDecoder().decode(transaction);
          const messageBytes = new Uint8Array(unsigned.messageBytes);
          if (alterMessage) messageBytes[messageBytes.length - 1] ^= 1;
          const signed = { ...unsigned, messageBytes, signatures: { ...unsigned.signatures, [owner]: ed25519.sign(messageBytes, seed) } };
          return [{ signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)) }];
        },
      },
    },
  };
}

test('RPC proxy preserves encrypted bytes and TEE headers and refuses other hosts', async () => {
  let observed;
  const forward = createProxyFetch('/api/rpc', async (url, init) => { observed = { url: String(url), init }; return new Response('ok'); });
  const body = new Uint8Array([1, 2, 3]);
  await forward('https://devnet.helius-rpc.com/v1/spr/prove/transfer_confidential_2_2/indexed?job=one', { method: 'POST', headers: { 'Spr-Tee': 'v1', 'Spr-Tee-Enc': 'encrypted-key' }, body });
  assert.equal(new URL(observed.url).searchParams.get('path'), '/v1/spr/prove/transfer_confidential_2_2/indexed?job=one');
  assert.equal(observed.init.body, body);
  assert.equal(observed.init.headers['Spr-Tee'], 'v1');
  assert.equal(observed.init.credentials, 'same-origin');
  await assert.rejects(() => forward('https://attacker.example/prove', { body }), /Unexpected/);
});

test('authentication signs exact text and blocks privacy derivation through the auth method', async () => {
  const p = provider();
  const wallet = createRingsWallet({ provider: p });
  const connected = await wallet.connect();
  assert.equal(connected.address, owner);
  assert.equal(connected.version1Supported, true);
  await assert.rejects(() => wallet.payIntent({}), /durable payment checkpoint/);
  const signature = await wallet.signMessage('Rate Radar login challenge');
  assert.equal(ed25519.verify(fromBase64(signature), new TextEncoder().encode('Rate Radar login challenge'), publicKey), true);
  await assert.rejects(() => wallet.signMessage('TSPP/derive/v1'), /Invalid authentication/);
  await wallet.disconnect();
  await assert.rejects(() => wallet.signMessage('challenge'), /Connect/);
});

test('version 0 wallets can authenticate but cannot initiate Rings spending', async () => {
  const wallet = createRingsWallet({ provider: provider({ supportsV1: false }) });
  assert.equal((await wallet.connect()).version1Supported, false);
  await assert.rejects(() => wallet.register(), /version 1/);
  await assert.rejects(() => wallet.deposit({ amountAtomic: '1' }), /version 1/);
  await assert.rejects(() => wallet.payIntent({}), /version 1/);
});

test('private key derivation stays local; signed registration is checked before broadcast', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let submitted;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/rpc');
    const request = JSON.parse(init.body);
    calls.push(request);
    let result;
    // Captured from the devnet RPC, independent of the app's network guard.
    if (request.method === 'getGenesisHash') result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    else if (request.method === 'getAccountInfo') result = { context: { slot: 1 }, value: null };
    else if (request.method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 100 } };
    else if (request.method === 'sendTransaction') {
      submitted = getTransactionDecoder().decode(fromBase64(request.params[0]));
      result = getSignatureFromTransaction(submitted);
    } else if (request.method === 'getSignatureStatuses') result = { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed', status: { Ok: null } }] };
    else throw new Error(`Unexpected RPC ${request.method}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  try {
    const p = provider();
    const wallet = createRingsWallet({ provider: p });
    await wallet.connect();
    assert.equal((await wallet.unlock()).registered, false);
    assert.equal(p.messages.length, 1);
    assert.equal(new TextDecoder().decode(p.messages[0]).endsWith('TSPP/derive/v1'), true);
    const signature = ed25519.sign(p.messages[0], seed);
    assert.equal(JSON.stringify(calls).includes(toBase64(signature)), false);
    assert.equal((await wallet.register()).status, 'confirmed');
    assert.ok(submitted);
    assert.equal(ed25519.verify(submitted.signatures[owner], submitted.messageBytes, publicKey), true);
    await wallet.disconnect();

    const altered = createRingsWallet({ provider: provider({ alterMessage: true }) });
    await altered.connect(); await altered.unlock();
    const before = calls.filter((entry) => entry.method === 'sendTransaction').length;
    await assert.rejects(() => altered.register(), /changed the transaction/);
    assert.equal(calls.filter((entry) => entry.method === 'sendTransaction').length, before);
  } finally { globalThis.fetch = originalFetch; }
});
