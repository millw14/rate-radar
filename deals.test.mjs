import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_DEALS, validDeal } from './deals.mjs';

test('all sample deals are explicitly fictional with valid terms', () => {
  assert.equal(new Set(SAMPLE_DEALS.map(d => d.id)).size, SAMPLE_DEALS.length);
  for (const deal of SAMPLE_DEALS) {
    assert.equal(validDeal(deal), true);
    assert.equal(deal.synthetic, true);
  }
});

test('invalid stored money, dates and workflow states cannot enter the desk', () => {
  const base=SAMPLE_DEALS[0];
  for(const amount of [NaN,Infinity,0,-1,10000001,'1250']) assert.equal(validDeal({...base,amount}),false);
  for(const deadline of ['not-a-date','2026-99-99',null]) assert.equal(validDeal({...base,deadline}),false);
  for(const status of ['verified','pending',null]) assert.equal(validDeal({...base,status}),false);
});
