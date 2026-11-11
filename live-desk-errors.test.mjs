import test from 'node:test';
import assert from 'node:assert/strict';
import { userFacingError } from './live-desk.mjs';

test('opaque Solana transport diagnostics never reach the interface', () => {
  const diagnostic = new Error('Solana error #8100002; Decode this error by running npx @solana/errors decode -- 8100002 eyJhcGlLZXkiOiJzZWNyZXQifQ==');
  assert.equal(userFacingError(diagnostic), 'The Rings connection is temporarily unavailable. Please try again in a moment.');
  assert.doesNotMatch(userFacingError(diagnostic), /npx|decode|eyJ|8100002/);
});

test('structured and nested RPC failures use actionable connection guidance', () => {
  const error = new Error('Request failed', {cause: {context: {__code: 8100002}}});
  assert.equal(userFacingError(error), 'The Rings connection is temporarily unavailable. Please try again in a moment.');
  assert.equal(userFacingError(Object.assign(new Error('Upstream failure'), {code: 'RPC_UPSTREAM_ERROR'})), userFacingError(error));
  assert.equal(userFacingError(new TypeError('Failed to fetch')), 'Could not reach the service. Check your connection and try again.');
});

test('transport cleanup retains the instruction to reconcile a payment first', () => {
  const error = new Error('Solana error #8100002; npx @solana/errors decode -- 8100002 encoded. No new payment is sent automatically. Reopen the deal to check settlement before retrying.');
  assert.equal(userFacingError(error), 'The Rings connection is unavailable. Reopen the deal to check settlement before retrying.');
});

test('specific application validation and review instructions stay intact', () => {
  for (const message of [
    'This wallet cannot sign Solana version 1 transactions. Connect a compatible wallet to pay with Rings.',
    'Deposit enough of this test token into your private balance first.',
    'The Rings connection and secure reconciliation must be configured before payment.',
    'Needs review: this agreement cannot send a replacement payment. Confirm the outcome with your counterparty.',
  ]) {
    assert.equal(userFacingError(Object.assign(new Error(message), {code: 'PAYMENTS_NOT_CONFIGURED', status: 503})), message);
  }
});

test('unknown SDK decode instructions and empty errors have a safe fallback', () => {
  assert.equal(userFacingError(new Error('Solana error #999999; npx @solana/errors decode -- 999999 eyJ9')), 'The Rings request could not be completed. Please try again.');
  assert.equal(userFacingError(null), 'The request could not be completed. Please try again.');
  assert.equal(userFacingError({message: {diagnostic: 'internal'}}), 'The request could not be completed. Please try again.');
});
