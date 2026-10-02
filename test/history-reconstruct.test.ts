import test from 'node:test';
import assert from 'node:assert/strict';

import { METER_ENTRY_TYPE } from '../src/history/record.ts';
import { reconstructSessionHistory } from '../src/history/reconstruct.ts';

const meta = { id: 's1', path: '/sessions/s1.jsonl', createdMs: 1_000, modifiedMs: 20_000 };
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: cost },
});
const e = (id: string, parentId: string | null, ms: number, extra: any) => ({
  id, parentId, timestamp: new Date(ms).toISOString(), ...extra,
});

test('reconstructs a simple legacy prompt with usage, approximate time, and outcome', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Fix it' } }),
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', usage: usage(10, 2, 20, 1, 0.01), stopReason: 'toolUse' } }),
    e('t1', 'a1', 3_000, { type: 'message', message: { role: 'toolResult', usage: usage(3, 1, 5, 0, 0.004) } }),
    e('a2', 't1', 5_000, { type: 'message', message: { role: 'assistant', usage: usage(5, 2, 7, 0, 0.005), stopReason: 'stop' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    sessionId: 's1', sessionPath: '/sessions/s1.jsonl', userEntryId: 'u1', prompt: 'Fix it',
    startedAt: 1_000, endedAt: 5_000, durationMs: 4_000, durationApproximate: true,
    input: 18, output: 5, cacheRead: 32, cacheWrite: 1, cost: 0.019,
    billing: 'unknown', outcome: 'completed', exact: false,
    known: { input:true, output:true, cacheRead:true, cacheWrite:true, cost:true },
  });
  assert.equal(result.durationMs, 4_000);
  assert.equal(result.durationApproximate, true);
});

test('legacy compaction usage is attributed to its nearest prompt exactly once', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Compact me' } }),
    e('a1', 'u1', 2_000, {
      type: 'message',
      message: { role: 'assistant', usage: usage(10, 2, 20, 1, 0.01), stopReason: 'toolUse' },
    }),
    e('c1', 'a1', 3_000, {
      type: 'compaction',
      usage: usage(7, 1, 30, 2, 0.006),
    }),
    e('a2', 'c1', 4_000, {
      type: 'message',
      message: { role: 'assistant', usage: usage(5, 1, 10, 0, 0.004), stopReason: 'stop' },
    }),
  ];

  const result = reconstructSessionHistory(entries as any, meta);
  const row = result.rows[0]!;

  assert.equal(row.input, 22);
  assert.equal(row.output, 4);
  assert.equal(row.cacheRead, 60);
  assert.equal(row.cacheWrite, 3);
  assert.ok(Math.abs(row.cost - 0.02) < 1e-12);
});

test('keeps abandoned branches once without multiplying shared ancestors', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Root' } }),
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', usage: usage(10, 1), stopReason: 'stop' } }),
    e('u2a', 'a1', 3_000, { type: 'message', message: { role: 'user', content: 'Branch A' } }),
    e('a2a', 'u2a', 4_000, { type: 'message', message: { role: 'assistant', usage: usage(20, 2), stopReason: 'stop' } }),
    e('u2b', 'a1', 5_000, { type: 'message', message: { role: 'user', content: 'Branch B' } }),
    e('a2b', 'u2b', 6_000, { type: 'message', message: { role: 'assistant', usage: usage(30, 3), stopReason: 'stop' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.deepEqual(result.rows.map((r) => [r.userEntryId, r.input]), [['u1', 10], ['u2a', 20], ['u2b', 30]]);
  assert.equal(result.totals.input, 60);
});

test('attributes steering/follow-up usage to the nearest user ancestor exactly once', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'First' } }),
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', usage: usage(10, 1), stopReason: 'toolUse' } }),
    e('t1', 'a1', 3_000, { type: 'message', message: { role: 'toolResult', usage: usage(4, 1) } }),
    e('u2', 't1', 4_000, { type: 'message', message: { role: 'user', content: 'Steer now' } }),
    e('a2', 'u2', 5_000, { type: 'message', message: { role: 'assistant', usage: usage(20, 2), stopReason: 'stop' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  const byId = new Map(result.rows.map((r) => [r.userEntryId, r]));
  assert.equal(byId.get('u1')?.input, 14);
  assert.equal(byId.get('u2')?.input, 20);
  assert.equal(result.totals.input, 34);
});

test('exact meter entry overrides legacy reconstruction for the same user', () => {
  const exact = {
    userEntryId: 'u1', prompt: 'Exact prompt', startedAt: 1_000, endedAt: 4_000, durationMs: 2_500,
    input: 99, output: 9, cacheRead: 999, cacheWrite: 2, cost: 0.123,
    turns: 4, toolCalls: 9, compactions: 1,
    billing: 'subscription', outcome: 'completed',
  };
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Legacy prompt' } }),
    e('a1', 'u1', 4_000, { type: 'message', message: { role: 'assistant', usage: usage(10, 1), stopReason: 'stop' } }),
    e('m1', 'a1', 4_100, { type: 'custom', customType: METER_ENTRY_TYPE, data: exact }),
    e('u2', 'm1', 5_000, { type: 'message', message: { role: 'user', content: 'Legacy two' } }),
    e('a2', 'u2', 8_000, { type: 'message', message: { role: 'assistant', usage: usage(20, 2), stopReason: 'error' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  const first = result.rows.find((r) => r.userEntryId === 'u1')!;
  const second = result.rows.find((r) => r.userEntryId === 'u2')!;
  assert.equal(first.exact, true);
  assert.equal(first.durationApproximate, false);
  assert.equal(first.input, 99);
  assert.equal(first.prompt, 'Exact prompt');
  assert.equal(first.turns, 4);
  assert.equal(first.toolCalls, 9);
  assert.equal(first.compactions, 1);
  assert.equal(second.exact, false);
  assert.equal(second.outcome, 'error');
  assert.equal(result.totals.input, 119);
  assert.equal(result.durationMs, 5_500);
  assert.equal(result.durationApproximate, true);
});

test('older exact records cover follow-ups on their ancestor path but not sibling branches', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'First' } }),
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', usage: usage(10, 1) } }),
    e('u2', 'a1', 3_000, { type: 'message', message: { role: 'user', content: 'Follow-up' } }),
    e('a2', 'u2', 4_000, { type: 'message', message: { role: 'assistant', usage: usage(20, 2) } }),
    e('m1', 'a2', 5_000, { type: 'custom', customType: METER_ENTRY_TYPE, data: {
      userEntryId: 'u1', prompt: 'First', startedAt: 1_000, endedAt: 5_000, durationMs: 4_000,
      input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0,
      billing: 'unknown', outcome: 'completed',
    } }),
    e('u3', 'a1', 3_000, { type: 'message', message: { role: 'user', content: 'Other branch' } }),
    e('a3', 'u3', 4_000, { type: 'message', message: { role: 'assistant', usage: usage(7, 1) } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.deepEqual(result.rows.map((row) => [row.userEntryId, row.input]), [['u1', 30], ['u3', 7]]);
  assert.equal(result.totals.input, 37);
});

test('invalid timestamp ordering yields no invented duration', () => {
  const entries = [
    { id: 'u1', parentId: null, timestamp: 'bad', type: 'message', message: { role: 'user', content: 'Bad time' } },
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', usage: usage(1, 1), stopReason: 'stop' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.equal(result.rows[0]?.durationMs, undefined);
  assert.equal(result.rows[0]?.endedAt, 2_000);
});

test('missing legacy usage and cost remain unknown instead of becoming zero', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Unknown usage' } }),
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', stopReason: 'stop' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.deepEqual(result.rows[0]?.known, {
    input: false, output: false, cacheRead: false, cacheWrite: false, cost: false,
  });
  assert.deepEqual(result.totalsKnown, {
    input: false, output: false, cacheRead: false, cacheWrite: false, cost: false,
  });
});


test('session header spans cross-midnight and multi-day activity while Time sums prompt durations', () => {
  const sep30 = new Date(2026, 8, 30, 23, 50).getTime();
  const oct1 = new Date(2026, 9, 1, 0, 10).getTime();
  const oct2Start = new Date(2026, 9, 2, 8, 0).getTime();
  const oct2End = new Date(2026, 9, 2, 8, 5).getTime();

  const entries = [
    e('u1', null, sep30, { type: 'message', message: { role: 'user', content: 'Cross midnight' } }),
    e('a1', 'u1', oct1, {
      type: 'message',
      message: { role: 'assistant', usage: usage(10, 1), stopReason: 'stop' },
    }),
    e('u2', 'a1', oct2Start, { type: 'message', message: { role: 'user', content: 'Two days later' } }),
    e('a2', 'u2', oct2End, {
      type: 'message',
      message: { role: 'assistant', usage: usage(20, 2), stopReason: 'stop' },
    }),
  ];

  const result = reconstructSessionHistory(entries as any, {
    ...meta,
    createdMs: sep30,
    modifiedMs: oct2End,
  });

  assert.equal(result.startedAt, sep30);
  assert.equal(result.endedAt, oct2End);
  assert.equal(result.durationMs, 25 * 60_000);
  assert.equal(result.durationApproximate, true);
  assert.deepEqual(result.rows.map((row) => row.durationMs), [20 * 60_000, 5 * 60_000]);
});

test('tool-use assistant state is not misreported as a completed legacy outcome', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Keep working' } }),
    e('a1', 'u1', 2_000, { type: 'message', message: { role: 'assistant', usage: usage(1, 1), stopReason: 'toolUse' } }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.equal(result.rows[0]?.outcome, undefined);
});

test('missing row duration is omitted from session Time without making known exact time approximate', () => {
  const entries = [
    e('u1', null, 1_000, { type: 'message', message: { role: 'user', content: 'Legacy unknown time' } }),
    { id: 'a1', parentId: 'u1', timestamp: 'bad', type: 'message', message: { role: 'assistant', usage: usage(1, 1), stopReason: 'stop' } },
    e('m1', 'a1', 4_000, {
      type: 'custom',
      customType: METER_ENTRY_TYPE,
      data: {
        userEntryId: 'u2', prompt: 'Exact', startedAt: 5_000, endedAt: 7_000, durationMs: 2_000,
        input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01,
        billing: 'metered', outcome: 'completed',
      },
    }),
  ];
  const result = reconstructSessionHistory(entries as any, meta);
  assert.equal(result.durationMs, 2_000);
  assert.equal(result.durationApproximate, false);
});
