import assert from 'node:assert/strict';
import { createSprClient, SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr';
import { SignedTeePolicy } from '@heliuslabs/spr/client';
import { splAssetRegistryAddress, decodeSplAssetRegistryAccount } from '@heliuslabs/spr/internal';
import { address } from '@solana/kit';
import { createProxyFetch } from '../rings-client.mjs';
import { DEVNET_GENESIS_HASH } from '../rings-protocol.mjs';

// Read-only integration check through the running app, using its server secret.
// Link a devnet wallet in the local UI first. No wallet keys or test funds needed.
const app = new URL(process.env.RATE_RADAR_URL || 'http://127.0.0.1:4173');
if (!['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)) {
  throw new Error('Run this check against your local Worker. Hosted access requires a signed-in browser.');
}

try {
  const configResponse = await fetch(new URL('/api/config', app));
  assert(configResponse.ok, 'The local API must be running.');
  const config = await configResponse.json();
  assert.equal(config.network, 'devnet', 'The app must be configured for devnet.');
  assert(config.rpcEnabled && config.wallet, 'Configure the server and connect a wallet in the local app first.');
  const transport = createProxyFetch(new URL('/api/rpc', app).href, (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (new URL(url).origin === app.origin) headers.set('Origin', app.origin);
    return fetch(url, { ...init, headers });
  });
  const client = await createSprClient({
    solanaRpcUrl: 'https://devnet.helius-rpc.com',
    fetch: transport,
    proverTee: SignedTeePolicy.forNetwork('devnet'),
    commitment: 'confirmed',
  });
  assert.equal(await client.solanaRpc.getGenesisHash().send(), DEVNET_GENESIS_HASH);
  console.log('PASS: App proxy reaches Solana devnet.');
  const mint = address(config.mint);
  const registry = await client.getAccount(await splAssetRegistryAddress(mint));
  assert(registry, 'Configured USDC must have a Rings registry.');
  assert.equal(registry.owner, SHIELDED_POOL_PROGRAM_ID);
  assert.equal(decodeSplAssetRegistryAccount(registry.data).mint, mint);
  console.log('PASS: Configured USDC is registered with Rings.');
  await client.attestProver();
  const report = await client.checkProverProvingKeys();
  assert(report.keys.length > 0, 'The prover must publish matching keys.');
  console.log(`PASS: Encrypted prover attestation and ${report.keys.length} pinned keys verified through the app.`);
  console.log('Read-only checks complete. A funded transaction is still required to verify settlement.');
} catch (error) {
  console.error(`Live Rings check failed: ${error.message}`);
  process.exitCode = 1;
}
