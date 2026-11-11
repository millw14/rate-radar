import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentMemo } from './rings-protocol.mjs';
import { getNetworkConfig } from './rings-networks.mjs';

const intent = { id: 'intent', dealId: 'deal', termsHash: 'hash', memo: 'nonce', mint: 'mint', payerWallet: 'payer', recipientWallet: 'recipient', amountAtomic: '1', network: 'devnet' };

test('payment memo preserves existing devnet wire and accepts explicit mainnet', () => {
  const expected = '{"v":1,"app":"rate-radar","intent":"intent","deal":"deal","terms":"hash","challenge":"nonce"}';
  assert.equal(new TextDecoder().decode(paymentMemo(intent)), expected);
  assert.equal(new TextDecoder().decode(paymentMemo({ ...intent, network: 'mainnet-beta' })), expected);
});

test('payment memo refuses omitted or unsupported clusters', () => {
  for (const network of [undefined, null, 'mainnet', 'testnet', 'https://example.com']) {
    assert.throws(() => paymentMemo({ ...intent, network }));
  }
});

test('production and development configurations remain immutable and disjoint', () => {
  const devnet = getNetworkConfig('devnet');
  const mainnet = getNetworkConfig('mainnet-beta');
  for (const key of ['rpcUrl', 'walletChain', 'policyNetwork', 'policyURL', 'genesisHash', 'usdcMint']) assert.notEqual(devnet[key], mainnet[key]);
  assert.throws(() => { mainnet.rpcUrl = devnet.rpcUrl; });
  for (const network of ['__proto__', 'constructor', 'localnet', null, {}]) assert.throws(() => getNetworkConfig(network));
});
