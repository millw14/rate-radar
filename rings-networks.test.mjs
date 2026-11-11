import test from 'node:test';
import assert from 'node:assert/strict';
import { SignedTeePolicy } from '@heliuslabs/spr/client';
import { getNetworkConfig } from './rings-networks.mjs';

test('network allowlist defaults to devnet and rejects aliases, endpoints, and prototype names', () => {
  assert.equal(getNetworkConfig().network, 'devnet');
  for (const value of ['mainnet', 'testnet', 'https://attacker.test', '__proto__', 'constructor', null, {}]) assert.throws(() => getNetworkConfig(value));
  for (const name of ['devnet', 'mainnet-beta']) {
    const chain = getNetworkConfig(name);
    assert(Object.isFrozen(chain));
    assert.throws(() => { chain.rpcUrl = 'https://attacker.test'; });
    assert.equal(new URL(chain.rpcUrl).protocol, 'https:');
    assert.equal(chain.genesisHash.length, 44);
    assert.doesNotThrow(() => SignedTeePolicy.forNetwork(chain.policyNetwork));
  }
});

test('mainnet configuration binds canonical mint, wallet chain, upstream, and policy together', () => {
  const chain = getNetworkConfig('mainnet-beta');
  assert.equal(chain.walletChain, 'solana:mainnet');
  assert.equal(chain.rpcUrl, 'https://mainnet.helius-rpc.com/');
  assert.equal(chain.policyNetwork, 'mainnet');
  assert.equal(chain.policyURL, 'https://d3gbdb0egjwcw9.cloudfront.net/tee-policy/mainnet.json');
  assert.equal(chain.usdcMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(chain.genesisHash, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.equal(chain.explorerCluster, null);
  assert.notEqual(chain.usdcMint, getNetworkConfig('devnet').usdcMint);
});
