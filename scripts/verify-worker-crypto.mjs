import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const temp=await mkdtemp(join(tmpdir(),'rate-radar-worker-crypto-'));
let worker;
try {
  await build({
    stdin:{contents:`import {initializePoseidon,solanaOwnerIdentity} from '@heliuslabs/spr/keypair'; export default {async fetch(){await initializePoseidon();return new Response([...solanaOwnerIdentity(new Uint8Array(32).fill(7))].map(v=>v.toString(16).padStart(2,'0')).join(''));}};`,resolveDir:process.cwd()},
    outfile:join(temp,'index.js'),bundle:true,format:'esm',platform:'node',conditions:['workerd','worker','browser'],target:'es2022',external:['node:*'],
    plugins:[{name:'worker-hasher',setup(b){
      b.onResolve({filter:/^@lightprotocol\/hasher\.rs$/},()=>({path:resolve('scripts/hasher-worker.mjs')}));
      b.onResolve({filter:/^rate-radar:hasher-wasm$/},()=>({path:'./hasher.wasm',external:true}));
    }}],
  });
  await copyFile('node_modules/@lightprotocol/hasher.rs/dist/light_wasm_hasher_bg.wasm',join(temp,'hasher.wasm'));
  worker=new Miniflare(convertV4MiniflareOptions({name:'rate-radar-crypto-check',modulesRoot:temp,modules:[{type:'ESModule',path:join(temp,'index.js')},{type:'CompiledWasm',path:join(temp,'hasher.wasm')}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat']}));
  const response=await worker.dispatchFetch('http://localhost/');
  assert.equal(response.status,200);
  assert.equal(await response.text(),'2bf4fd85698f8d37fa3e7697d238c2ac0b112384abec6f80f7bd0d7d119d9163');
  console.log('PASS: Official Rings Poseidon hash matches in the Cloudflare Worker runtime.');
} finally {await worker?.dispose();await rm(temp,{recursive:true,force:true});}
