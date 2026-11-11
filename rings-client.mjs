import { getWallets } from '@wallet-standard/app';
import {
  createSprClient, LocalKeys, Wallet, buildRegistrationTransaction,
  buildDepositTransaction, syncWallet, SHIELDED_POOL_PROGRAM_ID,
} from '@heliuslabs/spr';
import { SignedTeePolicy } from '@heliuslabs/spr/client';
import { ed25519DerivationMessage } from '@heliuslabs/spr/keypair';
import { resolveRegisteredAddress, fetchUserRecord } from '@heliuslabs/spr/wallet';
import { ConfidentialTransfer, ProofInputUtxo, encryptConfidentialTransfer } from '@heliuslabs/spr/transaction';
import { transactInstruction, InstructionTag, ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from '@heliuslabs/spr/interface';
import { compileUnsignedTransaction, splAssetRegistryAddress, decodeSplAssetRegistryAccount, associatedTokenAddress, Reader, resolveWithdrawalSettlement, withdrawalSetupInstructions, reservedUtxoKeys, unreserved, checkPreparedTransfer, checkAuthorizedBinding, checkTransactData } from '@heliuslabs/spr/internal';
import { address, getAddressEncoder, getTransactionEncoder, getTransactionDecoder, getSignatureFromTransaction, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RINGS_NETWORK, SOL_MINT, amountAtomic, paymentMemo, equalBytes, toBase64, fromBase64 } from './rings-protocol.mjs';
import { getNetworkConfig } from './rings-networks.mjs';

const encoder = getAddressEncoder();
const rpcSlot = value => typeof value === 'bigint' && value >= 0n && value <= 0xffffffffffffffffn
  ? value : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
const slotAtLeast = (value, floor) => rpcSlot(value) !== null && rpcSlot(value) >= floor;
const transactionError = value => (typeof value === 'string' && value.length > 0)
  || (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
const withdrawalMismatch = field => new Error(`The withdrawal does not match the reviewed ${field}.`);
export const isMemoOnlySpendable = entry => !entry.spent && entry.utxo.ringProgramId === undefined
  && entry.dataHash === undefined && entry.ringDataHash === undefined
  && entry.utxo.data.records().every(record => record.kind === 'memo');

/** Pinned SDK 0.9's high-level selector excludes even non-committing memos. */
export async function prepareConnectedWithdrawal({ wallet, identity, owner, asset, amount, tree, treeId }) {
  if (identity.solanaAddress() !== owner) throw withdrawalMismatch('wallet');
  const available = unreserved(reservedUtxoKeys(wallet));
  const eligible = wallet.utxos().filter(entry => isMemoOnlySpendable(entry) && entry.utxo.asset === asset && entry.utxo.amount > 0n
    && entry.outputContext.tree === tree && available(entry))
    .sort((a,b) => a.utxo.amount === b.utxo.amount ? 0 : a.utxo.amount > b.utxo.amount ? -1 : 1);
  const selected=[];let total=0n;
  for(const entry of eligible){if(total>=amount)break;selected.push(entry);total+=entry.utxo.amount;}
  if(total<amount)throw new Error('Your available private balance is too low for this withdrawal. Refresh the balance before retrying.');
  if(selected.length>40)throw new Error('This balance needs a Rings wallet merge before withdrawing.');
  const inputs=selected.map(entry=>{
    // Keep the actual UTXO and its memo intact. Neither commitments, nullifiers,
    // ownership, nor custom/ring semantics are rewritten to satisfy selection.
    const input=new ProofInputUtxo({utxo:entry.utxo,nullifierPublicKey:identity.nullifierPublicKey,nullifier:entry.nullifier,treeId});
    if(!equalBytes(input.hash(),entry.outputContext.hash))throw new Error('A withdrawal input does not match its onchain commitment. Refresh the wallet before retrying.');
    return input;
  });
  const resolved=await resolveWithdrawalSettlement(owner,asset);
  const transfer=new ConfidentialTransfer(identity,inputs,owner);
  transfer.withdraw(asset,amount,resolved.target);
  const prepared=transfer.prepare();
  const intent={kind:'withdrawal',asset,amount,recipient:asset===SOL_MINT?owner:await associatedTokenAddress(owner,asset)};
  checkPreparedTransfer(prepared,intent,withdrawalMismatch);
  return {prepared,intent,withdrawal:resolved.accounts,setupInstructions:await withdrawalSetupInstructions({payer:owner,recipient:owner,asset})};
}

export async function validateWithdrawalCheckpoint(record, { owner, network }) {
  getNetworkConfig(network);
  if (!record || record.network !== network || record.owner !== owner || record.recipient !== owner) throw new Error('This saved withdrawal belongs to another wallet or network.');
  address(record.mint);
  amountAtomic(record.amountAtomic);
  if (!/^\d+$/.test(record.lastValidBlockHeight || '')) throw new Error('The saved withdrawal has no valid expiry.');
  const signed = getTransactionDecoder().decode(fromBase64(record.signedTransaction));
  const message = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
  if (message.version !== 1 || message.staticAccounts[0] !== owner || getSignatureFromTransaction(signed) !== record.txSignature) throw new Error('The saved withdrawal does not match its signed transaction.');
  for (const [signer, signature] of Object.entries(signed.signatures)) {
    if (!signature || !ed25519.verify(signature, signed.messageBytes, encoder.encode(address(signer)))) throw new Error('The saved withdrawal has an invalid signature.');
  }
  const instructions = message.instructionHeaders.map((header, index) => ({ program: message.staticAccounts[header.programAccountIndex], ...message.instructionPayloads[index] }));
  const withdrawals = instructions.filter(instruction => instruction.program === SHIELDED_POOL_PROGRAM_ID && instruction.instructionData[0] === InstructionTag.transact);
  if (withdrawals.length !== 1 || instructions.some(instruction => instruction !== withdrawals[0] && instruction.program !== ASSOCIATED_TOKEN_PROGRAM_ID)) throw new Error('The saved transaction is not a supported Rings withdrawal.');
  const withdrawal = withdrawals[0], reader = new Reader(new Uint8Array(withdrawal.instructionData));
  reader.u8('tag');reader.u64('expiry');reader.bytes(33,'viewingKey');reader.bytes(16,'salt');
  const count=reader.u8('transfers'),kind=reader.u8('kind'),amount=reader.u64('amount');
  if (count !== 1 || kind !== (record.mint === SOL_MINT ? 1 : 3) || amount !== amountAtomic(record.amountAtomic)) throw new Error('The saved withdrawal amount or asset does not match its signed transaction.');
  const accounts=withdrawal.instructionAccountIndices.map(index => message.staticAccounts[index]);
  if(record.mint===SOL_MINT){if(accounts.at(-1)!==owner)throw new Error('The saved withdrawal has another recipient.');}
  else if(accounts.at(-4)!==record.mint || accounts.at(-2)!==await associatedTokenAddress(address(owner),address(record.mint)) || accounts.at(-1)!==SPL_TOKEN_PROGRAM_ID)throw new Error('The saved withdrawal token or recipient does not match your wallet.');
  // The blockhash is signed. lastValidBlockHeight is local metadata only and
  // must never authorize clearing a pending spend.
  return { blockhash: message.lifetimeToken };
}

export function detectWalletProvider() {
  const wallets = getWallets().get().filter((wallet) => wallet.features['standard:connect'] && wallet.features['solana:signMessage']);
  return wallets.find((wallet) => wallet.features['solana:signTransaction']?.supportedTransactionVersions?.includes(1)) ?? wallets[0] ?? null;
}

/** Rewrite transport only. The SDK still attests and encrypts proofs end to end. */
export function createProxyFetch(rpcProxy = '/api/rpc', fetchImpl = globalThis.fetch.bind(globalThis), network = RINGS_NETWORK) {
  const selected = getNetworkConfig(network);
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === selected.policyURL) return fetchImpl(url, init);
    if (url.origin !== new URL(selected.rpcUrl).origin) throw new Error('Unexpected Rings service endpoint.');
    const base = new URL(rpcProxy, globalThis.location?.origin ?? 'http://localhost');
    if (globalThis.location && base.origin !== globalThis.location.origin) throw new Error('The RPC proxy must use the same origin.');
    base.searchParams.set('path', `${url.pathname}${url.search}`);
    return fetchImpl(base, { ...init, credentials: 'same-origin' });
  };
}

export function createRingsWallet({ provider = detectWalletProvider(), rpcProxy = '/api/rpc', network = RINGS_NETWORK } = {}) {
  const selected = getNetworkConfig(network);
  const CHAIN = selected.walletChain, UPSTREAM = selected.rpcUrl;
  let account, keys, wallet, client, pendingWithdrawal, inFlight = false, active = true;
  const proxiedFetch = createProxyFetch(rpcProxy, globalThis.fetch.bind(globalThis), network);

  function connected() {
    if (!active || !account) throw new Error('Connect your wallet first.');
    const stillConnected = provider.accounts?.some((entry) => entry.address === account.address);
    if (provider.accounts && !stillConnected) { wipe(); throw new Error('The wallet account changed. Reconnect before continuing.'); }
    return address(account.address);
  }
  function assertVersion1() {
    connected();
    if (!provider.features['solana:signTransaction']?.supportedTransactionVersions?.includes(1)) {
      throw new Error('This wallet cannot sign Solana version 1 transactions required by the current Rings SDK. Connect a wallet with version 1 support.');
    }
  }
  function wipe() { keys?.destroy(); keys = undefined; wallet = undefined; }
  async function service() {
    if (!client) {
      const next = await createSprClient({ solanaRpcUrl: UPSTREAM, fetch: proxiedFetch, proverTee: SignedTeePolicy.forNetwork(selected.policyNetwork), commitment: 'confirmed' });
      const genesis = await next.solanaRpc.getGenesisHash().send();
      if (genesis !== selected.genesisHash) throw new Error(`The RPC endpoint is not Solana ${network}.`);
      client = next;
    }
    return client;
  }
  async function exclusive(work) {
    if (inFlight) throw new Error('Another wallet operation is still running.');
    inFlight = true;
    try { return await work(); } finally { inFlight = false; }
  }
  async function signBytes(bytes) {
    const owner = connected();
    const [result] = await provider.features['solana:signMessage'].signMessage({ account, message: bytes });
    if (connected() !== owner || !result || !equalBytes(new Uint8Array(result.signedMessage), bytes) || !ed25519.verify(result.signature, bytes, encoder.encode(owner))) {
      throw new Error('The wallet did not sign the exact requested message.');
    }
    return new Uint8Array(result.signature);
  }
  async function registered() {
    if (!keys) return false;
    const record = await fetchUserRecord({ rpc: await service(), owner: connected() });
    if (!record) return false;
    if (!equalBytes(record.nullifierPublicKey, keys.address().nullifierPublicKey) || !equalBytes(record.viewingPublicKey, keys.address().viewingPublicKey.toBytes())) {
      throw new Error('This wallet has a different registered privacy identity. Use its original Rings wallet to recover it; this app will not replace keys.');
    }
    return true;
  }
  async function requireUnlocked() {
    connected();
    if (!keys || !wallet) throw new Error('Unlock your private wallet first.');
    if (!await registered()) throw new Error('Create your private wallet before depositing or paying.');
  }
  function requireNoPendingWithdrawal() {
    if (pendingWithdrawal) throw new Error('Check the saved withdrawal before making another private spend. No replacement transaction will be created.');
  }
  async function assetSupported(mint) {
    const asset = address(mint);
    if (asset === SOL_MINT) return asset;
    const rpc = await service();
    const entry = await rpc.getAccount(await splAssetRegistryAddress(asset));
    if (!entry || entry.owner !== SHIELDED_POOL_PROGRAM_ID) throw new Error(`This token has no Rings registry on ${network}. Deposit and payment are unavailable for it.`);
    const record = decodeSplAssetRegistryAccount(entry.data);
    if (record.mint !== asset) throw new Error('The token registry does not match this token.');
    wallet?.ensureAsset(record.assetId, asset);
    return asset;
  }
  async function submit(unsigned, { beforeBroadcast } = {}) {
    assertVersion1();
    const owner = connected();
    const [result] = await provider.features['solana:signTransaction'].signTransaction({ account, chain: CHAIN, transaction: new Uint8Array(getTransactionEncoder().encode(unsigned)) });
    if (connected() !== owner || !result?.signedTransaction) throw new Error('The wallet account changed while signing.');
    const signed = getTransactionDecoder().decode(result.signedTransaction);
    if (!equalBytes(signed.messageBytes, unsigned.messageBytes)) throw new Error('The wallet changed the transaction. It was not submitted.');
    for (const [signer, signature] of Object.entries(signed.signatures)) {
      if (!signature || !ed25519.verify(signature, signed.messageBytes, encoder.encode(address(signer)))) throw new Error('The transaction is not fully signed.');
    }
    const txSignature = getSignatureFromTransaction(signed);
    const signedTransaction = toBase64(result.signedTransaction);
    // A payment's exact signed bytes and disclosure must be durable before any
    // broadcast. A reload or lost response can then retry this signature only.
    if (beforeBroadcast) await beforeBroadcast({ txSignature, signedTransaction, lastValidBlockHeight: unsigned.lifetimeConstraint?.lastValidBlockHeight?.toString() });
    return broadcast({ txSignature, signedTransaction });
  }
  async function broadcast({ txSignature, signedTransaction }) {
    let response;
    try {
      response = await proxiedFetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [signedTransaction, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }] }) });
    } catch {
      // A lost acknowledgement does not mean a transfer failed. Reconcile this
      // signed transaction instead of constructing a second payment.
      return { signature: txSignature, status: 'pending', broadcastUncertain: true };
    }
    if (!response.ok) return { signature: txSignature, status: 'pending', broadcastUncertain: true };
    const answer = await response.json();
    if (answer.error) throw new Error(`Solana rejected the transaction: ${answer.error.message || 'preflight failed'}`);
    if (answer.result !== txSignature) throw new Error('The RPC returned a different transaction signature.');
    return { signature: txSignature, status: 'pending' };
  }
  async function confirm(result) {
    try {
      const slot = await (await service()).confirmTransaction(result.signature);
      return { ...result, status: 'confirmed', slot: slot.toString() };
    } catch { return result; }
  }
  async function withdrawalExpired(rpc, signature, blockhash) {
    // A fresh confirmed blockhash can be absent from the finalized bank during
    // a finality stall. Require both banks to reject the signed blockhash, then
    // independent historical absence. Never trust an editable expiry height.
    // Signature-status context may be ahead of finality, so start the floor
    // with the finalized bank rather than that initial status response.
    const floor = rpcSlot(await rpc.solanaRpc.getSlot({ commitment: 'finalized' }).send());
    if (floor === null) return false;
    const finalized = await rpc.solanaRpc.isBlockhashValid(blockhash, { commitment: 'finalized', minContextSlot: floor }).send();
    if (finalized?.value !== false || !slotAtLeast(finalized?.context?.slot, floor)) return false;
    const confirmed = await rpc.solanaRpc.isBlockhashValid(blockhash, { commitment: 'confirmed', minContextSlot: rpcSlot(finalized.context.slot) }).send();
    if (confirmed?.value !== false || !slotAtLeast(confirmed?.context?.slot, rpcSlot(finalized.context.slot))) return false;
    const checked = await rpc.solanaRpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
    if (!slotAtLeast(checked?.context?.slot, rpcSlot(confirmed.context.slot)) || !Array.isArray(checked?.value) || checked.value.length !== 1 || checked.value[0] !== null) return false;
    const transaction = await rpc.solanaRpc.getTransaction(signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }).send();
    return transaction === null;
  }
  async function reconcileWithdrawal(record, { rebroadcast = false } = {}) {
    const lifetime = await validateWithdrawalCheckpoint(record, { owner: connected(), network });
    pendingWithdrawal = record;
    const rpc = await service();
    const status = await rpc.solanaRpc.getSignatureStatuses([record.txSignature], { searchTransactionHistory: true }).send();
    const statusValid = slotAtLeast(status?.context?.slot, 0n) && Array.isArray(status?.value) && status.value.length === 1;
    const found = statusValid ? status.value[0] : undefined;
    if (found?.confirmationStatus === 'finalized' && slotAtLeast(found.slot, 0n) && rpcSlot(status.context.slot) >= rpcSlot(found.slot)
      && (found.err === null || transactionError(found.err))) {
      pendingWithdrawal = undefined;
      if (found.err === null && keys && wallet) await syncWallet({ client: rpc, keys, wallet, config: { requireSlot: found.slot } });
      return { signature: record.txSignature, status: found.err === null ? 'confirmed' : 'failed', finalized: true, slot: found.slot.toString() };
    }
    if (found === null && await withdrawalExpired(rpc, record.txSignature, lifetime.blockhash)) {
      pendingWithdrawal = undefined;
      return { signature: record.txSignature, status: 'expired', finalized: true };
    }
    if (rebroadcast && found === null) await broadcast(record);
    return { signature: record.txSignature, status: 'pending', confirmationStatus: found?.confirmationStatus || null };
  }

  return {
    async connect() {
      if (!provider?.features?.['standard:connect']) throw new Error('Install a Solana Wallet Standard wallet to connect.');
      active = true;
      const result = await provider.features['standard:connect'].connect();
      const available = result?.accounts ?? provider.accounts;
      const nextAccount = available?.find((entry) => entry.chains.includes(CHAIN) && entry.features.includes('solana:signMessage'));
      if (account?.address !== nextAccount?.address) wipe();
      account = nextAccount;
      if (!account) throw new Error(`This wallet did not expose a Solana ${network} account with message signing.`);
      return { address: connected(), network, walletName: provider.name, version1Supported: !!provider.features['solana:signTransaction']?.supportedTransactionVersions?.includes(1) };
    },
    async signMessage(message) {
      if (typeof message !== 'string' || !message || message.length > 8192 || message.includes('TSPP/derive/')) throw new Error('Invalid authentication message.');
      return toBase64(await signBytes(new TextEncoder().encode(message)));
    },
    async unlock() {
      return exclusive(async () => {
        const owner = connected();
        const rpc = await service();
        if (!keys) {
          const seed = await signBytes(ed25519DerivationMessage(new Uint8Array(encoder.encode(owner))));
          try {
            keys = LocalKeys.fromDerivationSeed({ solanaPublicKey: owner, derivationSeed: seed }, rpc.proofService);
            wallet = new Wallet({ identity: keys.address() });
          } finally { seed.fill(0); }
        }
        return { address: owner, network, registered: await registered() };
      });
    },
    async register() {
      return exclusive(async () => {
        assertVersion1();
        if (!keys) throw new Error('Unlock your private wallet first.');
        const rpc = await service();
        const unsigned = await buildRegistrationTransaction({ client: rpc, owner: connected(), address: keys.address() });
        return unsigned ? confirm(await submit(unsigned)) : { signature: null, status: 'confirmed' };
      });
    },
    async getBalances() {
      const rpc = await service();
      const publicSolAtomic = (await rpc.getBalance(connected())).toString();
      if (!keys) return { publicSolAtomic, privateBalances: [], locked: true, registered: false };
      const isRegistered = await registered();
      if (isRegistered) await syncWallet({ client: rpc, keys, wallet });
      return { publicSolAtomic, privateBalances: wallet.balances(true).map((entry) => ({ mint: entry.mint, amountAtomic: entry.amount.toString() })), locked: false, registered: isRegistered };
    },
    async deposit({ mint = SOL_MINT, amountAtomic: value }) {
      return exclusive(async () => {
        assertVersion1();
        await requireUnlocked();
        const rpc = await service();
        const asset = await assetSupported(mint);
        const unsigned = await buildDepositTransaction({ client: rpc, feePayer: connected(), recipient: keys.address(), asset, amount: amountAtomic(value), createSplInterface: false });
        return confirm(await submit(unsigned));
      });
    },
    async withdraw({ mint = SOL_MINT, amountAtomic: value, recipient }, { beforeBroadcast } = {}) {
      return exclusive(async () => {
        assertVersion1();
        if (typeof beforeBroadcast !== 'function') throw new Error('A durable withdrawal checkpoint is required before broadcasting.');
        const owner = connected();
        if (recipient !== undefined && recipient !== owner) throw new Error('Withdrawals can only return to your connected wallet.');
        requireNoPendingWithdrawal();
        await requireUnlocked();
        const rpc = await service(), asset = await assetSupported(mint), amount = amountAtomic(value);
        await syncWallet({ client: rpc, keys, wallet });
        const {prepared,intent,withdrawal,setupInstructions}=await prepareConnectedWithdrawal({wallet,identity:keys.address(),owner,asset,amount,tree:rpc.tree,treeId:rpc.treeId});
        const [txKey]=await keys.transactionKeys([{viewingPublicKey:keys.address().viewingPublicKey,firstNullifier:prepared.firstNullifier}]);
        let unsigned;
        try{
          const proofInputs=prepared.finalize(encryptConfidentialTransfer(txKey,{outputs:prepared.outputs,assets:wallet.registry}));
          checkAuthorizedBinding({proofInputs,owner:keys.address(),senderOutputCount:prepared.senderOutputCount,intent,withdrawal},withdrawalMismatch);
          const data=await rpc.proveTransact(proofInputs,keys);
          checkTransactData(data,intent,withdrawalMismatch);
          const instruction=await transactInstruction({payer:owner,ownerSigners:[owner],inputTree:rpc.tree,outputTree:rpc.tree,data,withdrawal});
          unsigned=compileUnsignedTransaction({feePayer:owner,lifetime:await rpc.getLatestBlockhash(),setupInstructions,instructions:[instruction],computeUnitLimit:450_000});
        }finally{txKey.destroy();}
        let saved;
        await submit(unsigned, { beforeBroadcast: async signed => {
          saved = { ...signed, network, owner, recipient: owner, mint: asset, amountAtomic: amount.toString() };
          await validateWithdrawalCheckpoint(saved, { owner, network });
          await beforeBroadcast(saved);
          pendingWithdrawal = saved;
        } });
        // Only finalized chain evidence permits a fresh withdrawal, even when
        // an acknowledgement or confirmation is lost after broadcasting.
        try { return await reconcileWithdrawal(saved); }
        catch { return { signature: saved.txSignature, status: 'pending' }; }
      });
    },
    async reconcileWithdrawal(record, options) { return exclusive(() => reconcileWithdrawal(record, options)); },
    async payIntent(intent, { beforeBroadcast } = {}) {
      return exclusive(async () => {
        assertVersion1();
        if (typeof beforeBroadcast !== 'function') throw new Error('A durable payment checkpoint is required before broadcasting.');
        if (intent.network !== network) throw new Error('The payment intent belongs to another Solana network.');
        requireNoPendingWithdrawal();
        await requireUnlocked();
        const owner = connected();
        const memo = paymentMemo(intent);
        if (intent.payerWallet !== owner) throw new Error('The payment intent belongs to another wallet.');
        if (intent.recipientWallet === owner) throw new Error('A sponsorship payment must have a different recipient.');
        const rpc = await service();
        const asset = await assetSupported(intent.mint);
        const recipient = await resolveRegisteredAddress({ rpc, owner: address(intent.recipientWallet) });
        if (!recipient) throw new Error('The recipient must register a private Rings wallet before receiving this payment.');
        await syncWallet({ client: rpc, keys, wallet });
        const amount = amountAtomic(intent.amountAtomic);
        const eligible = wallet.utxos().filter((entry) => isMemoOnlySpendable(entry) && entry.utxo.asset === asset && entry.outputContext.tree === rpc.tree).sort((a, b) => a.utxo.amount === b.utxo.amount ? 0 : a.utxo.amount > b.utxo.amount ? -1 : 1);
        const selected = [];
        let total = 0n;
        for (const entry of eligible) { if (total >= amount) break; selected.push(entry); total += entry.utxo.amount; }
        if (total < amount) throw new Error('Deposit enough of this token into your private balance first.');
        if (selected.length > 40) throw new Error('This balance needs a Rings wallet merge before this app can spend it.');
        const inputs = selected.map((entry) => new ProofInputUtxo({ utxo: entry.utxo, nullifierPublicKey: keys.address().nullifierPublicKey, nullifier: entry.nullifier, treeId: rpc.treeId }));
        const transfer = new ConfidentialTransfer(keys.address(), inputs, owner);
        transfer.send(recipient.address, asset, amount);
        const prepared = transfer.prepare();
        const outputIndex = prepared.senderOutputCount;
        const [txKey] = await keys.transactionKeys([{ viewingPublicKey: keys.address().viewingPublicKey, firstNullifier: prepared.firstNullifier }]);
        try {
          // Memo does not alter the recipient UTXO commitment. Its ciphertext is
          // authenticated by the transaction's proved/signed external-data hash.
          const outputs = prepared.outputs.map((output, index) => index === outputIndex ? output.withMemo(memo) : output);
          const encrypted = encryptConfidentialTransfer(txKey, { outputs, assets: wallet.registry });
          const proofInputs = prepared.finalize(encrypted);
          const data = await rpc.proveTransact(proofInputs, keys);
          const instruction = await transactInstruction({ payer: owner, ownerSigners: [owner], inputTree: rpc.tree, outputTree: rpc.tree, data });
          const unsigned = compileUnsignedTransaction({ feePayer: owner, lifetime: await rpc.getLatestBlockhash(), instructions: [instruction], computeUnitLimit: 450_000 });
          const disclosure = { network, eventIndex: 0, outputIndex, transactionViewingKey: toBase64(txKey.secretBytes()) };
          const sent = await submit(unsigned, { beforeBroadcast: (signed) => beforeBroadcast({ ...disclosure, ...signed }) });
          return { ...disclosure, txSignature: sent.signature, status: sent.status, broadcastUncertain: !!sent.broadcastUncertain };
        } finally { txKey.destroy(); }
      });
    },
    async disconnect() { wipe(); account = undefined; active = false; await provider?.features?.['standard:disconnect']?.disconnect(); },
  };
}
