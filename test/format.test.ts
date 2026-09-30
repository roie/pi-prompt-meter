import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCost,
  formatDuration,
  formatMeter,
  formatTokens,
  type UsageTotals,
} from '../src/format.ts';

test('formats token counts compactly', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_000), '1k');
  assert.equal(formatTokens(1_250), '1.3k');
  assert.equal(formatTokens(1_000_000), '1M');
});

test('formats elapsed time as a compact clock', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(59_999), '00:59');
  assert.equal(formatDuration(60_000), '01:00');
  assert.equal(formatDuration(134_000), '02:14');
  assert.equal(formatDuration(3_661_000), '1:01:01');
});

test('formats cost to three decimals', () => {
  assert.equal(formatCost(0), '$0.000');
  assert.equal(formatCost(0.0414), '$0.041');
  assert.equal(formatCost(1.9996), '$2.000');
});

const baseUsage: UsageTotals = {
  input: 42_000,
  output: 6_100,
  cacheRead: 1_800_000,
  cacheWrite: 0,
  totalTokens: 1_848_100,
  cost: 0.041,
};

test('formats Working meter with cache write hidden at zero', () => {
  assert.equal(
    formatMeter('Working', 134_000, baseUsage, true),
    'Working · 02:14 · ↑42k ↓6.1k R1.8M · $0.041 (sub)',
  );
});

test('shows cache write only when non-zero', () => {
  assert.equal(
    formatMeter('Last', 277_000, { ...baseUsage, cacheWrite: 12_000 }, false),
    'Last · 04:37 · ↑42k ↓6.1k R1.8M W12k · $0.041',
  );
});

test('uses exact state labels', () => {
  for (const label of ['Working', 'Last', 'Canceled', 'Error'] as const) {
    assert.match(formatMeter(label, 0, baseUsage, false), new RegExp(`^${label} ·`));
  }
});
