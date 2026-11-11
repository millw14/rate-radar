import test from 'node:test';
import assert from 'node:assert/strict';
import { SigningKey, ShieldedKeypair, ViewingKey, initializePoseidon, poseidon } from '@heliuslabs/spr/keypair';
import { ConfidentialTransfer, ProofInputUtxo, Utxo, AssetRegistry, encryptConfidentialTransfer } from '@heliuslabs/spr/transaction';
import { SHIELDED_POOL_PROGRAM_ID, USER_REGISTRY_PROGRAM_ID, encodeTransactInstructionData } from '@heliuslabs/spr/interface';
import { treeAddress, internalUserRecordPda, splAssetRegistryAddress, nullifierPdaAddress } from '@heliuslabs/spr/internal';
import { getBase58Decoder, getAddressEncoder } from '@solana/kit';
import { verifyRingsPayment, decodePaymentInstruction } from './rings-verifier.mjs';
import { SOL_MINT, DEVNET_USDC_MINT, DEVNET_GENESIS_HASH, paymentMemo, toBase64 } from './rings-protocol.mjs';
import { getNetworkConfig } from './rings-networks.mjs';

await initializePoseidon();
const encode58 = (bytes) => getBase58Decoder().decode(bytes);
const sender = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(32).fill(1)));
const recipient = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(32).fill(2)));
const senderAddress = sender.shieldedAddress();
const recipientAddress = recipient.shieldedAddress();
const txSignature = encode58(new Uint8Array(64).fill(5));
const intent = { id: 'intent-1', dealId: 'deal-1', termsHash: 'terms-1', memo: 'random-challenge-1', mint: SOL_MINT, amountAtomic: '50', payerWallet: senderAddress.solanaAddress(), recipientWallet: recipientAddress.solanaAddress(), network: 'devnet' };
const env = { RINGS_NETWORK: 'devnet', HELIUS_API_KEY: 'test-only-not-a-real-key' };

async function fixture({ network = 'devnet', memo = paymentMemo({ ...intent, network }), amount = 50n, falseCommitment = false, mint = SOL_MINT, wrongAssetId = false } = {}) {
  const input = new Utxo({ owner: senderAddress.signingPublicKey, asset: mint, amount: 100n, blinding: new Uint8Array(32).fill(3) });
  const transfer = new ConfidentialTransfer(senderAddress, [ProofInputUtxo.fromKeypair(input, sender)], intent.payerWallet);
  transfer.send(recipientAddress, mint, amount);
  const prepared = transfer.prepare();
  const outputIndex = prepared.senderOutputCount;
  const txKey = sender.transactionViewingKey(prepared.firstNullifier);
  const outputs = prepared.outputs.map((output, index) => index === outputIndex ? output.withMemo(memo) : output);
  const assets = new AssetRegistry();
  if (mint !== SOL_MINT) assets.insert(2n, mint);
  const encrypted = encryptConfidentialTransfer(txKey, { outputs, assets });
  const proved = prepared.finalize(encrypted);
  const external = proved.externalData;
  const wire = {
    expiryUnixTs: external.expiryUnixTs, txViewingPk: external.txViewingPublicKey.toBytes(), salt: external.salt,
    interfaceTransfers: [], outputs: external.outputs.map((output) => ({ ...output })), messages: [],
    privateTxHash: proved.privateTxHash(),
    circuit: { kind: 'confidentialSigner', inputs: proved.inputUtxos.length, outputs: proved.outputs.length, publicAssetSlots: 0 },
    // This fixture exercises receipt verification of chain-supplied events; it
    // does not pretend these zero bytes are a valid proof or submit test funds.
    proof: { a: new Uint8Array(32), b: new Uint8Array(128), c: new Uint8Array(32) },
    inputs: proved.inputUtxos.map((utxo) => ({ nullifierHash: utxo.publishedNullifier(), treeIndex: 0 })),
    treeContexts: [{ utxoTreeRootIndex: 0, nullifierTreeRootIndex: 0 }],
  };
  if (falseCommitment) wire.outputs[outputIndex].utxoHash = new Uint8Array(32).fill(9);
  const bytes = new Uint8Array([16, ...encodeTransactInstructionData(wire)]);
  const tree = treeAddress(0);
  const nullifierAccounts = await Promise.all(wire.inputs.map((input) => nullifierPdaAddress(tree, input.nullifierHash)));
  const chain = {
    slot: 1234, blockTime: 1700000000, version: 1,
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [txSignature], message: {
      accountKeys: [intent.payerWallet, tree, SHIELDED_POOL_PROGRAM_ID, SOL_MINT, ...nullifierAccounts],
      header: { numRequiredSignatures: 1 },
      instructions: [{ programIdIndex: 2, accounts: [0, 1, 2, 3, 1, ...nullifierAccounts.map((_account, index) => 4 + index), 0], data: encode58(bytes) }],
    } },
  };
  const pda = await internalUserRecordPda(intent.recipientWallet);
  const record = new Uint8Array([1, ...getAddressEncoder().encode(intent.recipientWallet), pda.bump, ...recipientAddress.nullifierPublicKey, ...recipientAddress.viewingPublicKey.toBytes(), 0]);
  const disclosure = { network, txSignature, eventIndex: 0, outputIndex, transactionViewingKey: toBase64(txKey.secretBytes()), intent: { ...intent, mint, network } };
  const assetPda = mint === SOL_MINT ? null : await splAssetRegistryAddress(mint);
  const assetRecord = new Uint8Array(48);
  assetRecord[0] = 5;
  assetRecord.set(getAddressEncoder().encode(mint), 8);
  new DataView(assetRecord.buffer).setBigUint64(40, wrongAssetId ? 3n : 2n, true);
  txKey.destroy();
  const calls = [];
  const fetchImpl = async (_url, init) => {
    assert.equal(new URL(_url).hostname, new URL(getNetworkConfig(network).rpcUrl).hostname);
    const body = JSON.parse(init.body);
    calls.push(body);
    let result;
    if (body.method === 'getGenesisHash') result = getNetworkConfig(network).genesisHash;
    else if (body.method === 'getTransaction') { assert.equal(body.params[1].commitment, 'finalized'); assert.equal(body.params[1].maxSupportedTransactionVersion, 1); result = chain; }
    else if (body.method === 'getAccountInfo' && body.params[0] === pda.address) result = { value: { owner: USER_REGISTRY_PROGRAM_ID, lamports: 1000000, data: [toBase64(record), 'base64'] } };
    else if (body.method === 'getAccountInfo' && body.params[0] === assetPda) result = { value: { owner: SHIELDED_POOL_PROGRAM_ID, lamports: 1000000, data: [toBase64(assetRecord), 'base64'] } };
    else throw new Error(`Unexpected RPC ${body.method}`);
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  return { chain, disclosure, fetchImpl, bytes, calls };
}

test('verifies exact finalized amount, mint, recipient and encrypted intent memo from chain instruction', async () => {
  const f = await fixture();
  const result = await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'verified', result.reason);
  assert.equal(result.evidence.finalized, true);
  assert.equal(result.evidence.amountAtomic, '50');
  assert.equal(result.evidence.outputIndex, 1);
  assert.match(result.evidence.outputCommitment, /^[0-9a-f]{64}$/);
});

test('rejects correct plaintext whose amount is not the actual output commitment', async () => {
  const f = await fixture({ falseCommitment: true });
  const result = await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /commitment/);
});

test('verifies devnet USDC through its onchain mint registry and rejects a different asset id', async () => {
  const good = await fixture({ mint: DEVNET_USDC_MINT });
  const verified = await verifyRingsPayment(good.disclosure, env, { fetchImpl: good.fetchImpl });
  assert.equal(verified.status, 'verified', verified.reason);
  assert.equal(verified.evidence.mint, DEVNET_USDC_MINT);
  const bad = await fixture({ mint: DEVNET_USDC_MINT, wrongAssetId: true });
  assert.equal((await verifyRingsPayment(bad.disclosure, env, { fetchImpl: bad.fetchImpl })).status, 'failed');
});

test('mainnet USDC evidence is bound to the mainnet endpoint, full genesis, and immutable intent cluster', async () => {
  const network = getNetworkConfig('mainnet-beta');
  const mainnetEnv = { ...env, RINGS_NETWORK: network.network, RINGS_USDC_MINT: network.usdcMint };
  const f = await fixture({ network: network.network, mint: network.usdcMint });
  const result = await verifyRingsPayment(f.disclosure, mainnetEnv, { fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'verified', result.reason);
  assert.equal(result.evidence.network, 'mainnet-beta');
  assert.equal(result.evidence.mint, network.usdcMint);
  const neverFetch = async () => assert.fail('A mixed-cluster request cannot reach RPC');
  assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: neverFetch })).status, 'failed');
  assert.equal((await verifyRingsPayment({ ...f.disclosure, intent: { ...f.disclosure.intent, network: 'devnet' } }, mainnetEnv, { fetchImpl: neverFetch })).status, 'failed');
  assert.equal((await verifyRingsPayment({ ...f.disclosure, intent: { ...f.disclosure.intent, mint: DEVNET_USDC_MINT } }, mainnetEnv, { fetchImpl: neverFetch })).status, 'failed');
  const wrongGenesis = async (_url, init) => Response.json({ jsonrpc: '2.0', id: 1, result: JSON.parse(init.body).method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : null });
  assert.equal((await verifyRingsPayment(f.disclosure, mainnetEnv, { fetchImpl: wrongGenesis })).status, 'pending');
});

test('rejects a replay against another intent or changed terms', async () => {
  for (const field of ['id', 'dealId', 'termsHash', 'memo']) {
    const f = await fixture();
    f.disclosure.intent[field] += '-changed';
    const result = await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl });
    assert.equal(result.status, 'failed', field);
    assert.match(result.reason, /memo/);
  }
});

test('rejects mismatched amounts, recipients, payer and transaction key', async () => {
  for (const kind of ['amount', 'recipient', 'payer', 'key']) {
    const f = await fixture();
    if (kind === 'amount') f.disclosure.intent.amountAtomic = '51';
    if (kind === 'recipient') f.disclosure.intent.recipientWallet = SOL_MINT;
    if (kind === 'payer') f.disclosure.intent.payerWallet = SOL_MINT;
    if (kind === 'key') { const key = ViewingKey.generate(); f.disclosure.transactionViewingKey = toBase64(key.secretBytes()); key.destroy(); }
    assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl })).status, 'failed', kind);
  }
});

test('rejects a brand acting as gas sponsor for another private input owner', async () => {
  const f = await fixture();
  const message = f.chain.transaction.message;
  message.header.numRequiredSignatures = 2;
  message.accountKeys.push(intent.recipientWallet);
  message.instructions[0].accounts[message.instructions[0].accounts.length - 1] = message.accountKeys.length - 1;
  const result = await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /sole private input owner/);
});

test('missing finality remains pending; onchain failure never becomes paid', async () => {
  const f = await fixture();
  const pending = await verifyRingsPayment(f.disclosure, env, { fetchImpl: async (_url, init) => Response.json({ result: JSON.parse(init.body).method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : null }) });
  assert.equal(pending.status, 'pending');
  f.chain.meta.err = { InstructionError: [0, 'InvalidInstructionData'] };
  assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl })).status, 'failed');
});

test('rejects non-Rings, ambiguous instructions, wrong cluster, and malformed disclosures', async () => {
  const f = await fixture();
  f.chain.transaction.message.instructions.push(f.chain.transaction.message.instructions[0]);
  assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl })).status, 'failed');
  f.chain.transaction.message.instructions.pop();
  f.chain.transaction.message.instructions[0].programIdIndex = 3;
  assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl })).status, 'failed');
  assert.equal((await verifyRingsPayment({ ...f.disclosure, network: 'mainnet-beta' }, env, { fetchImpl: f.fetchImpl })).status, 'failed');
  assert.equal((await verifyRingsPayment({ ...f.disclosure, transactionViewingKey: 'bad' }, env, { fetchImpl: f.fetchImpl })).status, 'failed');
  assert.throws(() => decodePaymentInstruction(f.bytes.slice(0, -1)));
});

test('missing credentials cannot verify a receipt', async () => {
  const f = await fixture();
  const result = await verifyRingsPayment(f.disclosure, {}, { fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'pending');
  assert.equal(f.calls.length, 0);
});

test('a transient registry RPC failure stays pending and can recover after funds finalize', async () => {
  const f = await fixture();
  const outage = async (url, init) => {
    if (JSON.parse(init.body).method === 'getAccountInfo') throw new Error('Temporary network outage');
    return f.fetchImpl(url, init);
  };
  assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: outage })).status, 'pending');
  assert.equal((await verifyRingsPayment(f.disclosure, env, { fetchImpl: f.fetchImpl })).status, 'verified');
});

test('official Poseidon hasher stable known output for Worker alias validation', () => {
  assert.equal(Buffer.from(poseidon([Uint8Array.of(1)])).toString('hex'), '29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133');
});
