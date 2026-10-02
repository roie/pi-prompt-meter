import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';

import { renderTrends } from '../src/ui/render-trends.ts';
import type { TrendSummaryBucket } from '../src/trends.ts';

function bucket(
  startedAt: number,
  overrides: Partial<TrendSummaryBucket> = {},
): TrendSummaryBucket {
  const d = new Date(startedAt);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    key,
    startedAt,
    hasActivity: false,
    time: 0,
    timeKnown: false,
    timeApproximate: false,
    input: 0,
    inputKnown: false,
    output: 0,
    outputKnown: false,
    cache: 0,
    cacheKnown: false,
    cost: 0,
    costKnown: false,
    ...overrides,
  };
}

test('trends is date-first and shows all metrics together with Time-based activity', () => {
  const sep28 = new Date(2026, 8, 28).getTime();
  const lines = renderTrends({
    range: '30d',
    width: 108,
    buckets: [
      bucket(new Date(2026, 8, 27).getTime()),
      bucket(sep28, {
        hasActivity: true,
        time: ((5 * 60 + 2) * 60 + 24) * 1000,
        timeKnown: true,
        timeApproximate: true,
        input: 1_900_000,
        inputKnown: true,
        output: 250_000,
        outputKnown: true,
        cache: 116_000_000,
        cacheKnown: true,
        cost: 29.525,
        costKnown: true,
      }),
    ],
  });

  assert.match(lines[0] ?? '', /Range:\s+7d\s+30d\s+3mo\s+6mo\s+1y\s+All/);
  assert.equal(lines.some((line) => line.includes('Metric:')), false);
  assert.equal(lines[2], 'By Day');
  assert.match(lines[3] ?? '', /^─+$/);
  assert.match(lines[4] ?? '', /Date\s+Time\s+Input\s+Output\s+Cache\s+Cost\s+Activity/);
  assert.match(lines[5] ?? '', /^─+$/);
  assert.match(lines.join('\n'), /Sep 28\s+≈5:02:24\s+↑1\.9M\s+↓250k\s+R116M\s+\$29\.525\s+█+/);
  assert.equal(lines.every((line) => visibleWidth(line) <= 108), true);
});

test('trends hides inactive buckets instead of rendering empty dates', () => {
  const buckets = Array.from({ length: 8 }, (_, index) =>
    bucket(new Date(2026, 8, index + 1).getTime(), index === 6
      ? {
          hasActivity: true,
          time: 60_000,
          timeKnown: true,
          input: 10,
          inputKnown: true,
          output: 2,
          outputKnown: true,
          cache: 20,
          cacheKnown: true,
          cost: 0.01,
          costKnown: true,
        }
      : {}),
  );

  const text = renderTrends({ range: '30d', buckets, width: 108 }).join('\n');
  assert.match(text, /Sep 7\s+01:00/);
  assert.doesNotMatch(text, /Sep 1|Sep 2|Sep 3|Sep 4|Sep 5|Sep 6|Sep 8/);
  assert.doesNotMatch(text, /no activity/i);
});

test('trends shows one empty state when the selected range has no activity', () => {
  const buckets = Array.from({ length: 7 }, (_, index) =>
    bucket(new Date(2026, 8, index + 1).getTime()),
  );
  const text = renderTrends({ range: '7d', buckets, width: 108 }).join('\n');
  assert.match(text, /By Day/);
  assert.match(text, /No activity in this range/);
  assert.doesNotMatch(text, /Sep 1|Sep 2|Sep 3|Sep 4|Sep 5|Sep 6|Sep 7/);
});

test('sub-second activity is visible instead of looking like zero', () => {
  const row = bucket(new Date(2026, 9, 1).getTime(), {
    hasActivity: true,
    time: 500,
    timeKnown: true,
    input: 1,
    inputKnown: true,
    output: 1,
    outputKnown: true,
    cache: 1,
    cacheKnown: true,
    cost: 0.001,
    costKnown: true,
  });
  const text = renderTrends({ range: '7d', buckets: [row], width: 108 }).join('\n');
  assert.match(text, /Oct 1\s+<0:01/);
  assert.match(text, /█/);
});

test('range controls the automatic date grouping', () => {
  const weekly = renderTrends({
    range: '3mo',
    width: 108,
    buckets: [bucket(new Date(2026, 8, 28).getTime(), {
      hasActivity: true,
      time: 60_000,
      timeKnown: true,
      input: 1,
      inputKnown: true,
      output: 1,
      outputKnown: true,
      cache: 1,
      cacheKnown: true,
      cost: 0.001,
      costKnown: true,
    })],
  }).join('\n');
  const monthly = renderTrends({
    range: '1y',
    width: 108,
    buckets: [bucket(new Date(2026, 8, 1).getTime(), {
      hasActivity: true,
      time: 60_000,
      timeKnown: true,
      input: 1,
      inputKnown: true,
      output: 1,
      outputKnown: true,
      cache: 1,
      cacheKnown: true,
      cost: 0.001,
      costKnown: true,
    })],
  }).join('\n');

  assert.match(weekly, /By Week/);
  assert.match(weekly, /Sep 28–Oct 4/);
  assert.match(monthly, /By Month/);
  assert.match(monthly, /Sep 2026/);
});

test('narrow trends preserve the live-meter separator grammar', () => {
  const row = bucket(new Date(2026, 8, 28).getTime(), {
    hasActivity: true,
    time: 60_000,
    timeKnown: true,
    input: 1_200,
    inputKnown: true,
    output: 300,
    outputKnown: true,
    cache: 5_000,
    cacheKnown: true,
    cost: 0.123,
    costKnown: true,
  });
  const lines = renderTrends({ range: '7d', buckets: [row], width: 72 });
  const data = lines.find((line) => line.startsWith('Sep 28')) ?? '';
  assert.match(data, /Sep 28 · 01:00 · ↑1\.2k ↓300 R5\.0k · \$0\.123 · █+/);
  assert.equal(lines.every((line) => visibleWidth(line) <= 72), true);
});
