import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIENCE_BRACKETS,
  BENCHMARKS,
  CATEGORIES,
  DEFAULT_FILTERS,
  REGIONS,
  benchmarksToCSV,
  compareOffer,
  estimatePercentile,
  filterBenchmarks,
  findBenchmark,
} from './data.mjs';

test('every filter combination resolves to one explicitly synthetic cohort', () => {
  assert.equal(BENCHMARKS.length, 48);
  assert.equal(new Set(BENCHMARKS.map((row) => row.id)).size, 48);

  for (const category of CATEGORIES) {
    for (const audience of AUDIENCE_BRACKETS) {
      for (const region of REGIONS) {
        const rows = filterBenchmarks({ category, audience, region });
        assert.equal(rows.length, 1, `${category}, ${audience}, ${region}`);
        assert.equal(rows[0].synthetic, true);
        assert.match(rows[0].sourceLabel, /synthetic/i);
      }
    }
  }
});

test('cohort summaries have ordered positive quantiles and usable sample counts', () => {
  for (const cohort of BENCHMARKS) {
    const quantiles = [cohort.min, cohort.p25, cohort.median, cohort.p75, cohort.max];
    assert(quantiles.every(Number.isFinite), cohort.id);
    assert(quantiles.every((value, index) => value > 0 && (index === 0 || value > quantiles[index - 1])), cohort.id);
    assert(Number.isInteger(cohort.sampleSize) && cohort.sampleSize >= 20, cohort.id);
    assert.deepEqual(cohort.range, [cohort.p25, cohort.p75]);
    assert.equal(cohort.currency, 'USD');
    assert.equal(cohort.history.at(-1).median, cohort.median);
  }
});

test('percentile anchors and values beyond the synthetic distribution are bounded', () => {
  for (const cohort of BENCHMARKS) {
    assert.equal(estimatePercentile(cohort.min / 2, cohort), 0);
    assert.equal(estimatePercentile(cohort.min, cohort), 0);
    assert.equal(estimatePercentile(cohort.p25, cohort), 25);
    assert.equal(estimatePercentile(cohort.median, cohort), 50);
    assert.equal(estimatePercentile(cohort.p75, cohort), 75);
    assert.equal(estimatePercentile(cohort.max, cohort), 100);
    assert.equal(estimatePercentile(cohort.max * 2, cohort), 100);
  }
});

test('percentiles interpolate between anchors and never decrease as an offer rises', () => {
  const cohort = findBenchmark();
  assert.equal(estimatePercentile((cohort.p25 + cohort.median) / 2, cohort), 38);
  assert.equal(estimatePercentile((cohort.median + cohort.p75) / 2, cohort), 63);

  let previous = -1;
  for (let step = 0; step <= 100; step += 1) {
    const percentile = estimatePercentile(cohort.max * 1.2 * step / 100, cohort);
    assert(percentile >= previous && percentile >= 0 && percentile <= 100);
    previous = percentile;
  }
  assert.equal(estimatePercentile(NaN, cohort), null);
  assert.equal(estimatePercentile(Infinity, cohort), null);
  assert.equal(estimatePercentile(500, null), null);
});

test('offer comparison includes the quartile boundaries and reports median direction', () => {
  const cohort = findBenchmark();
  assert.equal(compareOffer(cohort.p25 - 1, cohort).status, 'below');
  assert.equal(compareOffer(cohort.p25, cohort).status, 'within');
  assert.equal(compareOffer(cohort.p75, cohort).status, 'within');
  assert.equal(compareOffer(cohort.p75 + 1, cohort).status, 'above');

  const medianOffer = compareOffer(String(cohort.median), cohort);
  assert.equal(medianOffer.valid, true);
  assert.equal(medianOffer.relation, 'at');
  assert.equal(medianOffer.percentile, 50);
  assert.equal(medianOffer.differenceFromMedian, 0);
  assert.equal(medianOffer.medianDeltaPercent, 0);
  assert.equal(medianOffer.synthetic, true);
  assert.match(medianOffer.explanation, /demo median/);
  assert.match(medianOffer.caveat, /scope/i);
  assert.deepEqual(medianOffer.typicalRange, [cohort.p25, cohort.p75]);

  assert.equal(compareOffer(cohort.median / 2, cohort).medianDeltaPercent, -50);
  assert.equal(compareOffer(cohort.median * 1.5, cohort).medianDeltaPercent, 50);
});

test('invalid amounts and missing cohorts return actionable errors without a score', () => {
  const cohort = findBenchmark();
  for (const value of ['', '   ', null, undefined, -1, 0, NaN, Infinity, -Infinity, 'abc', true, false, [], {}]) {
    const result = compareOffer(value, cohort);
    assert.equal(result.valid, false, `Invalid amount: ${String(value)}`);
    assert.equal(typeof result.message, 'string');
    assert.equal(result.percentile, undefined);
  }
  assert.equal(compareOffer('850.50', cohort).valid, true);
  assert.equal(compareOffer(850, null).valid, false);
});

test('filters support defaults, partial selections, case, spaces, and dash normalization', () => {
  const defaultCohort = findBenchmark();
  assert.equal(defaultCohort.category, DEFAULT_FILTERS.category);
  assert.equal(defaultCohort.audience, DEFAULT_FILTERS.audience);
  assert.equal(defaultCohort.region, DEFAULT_FILTERS.region);
  assert.equal(filterBenchmarks().length, 48);
  assert.equal(filterBenchmarks({ category: 'All', audience: '', region: ' all ' }).length, 48);
  assert.equal(filterBenchmarks({ category: CATEGORIES[0] }).length, 12);

  const normalized = findBenchmark({ category: '  x post/THREAD ', audienceBracket: '50k-100k', region: ' GLOBAL ' });
  assert.equal(normalized.id, defaultCohort.id);
  assert.equal(filterBenchmarks({ audience: '50k—100k', region: 'africa' }).length, 4);
  assert.equal(findBenchmark({ category: 'Unknown category' }), null);
  assert.equal(filterBenchmarks({ region: 'Unknown region' }).length, 0);
});

test('CSV exports preserve synthetic labels and include only selected rows', () => {
  const rows = filterBenchmarks({ category: CATEGORIES[0], region: 'Africa' });
  const csv = benchmarksToCSV(rows);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, rows.length + 1);
  assert.match(lines[0], /Synthetic sample count/);
  assert.match(lines[0], /Illustrative period change/);
  for (const line of lines.slice(1)) {
    assert.match(line, /Synthetic demo cohort/);
    assert.match(line, /Africa/);
    assert.doesNotMatch(line, /North America/);
  }
  assert.equal(benchmarksToCSV().split('\r\n').length, 49);
  assert.equal(benchmarksToCSV([]).split('\r\n').length, 1);
});

test('CSV safely quotes text containing commas and double quotes', () => {
  const row = { ...findBenchmark(), scope: 'One "hero" post, with a follow-up' };
  const csv = benchmarksToCSV([row]);
  assert(csv.includes('"One ""hero"" post, with a follow-up"'));
});
