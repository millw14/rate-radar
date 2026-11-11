import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { getAddressDecoder, getTransactionDecoder, getTransactionEncoder, getSignatureFromTransaction, getBase58Decoder } from '@solana/kit';
import { compileUnsignedTransaction, associatedTokenAddress } from '@heliuslabs/spr/internal';
import { SHIELDED_POOL_PROGRAM_ID, InstructionTag, SPL_TOKEN_PROGRAM_ID } from '@heliuslabs/spr/interface';
import { createRingsWallet, createProxyFetch, validateWithdrawalCheckpoint } from './rings-client.mjs';
import { toBase64, fromBase64, SOL_MINT } from './rings-protocol.mjs';
import { getNetworkConfig } from './rings-networks.mjs';

const seed = new Uint8Array(32).fill(4);
const publicKey = ed25519.getPublicKey(seed);
const owner = getAddressDecoder().decode(publicKey);

function provider({ supportsV1 = true, alterMessage = false, network = 'devnet' } = {}) {
  const account = { address: owner, publicKey, chains: [getNetworkConfig(network).walletChain], features: ['solana:signMessage', 'solana:signTransaction'] };
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
  await assert.rejects(() => wallet.payIntent({network:'mainnet-beta'},{beforeBroadcast:()=>{}}), /another Solana network/);
  await assert.rejects(() => wallet.withdraw({amountAtomic:'1'}), /durable withdrawal checkpoint/);
  await assert.rejects(() => wallet.withdraw({amountAtomic:'1',recipient:SOL_MINT},{beforeBroadcast:()=>{}}), /connected wallet/);
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
  await assert.rejects(() => wallet.withdraw({amountAtomic:'1'}), /version 1/);
});

test('mainnet wallets use only their selected RPC, chain, and signed TEE policy', async () => {
  const selected=getNetworkConfig('mainnet-beta'), calls=[];
  const forward=createProxyFetch('/api/rpc',async url=>{calls.push(String(url));return new Response('ok');},'mainnet-beta');
  await forward(selected.rpcUrl);
  await forward(selected.policyURL);
  assert.equal(calls[1],selected.policyURL);
  await assert.rejects(()=>forward(getNetworkConfig().rpcUrl),/Unexpected/);
  await assert.rejects(()=>forward(getNetworkConfig().policyURL),/Unexpected/);
  assert.throws(()=>createRingsWallet({network:'testnet'}),/Unsupported/);
  const wallet=createRingsWallet({provider:provider({network:'mainnet-beta'}),network:'mainnet-beta'});
  assert.equal((await wallet.connect()).network,'mainnet-beta');
  await wallet.disconnect();
});

// Signed wire fixture for the public withdrawal prefix. Proof validity belongs
// to the chain; these tests exercise recovery without a prover or new signing.
function withdrawalRecord({mint=SOL_MINT,recipientToken}={}){
  const data=new Uint8Array(69);data[0]=InstructionTag.transact;data[58]=1;data[59]=mint===SOL_MINT?1:3;new DataView(data.buffer).setBigUint64(60,50000n,true);
  const accounts=mint===SOL_MINT?[{address:owner,role:3}]:[{address:owner,role:3},...[owner,mint,owner,recipientToken,SPL_TOKEN_PROGRAM_ID].map(address=>({address,role:0}))];
  const unsigned=compileUnsignedTransaction({feePayer:owner,lifetime:{blockhash:getBase58Decoder().decode(new Uint8Array(32).fill(7)),lastValidBlockHeight:100n},computeUnitLimit:450000,instructions:[{programAddress:SHIELDED_POOL_PROGRAM_ID,accounts,data}]});
  const signed={...unsigned,signatures:{...unsigned.signatures,[owner]:ed25519.sign(unsigned.messageBytes,seed)}};
  return {network:'devnet',owner,recipient:owner,mint,amountAtomic:'50000',lastValidBlockHeight:'100',txSignature:getSignatureFromTransaction(signed),signedTransaction:toBase64(getTransactionEncoder().encode(signed))};
}

test('saved withdrawal validates the actual signed amount, recipient, owner, and network',async()=>{
  const record=withdrawalRecord();
  await validateWithdrawalCheckpoint(record,{owner,network:'devnet'});
  await assert.rejects(()=>validateWithdrawalCheckpoint({...record,amountAtomic:'50001'},{owner,network:'devnet'}),/amount or asset/);
  await assert.rejects(()=>validateWithdrawalCheckpoint({...record,recipient:SOL_MINT},{owner,network:'devnet'}),/wallet or network/);
  await assert.rejects(()=>validateWithdrawalCheckpoint(record,{owner,network:'mainnet-beta'}),/wallet or network/);
  const wire=fromBase64(record.signedTransaction);wire[10]^=1;
  await assert.rejects(()=>validateWithdrawalCheckpoint({...record,signedTransaction:toBase64(wire)},{owner,network:'devnet'}),/signed transaction|signature/);
  const mint=getNetworkConfig().usdcMint,recipientToken=await associatedTokenAddress(owner,mint);
  await validateWithdrawalCheckpoint(withdrawalRecord({mint,recipientToken}),{owner,network:'devnet'});
  await assert.rejects(()=>validateWithdrawalCheckpoint(withdrawalRecord({mint,recipientToken:SOL_MINT}),{owner,network:'devnet'}),/token or recipient/);
});

test('withdrawal recovery resends identical bytes without signing and locks new spends until finalized evidence',async()=>{
  const originalFetch=globalThis.fetch, record=withdrawalRecord(),sent=[];
  let found=null, valid=true;
  globalThis.fetch=async(_url,init)=>{
    const request=JSON.parse(init.body);let result;
    if(request.method==='getGenesisHash')result=getNetworkConfig().genesisHash;
    else if(request.method==='getSignatureStatuses')result={context:{slot:200},value:[found]};
    else if(request.method==='getSlot')result=190;
    else if(request.method==='isBlockhashValid')result={context:{slot:199},value:valid};
    else if(request.method==='getTransaction')result=null;
    else if(request.method==='sendTransaction'){sent.push(request.params[0]);result=record.txSignature;}
    else throw Error('Unexpected RPC '+request.method);
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  };
  try{
    const p=provider();p.features['solana:signTransaction'].signTransaction=()=>{throw Error('Recovery must not request another signature');};
    const wallet=createRingsWallet({provider:p});await wallet.connect();
    assert.equal((await wallet.reconcileWithdrawal(record)).status,'pending');assert.equal(sent.length,0);
    assert.equal((await wallet.reconcileWithdrawal(record,{rebroadcast:true})).status,'pending');assert.deepEqual(sent,[record.signedTransaction]);
    await assert.rejects(()=>wallet.payIntent({network:'devnet'},{beforeBroadcast:()=>{}}),/saved withdrawal/);
    await assert.rejects(()=>wallet.withdraw({amountAtomic:'1'},{beforeBroadcast:()=>{}}),/saved withdrawal/);
    found={confirmationStatus:'confirmed',err:null,slot:198};
    assert.equal((await wallet.reconcileWithdrawal(record)).status,'pending');
    found=null;valid=true;
    assert.equal((await wallet.reconcileWithdrawal(record)).status,'pending');
    valid=false;const expired=await wallet.reconcileWithdrawal(record);assert.equal(expired.status,'expired');assert.equal(expired.finalized,true);
    found={confirmationStatus:'finalized',err:{InstructionError:[0,'Custom']},slot:200};
    assert.equal((await wallet.reconcileWithdrawal(record)).status,'failed');
    found={confirmationStatus:'finalized',err:null,slot:200};
    assert.equal((await wallet.reconcileWithdrawal(record)).status,'confirmed');
    assert.equal(sent.length,1);assert.equal(p.messages.length,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('edited withdrawal expiry metadata cannot bypass finalized and confirmed chain evidence',async()=>{
  const originalFetch=globalThis.fetch;
  // The signature is genuine and the original builder lifetime was 100. This
  // field is deliberately edited without touching the signed V1 wire.
  const record={...withdrawalRecord(),lastValidBlockHeight:'0'};
  let scenario={},statusCalls=0,calls=[];
  globalThis.fetch=async(_url,init)=>{
    const request=JSON.parse(init.body);calls.push(request);let result;
    if(request.method==='getGenesisHash')result=getNetworkConfig().genesisHash;
    else if(request.method==='getSlot'){assert.equal(request.params?.[0]?.commitment??'finalized','finalized');result=scenario.floor??100;}
    else if(request.method==='getSignatureStatuses'){
      assert.equal(request.params[1].searchTransactionHistory,true);
      result=statusCalls++===0?(scenario.initial??{context:{slot:200},value:[null]}):(scenario.history??{context:{slot:200},value:[null]});
    }else if(request.method==='isBlockhashValid'){
      const options=request.params[1];
      if((options.commitment??'finalized')==='finalized'){
        // Initial signature context is 200, ahead of finality. Requiring that
        // as this floor would falsely prevent every expiry resolution.
        assert.equal(options.minContextSlot,100);
        result=scenario.finalized??{context:{slot:120},value:false};
      }else{assert.equal(options.commitment,'confirmed');assert.equal(options.minContextSlot,120);result=scenario.confirmed??{context:{slot:180},value:false};}
    }else if(request.method==='getTransaction'){
      assert.equal(request.params[0],record.txSignature);assert.equal(request.params[1].commitment??'finalized','finalized');assert.equal(request.params[1].encoding??'json','json');assert.equal(request.params[1].maxSupportedTransactionVersion,1);
      result=scenario.transaction??null;
    }else throw Error('Unexpected recovery RPC '+request.method);
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  };
  try{
    const wallet=createRingsWallet({provider:provider()});await wallet.connect();
    const cases=[
      ['finality stall',{confirmed:{context:{slot:180},value:true}}],
      ['missing finalized validity',{finalized:{context:{slot:120}}}],
      ['null finalized validity',{finalized:{context:{slot:120},value:null}}],
      ['stale finalized bank',{finalized:{context:{slot:99},value:false}}],
      ['missing confirmed validity',{confirmed:{context:{slot:180}}}],
      ['stale confirmed bank',{confirmed:{context:{slot:119},value:false}}],
      ['stale history',{history:{context:{slot:179},value:[null]}}],
      ['empty history',{history:{context:{slot:200},value:[]}}],
      ['multiple history entries',{history:{context:{slot:200},value:[null,null]}}],
      ['false history entry',{history:{context:{slot:200},value:[false]}}],
      ['transaction present',{transaction:{slot:200}}],
      ['initial status missing',{initial:{context:{slot:200},value:[]}}],
      ['finalized status missing error',{initial:{context:{slot:200},value:[{slot:180,confirmationStatus:'finalized'}]}}],
      ['finalized status false error',{initial:{context:{slot:200},value:[{slot:180,confirmationStatus:'finalized',err:false}]}}],
    ];
    for(const [name,value]of cases){
      scenario=value;statusCalls=0;calls=[];
      assert.equal((await wallet.reconcileWithdrawal(record)).status,'pending',name);
      await assert.rejects(()=>wallet.withdraw({amountAtomic:'1'},{beforeBroadcast:()=>{}}),/saved withdrawal/,name);
      assert.equal(calls.some(call=>call.method==='sendTransaction'),false,name);
    }
    scenario={};statusCalls=0;calls=[];
    const result=await wallet.reconcileWithdrawal(record);
    assert.equal(result.status,'expired');assert.equal(result.finalized,true);
    assert.deepEqual(calls.map(call=>call.method),['getSignatureStatuses','getSlot','isBlockhashValid','isBlockhashValid','getSignatureStatuses','getTransaction']);
    assert.equal(calls.some(call=>call.method==='getBlockHeight'),false);
  }finally{globalThis.fetch=originalFetch;}
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
