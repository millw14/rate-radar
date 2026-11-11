import { address, isAddress, isSignature, getAddressEncoder, getBase58Encoder } from '@solana/kit';
import { initializePoseidon, ViewingKey, X25519PublicKey } from '@heliuslabs/spr/keypair';
import { SHIELDED_POOL_PROGRAM_ID, InstructionTag, DEFAULT_TREE_ID } from '@heliuslabs/spr/interface';
import { resolveRegisteredAddress } from '@heliuslabs/spr/wallet';
import { Utxo, SOL_ASSET_ID, decodeOutputData, decodeConfidential, EncryptedScheme } from '@heliuslabs/spr/transaction';
import { Reader, treeAddress, splAssetRegistryAddress, decodeSplAssetRegistryAccount } from '@heliuslabs/spr/internal';
import { RINGS_NETWORK, SOL_MINT, DEVNET_GENESIS_HASH, amountAtomic, paymentMemo, equalBytes, fromBase64 } from './rings-protocol.mjs';

class InvalidEvidence extends Error {}
const refuse = (message) => { throw new InvalidEvidence(message); };
const addressEncoder = getAddressEncoder();
const base58Encoder = getBase58Encoder();

/**
 * Decode the exact 0.9.0-alpha confidential-signer wire emitted by our client.
 * The SDK exports its encoder but no matching transact decoder. This reader
 * follows dist/interface/codecs/index.js, and deliberately rejects other rails.
 * It reads the ciphertext from the finalized instruction, never from the user
 * or an unanchored indexer row. Solana's successful proof verification binds
 * this external data, including ciphertext and memo, to the transaction.
 */
export function decodePaymentInstruction(data) {
  const reader = new Reader(data);
  if (reader.u8('tag') !== InstructionTag.transact) refuse('Not a private Rings transfer.');
  const expiry = reader.u64('expiry');
  const txViewingPk = reader.bytes(33, 'txViewingPk');
  const salt = reader.bytes(16, 'salt');
  if (reader.u8('interfaceTransfers') !== 0) refuse('Public deposits or withdrawals cannot settle this payment.');
  if (reader.option('dataHash', (r) => r.bytes(32, 'dataHash')) !== undefined || reader.option('ringDataHash', (r) => r.bytes(32, 'ringDataHash')) !== undefined) refuse('Unsupported custom transfer data.');
  const outputs = Array.from({ length: reader.u8('outputs') }, () => {
    const hash = reader.bytes(32, 'utxoHash');
    const tag = reader.u8('ownerTag');
    let ownerTag;
    if (tag === 0) ownerTag = { kind: 'inline', value: reader.bytes(32, 'ownerTag.value') };
    else if (tag === 1) ownerTag = { kind: 'account', index: reader.u8('ownerTag.index') };
    else refuse('Invalid output owner tag.');
    const payload = reader.option('payload', (r) => r.bytes(r.u16('payload.length'), 'payload'));
    return { hash, ownerTag, payload };
  });
  const messageCount = reader.u8('messages');
  for (let index = 0; index < messageCount; index++) { reader.bytes(32, 'message.tag'); reader.bytes(reader.u16('message.length'), 'message'); }
  reader.bytes(32, 'privateTxHash');
  if (reader.u16('circuit') !== 0) refuse('This receipt accepts the default confidential signer rail only.');
  const inputShape = reader.u8('shape.inputs');
  const outputShape = reader.u8('shape.outputs');
  reader.u8('shape.publicAssetSlots');
  reader.bytes(192, 'proof');
  const inputs = Array.from({ length: reader.u8('inputs') }, () => ({ nullifier: reader.bytes(32, 'nullifier'), treeIndex: reader.u8('treeIndex') }));
  const treeContexts = reader.u8('treeContexts');
  reader.bytes(treeContexts * 4, 'rootIndexes');
  reader.done();
  if (!inputs.length || inputs.length !== inputShape || outputs.length !== outputShape || treeContexts !== 1 || inputs.some((input) => input.treeIndex !== 0)) refuse('Unsupported transfer shape.');
  return { expiry, txViewingPk, salt, outputs, inputs };
}

function transactionAccounts(transaction) {
  const keys = transaction.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) refuse('The chain transaction has no account list.');
  const addresses = keys.map((key) => typeof key === 'string' ? key : key.pubkey);
  const loaded = transaction.meta?.loadedAddresses;
  if (loaded) addresses.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
  if (addresses.some((key) => !isAddress(key))) refuse('Invalid chain transaction accounts.');
  return addresses;
}

export function decodeFinalizedPayment(transaction, intent, outputIndex) {
  if (transaction.meta?.err !== null) refuse('The Solana transaction failed.');
  if (!Number.isSafeInteger(transaction.slot) || transaction.slot < 0) refuse('Invalid transaction slot.');
  const accounts = transactionAccounts(transaction);
  const header = transaction.transaction.message.header;
  if (accounts[0] !== intent.payerWallet || !header || header.numRequiredSignatures < 1) refuse('The payment was not signed by the expected payer.');
  const instructions = transaction.transaction.message.instructions;
  if (!Array.isArray(instructions)) refuse('Missing chain instructions.');
  const transfers = instructions.map((instruction, instructionIndex) => ({ instruction, instructionIndex })).filter(({ instruction }) => accounts[instruction.programIdIndex] === SHIELDED_POOL_PROGRAM_ID && base58Encoder.encode(instruction.data)[0] === InstructionTag.transact);
  if (transfers.length !== 1) refuse('Expected one direct private Rings transfer.');
  const { instruction, instructionIndex } = transfers[0];
  if (!Array.isArray(instruction.accounts) || instruction.accounts.length < 5 || accounts[instruction.accounts[0]] !== intent.payerWallet) refuse('The Rings payer does not match.');
  // The pinned SDK supports one default tree; other trees require a new integration.
  const defaultTree = treeAddress(DEFAULT_TREE_ID);
  if (accounts[instruction.accounts[1]] !== defaultTree || accounts[instruction.accounts[4]] !== defaultTree) refuse('Unsupported Rings tree.');
  const decoded = decodePaymentInstruction(new Uint8Array(base58Encoder.encode(instruction.data)));
  // In the default confidential-signer rail, owners follow the nullifier PDAs.
  // Our supported payment has exactly one owner, the brand, and no settlement
  // or cache accounts. Being only a fee sponsor is not evidence of paying from
  // the brand's private balance.
  const ownerPosition = 5 + decoded.inputs.length;
  if (header.numRequiredSignatures !== 1 || instruction.accounts.length !== ownerPosition + 1 || accounts[instruction.accounts[ownerPosition]] !== intent.payerWallet) {
    refuse('The approved brand must be the sole private input owner and payer.');
  }
  const output = decoded.outputs[outputIndex];
  if (!output?.payload) refuse('The disclosed private output does not exist.');
  const ownerTag = output.ownerTag.kind === 'inline' ? output.ownerTag.value : new Uint8Array(addressEncoder.encode(accounts[instruction.accounts[output.ownerTag.index]]));
  if (!equalBytes(ownerTag, new Uint8Array(addressEncoder.encode(intent.recipientWallet)))) refuse('The private output belongs to another recipient.');
  return { ...decoded, output, instructionIndex, slot: transaction.slot, blockTime: transaction.blockTime };
}

function rpcFactory(env, fetchImpl) {
  if (!env.HELIUS_API_KEY) throw new Error('Rings RPC is not configured.');
  const url = new URL('https://devnet.helius-rpc.com/');
  url.searchParams.set('api-key', env.HELIUS_API_KEY);
  return async (method, params = []) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('Rings RPC is temporarily unavailable.');
    const result = await response.json();
    if (result.error || !Object.hasOwn(result, 'result')) throw new Error('Rings RPC could not complete verification.');
    return result.result;
  };
}

/** No master viewing key, seed, or client-supplied plaintext is accepted. */
export async function verifyRingsPayment(input, env, { fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  let txKey;
  try {
    const { intent, txSignature, outputIndex, eventIndex = 0, transactionViewingKey } = input ?? {};
    if (input?.network !== RINGS_NETWORK || (env.RINGS_NETWORK && env.RINGS_NETWORK !== RINGS_NETWORK)) refuse('Only Solana devnet payments are supported.');
    let memo;
    try { memo = paymentMemo(intent); } catch { refuse('Invalid payment intent.'); }
    if (!isSignature(txSignature) || !Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > 15 || eventIndex !== 0) refuse('Invalid transaction disclosure.');
    for (const field of ['mint', 'payerWallet', 'recipientWallet']) if (!isAddress(intent[field])) refuse('Invalid payment address.');
    if (intent.payerWallet === intent.recipientWallet) refuse('The payer and recipient must be different.');
    let keyBytes;
    try {
      keyBytes = fromBase64(transactionViewingKey, 32);
      txKey = ViewingKey.fromBytes(keyBytes);
    } catch { refuse('Invalid transaction viewing key.'); }
    finally { keyBytes?.fill(0); }
    const rpc = rpcFactory(env, fetchImpl);
    if (await rpc('getGenesisHash') !== DEVNET_GENESIS_HASH) refuse('The RPC endpoint is not Solana devnet.');
    // commitment=finalized is the source of finality. A merely confirmed
    // transaction cannot create a paid receipt, even if the client says it did.
    const chain = await rpc('getTransaction', [txSignature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }]);
    if (!chain) return { status: 'pending', reason: 'Waiting for Solana finality.' };
    if (chain.transaction?.signatures?.[0] !== txSignature) refuse('The returned chain transaction does not match the disclosure.');
    const decoded = decodeFinalizedPayment(chain, intent, outputIndex);
    if (!equalBytes(txKey.publicKey().toBytes(), decoded.txViewingPk)) refuse('This key does not belong to the transaction.');
    const accountReader = {
      async getAccount(account) {
        const result = await rpc('getAccountInfo', [account, { commitment: 'finalized', encoding: 'base64' }]);
        if (!result.value) return undefined;
        return { owner: result.value.owner, lamports: BigInt(result.value.lamports), data: fromBase64(result.value.data[0]) };
      },
    };
    await initializePoseidon();
    const recipient = await resolveRegisteredAddress({ rpc: accountReader, owner: address(intent.recipientWallet) });
    if (!recipient) refuse('The recipient has no private wallet registration.');
    let frame;
    try { frame = decodeOutputData(decoded.output.payload); } catch { refuse('The disclosed output is not a supported confidential payment.'); }
    if (frame.encoding !== 'encrypted' || frame.scheme !== EncryptedScheme.confidential || frame.body.length <= 33) refuse('The output is not a default confidential transfer.');
    let embeddedKey;
    try { embeddedKey = X25519PublicKey.fromBytes(frame.body.slice(0, 33)); } catch { refuse('The output has an invalid recipient viewing key.'); }
    if (!embeddedKey.equals(recipient.address.viewingPublicKey)) refuse('The payment is encrypted to a different recipient viewing key.');
    let output, plaintext;
    try {
      plaintext = txKey.decryptSlotEphemeral(embeddedKey, frame.body.slice(33), decoded.salt, outputIndex);
      output = decodeConfidential(plaintext);
    } catch { refuse('The transaction output could not be decrypted with this disclosure.'); }
    finally { plaintext?.fill(0); }
    if (output.ringProgramId || output.data.utxoData() || output.data.ringData()) refuse('Custom or application-bound outputs are not accepted.');
    if (output.amount !== amountAtomic(intent.amountAtomic)) refuse('The private payment amount does not match the deal.');
    if (!equalBytes(output.data.memo(), memo)) refuse('The encrypted payment memo does not match this intent and its terms.');
    let assetId = SOL_ASSET_ID;
    if (intent.mint !== SOL_MINT) {
      const mintAccount = await accountReader.getAccount(await splAssetRegistryAddress(address(intent.mint)));
      if (!mintAccount || mintAccount.owner !== SHIELDED_POOL_PROGRAM_ID) refuse('The mint has no valid Rings asset registry.');
      const registry = decodeSplAssetRegistryAccount(mintAccount.data);
      if (registry.mint !== intent.mint) refuse('The asset registry does not match the expected mint.');
      assetId = registry.assetId;
    }
    if (output.assetId !== assetId) refuse('The private payment token does not match the deal.');
    const utxo = new Utxo({ owner: recipient.address.signingPublicKey, asset: address(intent.mint), amount: output.amount, blinding: output.blinding, data: output.data });
    if (!equalBytes(utxo.hash(recipient.address.nullifierPublicKey, DEFAULT_TREE_ID), decoded.output.hash)) refuse('The disclosed amount and recipient do not match the onchain commitment.');
    return {
      status: 'verified',
      evidence: {
        network: RINGS_NETWORK, txSignature, eventIndex: 0, instructionIndex: decoded.instructionIndex, outputIndex,
        outputCommitment: Array.from(decoded.output.hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        slot: String(decoded.slot), blockTime: decoded.blockTime, finality: 'finalized', finalized: true,
        mint: intent.mint, amountAtomic: intent.amountAtomic, payerWallet: intent.payerWallet, recipientWallet: intent.recipientWallet,
        intentId: intent.id, termsHash: intent.termsHash,
      },
    };
  } catch (error) {
    if (error instanceof InvalidEvidence) return { status: 'failed', reason: error.message };
    // SDK wallet errors may wrap transient RPC failures. Only explicit,
    // positively established evidence mismatches are terminal: infrastructure
    // and unknown decoder failures retain the durable disclosure for retry.
    return { status: 'pending', reason: 'Verification is temporarily unavailable. The payment has not been marked paid.' };
  } finally { txKey?.destroy(); }
}
