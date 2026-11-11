import test from 'node:test';
import assert from 'node:assert/strict';
import { createWithdrawalStore } from './withdrawal-recovery.mjs';

const owner='11111111111111111111111111111111';
const record={owner,recipient:owner,network:'devnet',mint:owner,amountAtomic:'50000',lastValidBlockHeight:'100',txSignature:'signature',signedTransaction:'signed-bytes'};
function memory(){const data=new Map();return {data,getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};}

test('withdrawal checkpoint survives reload and refuses a second transaction until finalized',()=>{
  const storage=memory(),store=createWithdrawalStore(storage,{owner,network:'devnet'});store.checkAvailable();
  store.save({...record,transactionViewingKey:'must-not-persist',derivationSeed:'must-not-persist'});
  const reloaded=createWithdrawalStore(storage,{owner,network:'devnet'});
  assert.deepEqual(reloaded.read(),record);assert.equal(JSON.stringify([...storage.data.values()]).includes('must-not-persist'),false);
  assert.throws(()=>reloaded.save({...record,txSignature:'another-signature'}),/saved withdrawal/);
  assert.throws(()=>reloaded.settle(record,{signature:record.txSignature,status:'confirmed'}),/finalized chain evidence/);
  assert.equal(createWithdrawalStore(storage,{owner,network:'mainnet-beta'}).read(),null);
  reloaded.settle(record,{signature:record.txSignature,status:'expired',finalized:true});assert.equal(reloaded.read(),null);
});

test('unavailable storage blocks pre-broadcast checkpoint and never reports a durable save',()=>{
  const storage=memory();storage.setItem=()=>{throw Error('quota');};
  const store=createWithdrawalStore(storage,{owner,network:'devnet'});
  assert.throws(()=>store.checkAvailable(),/Nothing has been sent/);
  let broadcast=false;
  assert.throws(()=>{store.save(record);broadcast=true;},/could not be saved/);
  assert.equal(broadcast,false);
});
