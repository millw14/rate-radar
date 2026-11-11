/**
 * Rate Radar prototype data. Every figure in this module is fictional.
 * These deterministic, synthetic cohorts demonstrate the product interaction;
 * they are not observed sponsorship prices, verified receipts, or recommendations.
 */

export const CATEGORIES = Object.freeze([
  'X post / thread',
  'YouTube integration',
  'Newsletter placement',
  'Instagram reel',
]);

export const AUDIENCE_BRACKETS = Object.freeze([
  '10k–50k',
  '50k–100k',
  '100k–500k',
]);

export const REGIONS = Object.freeze([
  'Global',
  'North America',
  'Europe',
  'Africa',
]);

export const DATA_NOTICE = 'Demo mode · All rates and sample counts are synthetic.';
export const COMPARISON_CAVEAT = 'Illustrative comparison within this demo cohort. Scope, engagement, usage rights, and exclusivity can change a rate.';
export const CURRENCY = 'USD';

const CATEGORY_PROFILES = [
  { base: 850, spread: 0.31, audienceMetric: 'followers', scope: 'One sponsored post or short thread', count: 126 },
  { base: 2400, spread: 0.35, audienceMetric: 'subscribers', scope: 'One 60–90 second video integration', count: 94 },
  { base: 1500, spread: 0.27, audienceMetric: 'subscribers', scope: 'One primary placement in one issue', count: 81 },
  { base: 1250, spread: 0.33, audienceMetric: 'followers', scope: 'One original sponsored reel', count: 118 },
];
const AUDIENCE_FACTORS = [0.46, 1, 2.7];
const REGION_FACTORS = [1, 1.24, 1.08, 0.68];
const ROUND_TO = 25;
const roundRate = (value) => Math.max(ROUND_TO, Math.round(value / ROUND_TO) * ROUND_TO);
const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, '');

/** All 48 combinations have independent, internally consistent demo summaries. */
export const BENCHMARKS = Object.freeze(CATEGORIES.flatMap((category, categoryIndex) =>
  AUDIENCE_BRACKETS.flatMap((audience, audienceIndex) =>
    REGIONS.map((region, regionIndex) => {
      const profile = CATEGORY_PROFILES[categoryIndex];
      const median = roundRate(profile.base * AUDIENCE_FACTORS[audienceIndex] * REGION_FACTORS[regionIndex]);
      const p25 = roundRate(median * (1 - profile.spread));
      const p75 = roundRate(median * (1 + profile.spread + 0.09));
      const min = Math.min(p25 - ROUND_TO, roundRate(median * 0.3));
      const max = Math.max(p75 + ROUND_TO, roundRate(median * 2.15));
      const sampleSize = Math.max(24, profile.count + (audienceIndex === 1 ? 37 : audienceIndex === 2 ? -25 : 14) - regionIndex * 13);
      const trend = Number((3.2 + categoryIndex * 1.4 + audienceIndex * 1.7 - regionIndex * 2.4).toFixed(1));
      const history = Object.freeze([0.91, 0.94, 0.925, 0.97, 1 / (1 + trend / 100), 1]
        .map((factor, index) => Object.freeze({ period: `Period ${index + 1}`, median: roundRate(median * factor) })));

      return Object.freeze({
        id: `cohort-${categoryIndex + 1}-${audienceIndex + 1}-${regionIndex + 1}`,
        category,
        audience,
        region,
        currency: CURRENCY,
        audienceMetric: profile.audienceMetric,
        scope: profile.scope,
        sampleSize,
        p25,
        median,
        p75,
        min,
        max,
        trend,
        trendLabel: 'Illustrative change from the previous period',
        range: Object.freeze([p25, p75]),
        history,
        synthetic: true,
        sourceLabel: 'Synthetic demo cohort',
        caveat: COMPARISON_CAVEAT,
      });
    }),
  ),
));

export const DEFAULT_FILTERS = Object.freeze({
  category: CATEGORIES[0],
  audience: AUDIENCE_BRACKETS[1],
  region: REGIONS[0],
});

/** Missing/empty/'all' filters match any value. Also accepts audienceBracket. */
export function filterBenchmarks(filters = {}) {
  const selected = { ...filters, audience: filters.audience ?? filters.audienceBracket };
  return BENCHMARKS.filter((row) => ['category', 'audience', 'region'].every((key) => {
    const value = normalize(selected[key]);
    return !value || value === 'all' || normalize(row[key]) === value;
  }));
}

/** Returns one exact cohort, or null for an unsupported selection. */
export function findBenchmark(filters = {}) {
  const selected = {
    ...DEFAULT_FILTERS,
    ...filters,
    audience: filters.audience ?? filters.audienceBracket ?? DEFAULT_FILTERS.audience,
  };
  return filterBenchmarks(selected)[0] ?? null;
}

/** A modeled percentile interpolated through summary quantiles, not a raw rank. */
export function estimatePercentile(amount, benchmark) {
  if (!benchmark || !Number.isFinite(amount)) return null;
  const points = [
    [benchmark.min, 0],
    [benchmark.p25, 25],
    [benchmark.median, 50],
    [benchmark.p75, 75],
    [benchmark.max, 100],
  ];
  if (amount <= points[0][0]) return 0;
  if (amount >= points[points.length - 1][0]) return 100;
  for (let index = 1; index < points.length; index += 1) {
    const [upperValue, upperPercentile] = points[index];
    if (amount <= upperValue) {
      const [lowerValue, lowerPercentile] = points[index - 1];
      const progress = (amount - lowerValue) / (upperValue - lowerValue);
      return Math.round(lowerPercentile + progress * (upperPercentile - lowerPercentile));
    }
  }
  return null;
}

/** Compare a positive USD offer against a synthetic cohort without overclaiming. */
export function compareOffer(rawAmount, benchmark) {
  const amount = !['string', 'number'].includes(typeof rawAmount) || (typeof rawAmount === 'string' && rawAmount.trim() === '') ? NaN : Number(rawAmount);
  if (rawAmount == null || !Number.isFinite(amount) || amount <= 0) {
    return { valid: false, message: 'Enter an offer greater than $0.' };
  }
  if (!benchmark) {
    return { valid: false, message: 'Choose a category, audience, and region to compare.' };
  }

  const differenceFromMedian = Math.round((amount - benchmark.median) * 100) / 100;
  const medianDeltaPercent = Math.round((differenceFromMedian / benchmark.median) * 100);
  const status = amount < benchmark.p25 ? 'below' : amount > benchmark.p75 ? 'above' : 'within';
  const relation = amount < benchmark.median ? 'below' : amount > benchmark.median ? 'above' : 'at';
  const percentile = estimatePercentile(amount, benchmark);
  const headlines = {
    below: 'Below the typical demo range',
    within: 'Within the typical demo range',
    above: 'Above the typical demo range',
  };
  const explanation = differenceFromMedian === 0
    ? `Your offer matches the ${formatCurrency(benchmark.median)} demo median.`
    : `Your offer is ${formatCurrency(Math.abs(differenceFromMedian))} ${relation} the ${formatCurrency(benchmark.median)} demo median.`;

  return Object.freeze({
    valid: true,
    amount,
    percentile,
    percentileLabel: 'Estimated percentile in the synthetic distribution',
    relation,
    status,
    headline: headlines[status],
    explanation,
    differenceFromMedian,
    medianDeltaPercent,
    suggestedRange: benchmark.range,
    typicalRange: benchmark.range,
    sampleSize: benchmark.sampleSize,
    benchmarkId: benchmark.id,
    caveat: COMPARISON_CAVEAT,
    synthetic: true,
  });
}

export function formatCurrency(amount, options = {}) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: CURRENCY,
    maximumFractionDigits: 0,
    ...options,
  }).format(amount);
}

/** Standalone CSV export; every exported row retains its synthetic-data label. */
export function benchmarksToCSV(rows = BENCHMARKS) {
  const fields = [
    ['Data source', 'sourceLabel'],
    ['Category', 'category'],
    ['Audience bracket', 'audience'],
    ['Region', 'region'],
    ['Currency', 'currency'],
    ['Synthetic sample count', 'sampleSize'],
    ['25th percentile', 'p25'],
    ['Median', 'median'],
    ['75th percentile', 'p75'],
    ['Synthetic minimum', 'min'],
    ['Synthetic maximum', 'max'],
    ['Illustrative period change (%)', 'trend'],
    ['Scope', 'scope'],
  ];
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [fields.map(([title]) => quote(title)).join(','), ...rows.map((row) => fields.map(([, key]) => quote(row[key])).join(','))].join('\r\n');
}
