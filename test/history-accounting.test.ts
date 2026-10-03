import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { registerPromptMeter } from '../src/index.ts';
import { reconstructSessionHistory } from '../src/history/reconstruct.ts';
import { aggregateTrendSummary } from '../src/trends.ts';

const startedAt = new Date(2026, 8, 30, 12).getTime();
const meta = { id: 'session', path: '/session', createdMs: startedAt, modifiedMs: startedAt + 5_000 };
const usage = (input: number) => ({
  input, output: input / 10, cacheRead: input * 2, cacheWrite: input / 10,
  totalTokens: input * 3.2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input / 100 },
});

for (const kind of ['sibling assistant', 'post-settlement compaction']) {
  for (const target of ['initiating user', 'follow-up user']) {
    test(`exact ancestry preserves ${kind} usage under the ${target}`, () => {
      const manager = SessionManager.inMemory('/project');
      const at = Date.now();
      const appendUser = (content: string) => manager.appendMessage({ role: 'user', content, timestamp: at });
      const appendAssistant = (input: number) => manager.appendMessage({
        role: 'assistant', content: [], api: 'openai-responses', provider: 'test', model: 'test',
        timestamp: at, usage: usage(input), stopReason: 'stop',
      });
      const u1 = appendUser('First');
      appendAssistant(10);
      const u2 = appendUser('Follow-up');
      appendAssistant(20);
      const record = {
        userEntryId: u1, prompt: 'First', startedAt: at, endedAt: at + 1_000, durationMs: 1_000,
        input: 30, output: 3, cacheRead: 60, cacheWrite: 3, cost: 0.3,
        billing: 'metered', outcome: 'completed',
      };
      const meter = manager.appendCustomEntry('pi-prompt-meter/v1', record);
      if (kind === 'sibling assistant') {
        manager.branch(target === 'initiating user' ? u1 : u2);
        appendAssistant(7);
      } else {
        if (target === 'initiating user') manager.branch(u1);
        manager.appendCompaction('Summary', u1, 100, undefined, false, usage(7));
      }
      const entries = manager.getEntries().map((entry, index) => ({
        ...entry, timestamp: new Date(at + index * 1_000).toISOString(),
      }));
      const result = reconstructSessionHistory(entries, { ...meta, createdMs: at, modifiedMs: at + 10_000 });
      assert.equal(result.rows.length, 2);
      assert.equal(result.totals.input, 37);
      assert.ok(Math.abs(result.totals.output - 3.7) < 1e-12);
      assert.equal(result.totals.cacheRead, 74);
      assert.ok(Math.abs(result.totals.cost - 0.37) < 1e-12);
      const exact = result.rows.find((row) => row.exact)!;
      assert.equal(exact.input, record.input);
      assert.equal(exact.durationMs, record.durationMs);
      assert.equal(exact.durationApproximate, false);
      const uncovered = result.rows.find((row) => !row.exact)!;
      assert.equal(uncovered.input, 7);
      const boundaryId = kind === 'post-settlement compaction' && target === 'follow-up user'
        ? meter : target === 'initiating user' ? u1 : u2;
      assert.equal(uncovered.startedAt, Date.parse(entries.find((entry) => entry.id === boundaryId)!.timestamp));
      const trend = aggregateTrendSummary(result.rows, '7d', new Date(at + 10_000)).at(-1)!;
      assert.equal(trend.input, 37);
      assert.equal(trend.cache, 74);
    });
  }
}

for (const delivery of ['steering', 'queued follow-up']) {
  test(`settled ${delivery} usage is counted once in transcript, History and Trends`, async () => {
    const manager = SessionManager.inMemory('/project');
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let now = startedAt;
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); return () => {}; },
      registerEntryRenderer() {},
      appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
    };
    const ctx = {
      sessionManager: manager, modelRegistry: {},
      ui: { setStatus() {}, setWorkingMessage() {}, setWidget() {} },
    };
    registerPromptMeter(pi as any, { now: () => now, setInterval: () => 1, clearInterval() {} });
    const emit = async (type: string, event: any = {}) => await handlers.get(type)?.({ type, ...event }, ctx);
    const user = async (content: string) => {
      const message = { role: 'user' as const, content, timestamp: now };
      await emit('message_start', { message });
      manager.appendMessage(message);
    };
    const assistant = async (input: number, stopReason: 'stop' | 'toolUse') => {
      const message = {
        role: 'assistant' as const, content: [], api: 'openai-responses' as const,
        provider: 'test', model: 'test', timestamp: now, usage: usage(input), stopReason,
      };
      await emit('message_start', { message });
      manager.appendMessage(message);
      await emit('message_end', { message });
    };
    await emit('before_agent_start', { prompt: 'First' });
    await user('First');
    now += 1_000;
    await assistant(10, delivery === 'steering' ? 'toolUse' : 'stop');
    now += 1_000;
    await user(delivery);
    now += 1_000;
    await assistant(20, 'stop');
    now += 1_000;
    await emit('agent_before_settle', { outcome: 'completed' });
    await emit('agent_settled');

    const entries = manager.getEntries();
    const record = entries.find((entry) => entry.type === 'custom') as any;
    assert.equal(record.data.input, 30);
    const summary = reconstructSessionHistory(entries as any, meta);
    assert.equal(summary.rows.length, 1);
    assert.equal(summary.rows[0]?.exact, true);
    assert.deepEqual(summary.totals, { input: 30, output: 3, cacheRead: 60, cacheWrite: 3, cost: 0.30000000000000004 });
    assert.equal(summary.durationMs, 4_000);
    const trend = aggregateTrendSummary(summary.rows, '7d', new Date(now)).at(-1)!;
    assert.equal(trend.input, 30);
    assert.equal(trend.output, 3);
    assert.equal(trend.cache, 60);
    assert.equal(trend.cost, summary.totals.cost);
    assert.equal(trend.time, 4_000);

    now += 1_000;
    await emit('before_agent_start', { prompt: 'Next' });
    await user('Next');
    now += 1_000;
    await assistant(5, 'stop');
    await emit('agent_settled');
    const after = reconstructSessionHistory(manager.getEntries() as any, meta);
    assert.equal(after.rows.length, 2);
    assert.equal(after.totals.input, 35);
  });
}
