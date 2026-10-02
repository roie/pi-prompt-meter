import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addRowsToTrendDataset,
  aggregateTrendDataset,
  aggregateTrendDatasetSummary,
  aggregateTrendSummary,
  aggregateTrends,
  createTrendDataset,
  scaleTrendActivity,
  scaleTrendBars,
  trendGroupingLabel,
} from '../src/trends.ts';
import type { PromptHistoryRow } from '../src/history/types.ts';

function row(startedAt: number, overrides: Partial<PromptHistoryRow> = {}): PromptHistoryRow {
  return {
    sessionId: 's', sessionPath: '/s', userEntryId: String(startedAt), prompt: 'p',
    startedAt, endedAt: startedAt + 1000, durationMs: 1000, durationApproximate: false,
    input: 10, output: 2, cacheRead: 20, cacheWrite: 0, cost: 0.01,
    billing: 'metered', outcome: 'completed', exact: true, ...overrides,
  };
}

const now = new Date(2026, 8, 30, 12, 0, 0);

test('7d and 30d use daily buckets ending on the current local date', () => {
  const seven = aggregateTrends([], 'time', '7d', now);
  const thirty = aggregateTrends([], 'time', '30d', now);
  assert.equal(seven.length, 7);
  assert.equal(thirty.length, 30);
  assert.equal(seven.at(-1)?.key, '2026-09-30');
  assert.equal(thirty.at(-1)?.key, '2026-09-30');
});

test('3mo and 6mo use Monday-Sunday weekly buckets', () => {
  for (const range of ['3mo', '6mo'] as const) {
    const buckets = aggregateTrends([], 'time', range, now);
    assert.ok(buckets.length > 10);
    for (const bucket of buckets) assert.equal(new Date(bucket.startedAt).getDay(), 1);
  }
});

test('1y and all use local calendar monthly buckets', () => {
  const oneYear = aggregateTrends([], 'time', '1y', now);
  assert.equal(oneYear.length, 12);
  assert.equal(oneYear[0]?.key, '2025-10');
  assert.equal(oneYear.at(-1)?.key, '2026-09');

  const rows = [row(new Date(2026, 3, 10).getTime())];
  const all = aggregateTrends(rows, 'time', 'all', now);
  assert.equal(all[0]?.key, '2026-04');
  assert.equal(all.at(-1)?.key, '2026-09');
});

test('input output cache and cost stay separate', () => {
  const r = row(new Date(2026, 8, 30, 10).getTime(), { input: 100, output: 7, cacheRead: 900, cost: 0.42 });
  const last = (metric: 'input' | 'output' | 'cache' | 'cost') => aggregateTrends([r], metric, '7d', now).at(-1)?.value;
  assert.equal(last('input'), 100);
  assert.equal(last('output'), 7);
  assert.equal(last('cache'), 900);
  assert.equal(last('cost'), 0.42);
});

test('time propagates approximation and omits missing durations', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  const rows = [
    row(day, { durationMs: 2_000, durationApproximate: false }),
    row(day + 1000, { durationMs: 3_000, durationApproximate: true }),
    row(day + 2000, { durationMs: undefined, durationApproximate: false }),
  ];
  const bucket = aggregateTrends(rows, 'time', '7d', now).at(-1)!;
  assert.equal(bucket.value, 5_000);
  assert.equal(bucket.approximate, true);
});

test('a prompt crossing midnight or month contributes wholly to its start bucket', () => {
  const sep30 = new Date(2026, 8, 30, 23, 59).getTime();
  const r = row(sep30, { endedAt: new Date(2026, 9, 1, 0, 30).getTime(), durationMs: 31 * 60_000, input: 77 });
  const daily = aggregateTrends([r], 'input', '7d', new Date(2026, 9, 1, 12));
  assert.equal(daily.find((b) => b.key === '2026-09-30')?.value, 77);
  assert.equal(daily.find((b) => b.key === '2026-10-01')?.value, 0);
  const monthly = aggregateTrends([r], 'input', 'all', new Date(2026, 9, 1, 12));
  assert.equal(monthly.find((b) => b.key === '2026-09')?.value, 77);
});

test('relative bars scale the largest value to max width and keep zero empty', () => {
  assert.deepEqual(scaleTrendBars([
    { key: 'a', startedAt: 0, value: 0, approximate: false },
    { key: 'b', startedAt: 1, value: 5, approximate: false },
    { key: 'c', startedAt: 2, value: 10, approximate: false },
  ], 20), [0, 10, 20]);
});

test('unknown reconstructed metrics do not become zero-valued usage', () => {
  const day = new Date(2026,8,30,10).getTime();
  const r = row(day, { input: 999, known: { input:false, output:true, cacheRead:true, cacheWrite:true, cost:true } });
  assert.equal(aggregateTrends([r], 'input', '7d', now).at(-1)?.value, 0);
});


test('trend aggregation consumes iterable input only once, including All', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  let iterations = 0;
  const rows: Iterable<PromptHistoryRow> = {
    [Symbol.iterator]() {
      iterations++;
      if (iterations > 1) throw new Error('iterable was consumed more than once');
      return [row(day, { input: 123 })][Symbol.iterator]();
    },
  };

  const buckets = aggregateTrends(rows, 'input', 'all', now);

  assert.equal(iterations, 1);
  assert.equal(buckets.at(-1)?.value, 123);
});

test('All begins at the earliest contributing month even when that metric is unknown there', () => {
  const april = new Date(2026, 3, 10, 10).getTime();
  const september = new Date(2026, 8, 30, 10).getTime();
  const rows = [
    row(april, {
      input: 999,
      known: { input: false, output: true, cacheRead: true, cacheWrite: true, cost: true },
    }),
    row(september, { input: 5 }),
  ];

  const buckets = aggregateTrends(rows, 'input', 'all', now);

  assert.equal(buckets[0]?.key, '2026-04');
  assert.equal(buckets[0]?.value, 0);
  assert.equal(buckets.at(-1)?.value, 5);
});

test('streaming trend dataset keeps known contributions when another row is unknown', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  const dataset = createTrendDataset();
  addRowsToTrendDataset(dataset, [
    row(day, { input: 100 }),
    row(day + 1_000, {
      input: 999,
      known: { input: false, output: true, cacheRead: true, cacheWrite: true, cost: true },
    }),
  ]);

  assert.equal(aggregateTrendDataset(dataset, 'input', '7d', now).at(-1)?.value, 100);
});

test('streaming trend dataset omits days with no known Time instead of manufacturing zero-known duration', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  const dataset = createTrendDataset();
  addRowsToTrendDataset(dataset, [row(day, { durationMs: undefined })]);

  const point = [...dataset.values()][0]!;
  assert.equal(point.durationMs, undefined);
});


test('summary trends keep date as the unit and aggregate all metrics together', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  const buckets = aggregateTrendSummary([
    row(day, { durationMs: 2_000, input: 100, output: 7, cacheRead: 900, cost: 0.42 }),
    row(day + 1_000, { durationMs: 3_000, durationApproximate: true, input: 50, output: 3, cacheRead: 100, cost: 0.08 }),
  ], '7d', now);
  const bucket = buckets.at(-1)!;

  assert.equal(bucket.hasActivity, true);
  assert.equal(bucket.time, 5_000);
  assert.equal(bucket.timeApproximate, true);
  assert.equal(bucket.input, 150);
  assert.equal(bucket.output, 10);
  assert.equal(bucket.cache, 1_000);
  assert.equal(bucket.cost, 0.5);
});

test('summary trends preserve inactive buckets and unknown active metrics', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  const buckets = aggregateTrendSummary([
    row(day, {
      durationMs: undefined,
      input: 999,
      known: { input: false, output: true, cacheRead: true, cacheWrite: true, cost: true },
    }),
  ], '7d', now);
  const active = buckets.at(-1)!;
  const inactive = buckets[0]!;

  assert.equal(active.hasActivity, true);
  assert.equal(active.timeKnown, false);
  assert.equal(active.inputKnown, false);
  assert.equal(active.outputKnown, true);
  assert.equal(inactive.hasActivity, false);
});

test('summary dataset aggregation stays bounded and range grouping stays automatic', () => {
  const day = new Date(2026, 8, 30, 10).getTime();
  const dataset = createTrendDataset();
  addRowsToTrendDataset(dataset, [row(day, { durationMs: 5_000, input: 123 })]);

  const buckets = aggregateTrendDatasetSummary(dataset, '30d', now);
  assert.equal(buckets.at(-1)?.input, 123);
  assert.equal(trendGroupingLabel('30d'), 'Day');
  assert.equal(trendGroupingLabel('3mo'), 'Week');
  assert.equal(trendGroupingLabel('1y'), 'Month');
  assert.equal(scaleTrendActivity(buckets, 10).at(-1), 10);
});
