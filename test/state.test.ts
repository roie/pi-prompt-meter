import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeElapsedMs,
  addCompactionUsage,
  createPromptMeter,
  finalizeMessageUsage,
  pausePromptMeter,
  resetPromptMeter,
  resumePromptMeter,
  setOutcome,
  setStreamingUsage,
  snapshotTotals,
} from '../src/state.ts';

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { total: cost },
});

test('missing usage fields become zero', () => {
  const state = createPromptMeter(0);
  setStreamingUsage(state, 'assistant:1', {});
  assert.deepEqual(snapshotTotals(state), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  });
});

test('streaming snapshots replace instead of accumulating', () => {
  const state = createPromptMeter(0);
  setStreamingUsage(state, 'assistant:1', usage(10, 2, 20, 0, 0.01));
  setStreamingUsage(state, 'assistant:1', usage(20, 5, 30, 0, 0.02));
  assert.deepEqual(snapshotTotals(state), {
    input: 20,
    output: 5,
    cacheRead: 30,
    cacheWrite: 0,
    totalTokens: 55,
    cost: 0.02,
  });
});

test('finalizing a streamed message counts it exactly once', () => {
  const state = createPromptMeter(0);
  setStreamingUsage(state, 'assistant:1', usage(20, 5, 30, 0, 0.02));
  finalizeMessageUsage(state, 'assistant:1', usage(21, 6, 31, 0, 0.021));
  finalizeMessageUsage(state, 'assistant:1', usage(21, 6, 31, 0, 0.021));
  assert.deepEqual(snapshotTotals(state), {
    input: 21,
    output: 6,
    cacheRead: 31,
    cacheWrite: 0,
    totalTokens: 58,
    cost: 0.021,
  });
});

test('finalized usage accumulates across messages including cache writes and cost', () => {
  const state = createPromptMeter(0);
  finalizeMessageUsage(state, 'assistant:1', usage(10, 2, 20, 3, 0.01));
  finalizeMessageUsage(state, 'assistant:2', usage(5, 1, 7, 4, 0.005));
  assert.deepEqual(snapshotTotals(state), {
    input: 15,
    output: 3,
    cacheRead: 27,
    cacheWrite: 7,
    totalTokens: 52,
    cost: 0.015,
  });
});

test('one and multiple UI pauses are excluded from active elapsed time', () => {
  const state = createPromptMeter(1_000);
  pausePromptMeter(state, 4_000);
  resumePromptMeter(state, 9_000);
  assert.equal(activeElapsedMs(state, 11_000), 5_000);

  pausePromptMeter(state, 12_000);
  resumePromptMeter(state, 14_500);
  assert.equal(activeElapsedMs(state, 17_000), 8_500);
});

test('an open UI pause is excluded when elapsed time is read', () => {
  const state = createPromptMeter(1_000);
  pausePromptMeter(state, 4_000);
  assert.equal(activeElapsedMs(state, 14_000), 3_000);
});

test('duplicate pause and resume calls are harmless', () => {
  const state = createPromptMeter(0);
  pausePromptMeter(state, 1_000);
  pausePromptMeter(state, 2_000);
  resumePromptMeter(state, 4_000);
  resumePromptMeter(state, 5_000);
  assert.equal(activeElapsedMs(state, 6_000), 3_000);
});

test('compaction usage is counted once per compaction key', () => {
  const state = createPromptMeter(0);
  addCompactionUsage(state, 'compact:1', usage(100, 20, 200, 0, 0.1));
  addCompactionUsage(state, 'compact:1', usage(100, 20, 200, 0, 0.1));
  assert.deepEqual(snapshotTotals(state), {
    input: 100,
    output: 20,
    cacheRead: 200,
    cacheWrite: 0,
    totalTokens: 320,
    cost: 0.1,
  });
});

test('reset clears usage, pauses, and outcome while starting at the new time', () => {
  const state = createPromptMeter(0);
  finalizeMessageUsage(state, 'assistant:1', usage(10, 2, 0, 0, 0.01));
  pausePromptMeter(state, 100);
  setOutcome(state, 'aborted');
  resetPromptMeter(state, 1_000);

  assert.equal(state.outcome, undefined);
  assert.equal(state.pausedAtMs, undefined);
  assert.equal(activeElapsedMs(state, 1_500), 500);
  assert.equal(snapshotTotals(state).input, 0);
});

test('stores completed, aborted, and error outcomes', () => {
  for (const outcome of ['completed', 'aborted', 'error'] as const) {
    const state = createPromptMeter(0);
    setOutcome(state, outcome);
    assert.equal(state.outcome, outcome);
  }
});
