import test from 'node:test';
import assert from 'node:assert/strict';

import { formatMeterHistoryEntry, renderMeterHistoryEntry } from '../src/ui/render-meter-entry.ts';

const base = {
  userEntryId: 'u1',
  prompt: 'Fix it',
  startedAt: 1_000,
  endedAt: 6_000,
  durationMs: 5_000,
  input: 155,
  output: 26,
  cacheRead: 410,
  cacheWrite: 4,
  cost: 0.036,
  billing: 'subscription',
  outcome: 'completed',
  transcript: true,
  turns: 0,
  toolCalls: 0,
  compactions: 0,
};

test('durable meter entry reuses exact persisted activity counts', () => {
  assert.deepEqual(
    formatMeterHistoryEntry({
      ...base,
      turns: 2,
      toolCalls: 7,
      compactions: 1,
    }),
    {
      label: 'Prompt Meter',
      text: 'Prompt Meter · 00:05 · ↑155 ↓26 R410 W4 · ↻2 TC7 Cmp1 · $0.036 (sub)',
    },
  );
});

test('only completed transcript rows are dim, without changing the stored outcome', () => {
  const theme = { fg: (role: string, text: string) => `[${role}]${text}[/${role}]` };
  const success = renderMeterHistoryEntry(base, theme)?.render(160)[0]?.trim();
  assert.match(success ?? '', /^\[dim\]Prompt Meter ·/);
  assert.equal(base.outcome, 'completed');
  for (const [outcome, label] of [['canceled', 'Canceled'], ['error', 'Error']]) {
    const text = renderMeterHistoryEntry({ ...base, outcome }, theme)?.render(160)[0]?.trim();
    assert.ok(text?.startsWith(`${label} ·`));
    assert.ok(!text?.includes('[dim]'));
  }
});

test('older history-only records stay invisible in the transcript', () => {
  const { transcript, ...historyOnly } = base;
  assert.equal(formatMeterHistoryEntry(historyOnly), undefined);
});

test('incomplete records never produce a counterless transcript meter', () => {
  assert.equal(formatMeterHistoryEntry({ ...base, turns: undefined }), undefined);
  assert.equal(formatMeterHistoryEntry({ ...base, toolCalls: undefined }), undefined);
  assert.equal(formatMeterHistoryEntry({ ...base, compactions: undefined }), undefined);
});

test('canceled and error history outcomes render their final labels', () => {
  assert.equal(formatMeterHistoryEntry({ ...base, billing: 'metered', outcome: 'canceled' })?.label, 'Canceled');
  assert.equal(formatMeterHistoryEntry({ ...base, billing: 'metered', outcome: 'error' })?.label, 'Error');
});

test('invalid custom-entry data does not render', () => {
  assert.equal(formatMeterHistoryEntry({ ...base, durationMs: -1 }), undefined);
});
