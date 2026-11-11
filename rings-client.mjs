import { getWallets } from '@wallet-standard/app';
import {
  createSprClient, LocalKeys, Wallet, buildRegistrationTransaction,
  buildDepositTransaction, syncWallet, SHIELDED_POOL_PROGRAM_ID,
} from '@heliuslabs/spr';
import { SignedTeePolicy } from '@heliuslabs/spr/client';
import { ed25519DerivationMessage } from '@heliuslabs/spr/keypair';
import { resolveRegisteredAddress, fetchUserRecord } from '@heliuslabs/spr/wallet';
import { ConfidentialTransfer, ProofInputUtxo, encryptConfidentialTransfer } from '@heliuslabs/spr/transaction';
import { transactInstruction } from '@heliuslabs/spr/interface';
import { compileUnsignedTransaction, splAssetRegistryAddress, decodeSplAssetRegistryAccount } from '@heliuslabs/spr/internal';
import { address, getAddressEncoder, getTransactionEncoder, getTransactionDecoder, getSignatureFromTransaction } from '@solana/kit';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RINGS_NETWORK, SOL_MINT, DEVNET_GENESIS_HASH, amountAtomic, paymentMemo, equalBytes, toBase64 } from './rings-protocol.mjs';

const CHAIN = 'solana:devnet';
const UPSTREAM = 'https://devnet.helius-rpc.com';
const POLICY = 'https://d3gbdb0egjwcw9.cloudfront.net/tee-policy/devnet.json';
const encoder = getAddressEncoder();

export function detectWalletProvider() {
  const wallets = getWallets().get().filter((wallet) => wallet.features['standard:connect'] && wallet.features['solana:signMessage']);
  return wallets.find((wallet) => wallet.features['solana:signTransaction']?.supportedTransactionVersions?.includes(1)) ?? wallets[0] ?? null;
}

/** Rewrite transport only. The SDK still attests and encrypts proofs end to end. */
export function createProxyFetch(rpcProxy = '/api/rpc', fetchImpl = globalThis.fetch.bind(globalThis)) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === POLICY) return fetchImpl(url, init);
    if (url.origin !== UPSTREAM) throw new Error('Unexpected Rings service endpoint.');
    const base = new URL(rpcProxy, globalThis.location?.origin ?? 'http://localhost');
    if (globalThis.location && base.origin !== globalThis.location.origin) throw new Error('The RPC proxy must use the same origin.');
    base.searchParams.set('path', `${url.pathname}${url.search}`);
    return fetchImpl(base, { ...init, credentials: 'same-origin' });
  };
}

export function createRingsWallet({ provider = detectWalletProvider(), rpcProxy = '/api/rpc', network = RINGS_NETWORK } = {}) {
  if (network !== RINGS_NETWORK) throw new Error('This integration accepts devnet test funds only.');
  let account, keys, wallet, client, inFlight = false, active = true;
  const proxiedFetch = createProxyFetch(rpcProxy);

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
      const next = await createSprClient({ solanaRpcUrl: UPSTREAM, fetch: proxiedFetch, proverTee: SignedTeePolicy.forNetwork('devnet'), commitment: 'confirmed' });
      const genesis = await next.solanaRpc.getGenesisHash().send();
      if (genesis !== DEVNET_GENESIS_HASH) throw new Error('The RPC endpoint is not Solana devnet.');
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
  async function assetSupported(mint) {
    const asset = address(mint);
    if (asset === SOL_MINT) return asset;
    const rpc = await service();
    const entry = await rpc.getAccount(await splAssetRegistryAddress(asset));
    if (!entry || entry.owner !== SHIELDED_POOL_PROGRAM_ID) throw new Error('This token has no Rings registry on devnet. Deposit and payment are unavailable for it.');
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
    if (beforeBroadcast) await beforeBroadcast({ txSignature, signedTransaction });
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

  return {
    async connect() {
      if (!provider?.features?.['standard:connect']) throw new Error('Install a Solana Wallet Standard wallet to connect.');
      active = true;
      const result = await provider.features['standard:connect'].connect();
      const available = result?.accounts ?? provider.accounts;
      const nextAccount = available?.find((entry) => entry.chains.includes(CHAIN) && entry.features.includes('solana:signMessage'));
      if (account?.address !== nextAccount?.address) wipe();
      account = nextAccount;
      if (!account) throw new Error('This wallet did not expose a Solana devnet account with message signing.');
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
    async payIntent(intent, { beforeBroadcast } = {}) {
      return exclusive(async () => {
        assertVersion1();
        if (typeof beforeBroadcast !== 'function') throw new Error('A durable payment checkpoint is required before broadcasting.');
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
        const eligible = wallet.utxos().filter((entry) => !entry.spent && entry.utxo.asset === asset && !entry.utxo.ringProgramId && !entry.dataHash && !entry.ringDataHash && entry.outputContext.tree === rpc.tree).sort((a, b) => a.utxo.amount === b.utxo.amount ? 0 : a.utxo.amount > b.utxo.amount ? -1 : 1);
        const selected = [];
        let total = 0n;
        for (const entry of eligible) { if (total >= amount) break; selected.push(entry); total += entry.utxo.amount; }
        if (total < amount) throw new Error('Deposit enough of this test token into your private balance first.');
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
