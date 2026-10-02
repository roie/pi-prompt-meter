import test from 'node:test';
import assert from 'node:assert/strict';

import { METER_ENTRY_TYPE, parseMeterHistoryRecord } from '../src/history/record.ts';

const valid = {
  userEntryId: 'user-1',
  prompt: 'Fix the search picker',
  startedAt: 1_000,
  endedAt: 4_000,
  durationMs: 2_500,
  input: 100,
  output: 20,
  cacheRead: 300,
  cacheWrite: 4,
  cost: 0.025,
  billing: 'subscription',
  outcome: 'completed',
};

test('meter history record accepts a complete v1 record', () => {
  assert.equal(METER_ENTRY_TYPE, 'pi-prompt-meter/v1');
  assert.deepEqual(parseMeterHistoryRecord(valid), valid);
});

test('meter history record rejects malformed external data without throwing', () => {
  for (const value of [
    undefined,
    null,
    {},
    { ...valid, userEntryId: '' },
    { ...valid, durationMs: -1 },
    { ...valid, startedAt: Number.NaN },
    { ...valid, endedAt: 999 },
    { ...valid, input: -1 },
    { ...valid, cost: -0.01 },
    { ...valid, billing: 'free' },
    { ...valid, outcome: 'aborted' },
  ]) {
    assert.doesNotThrow(() => parseMeterHistoryRecord(value));
    assert.equal(parseMeterHistoryRecord(value), undefined);
  }
});
