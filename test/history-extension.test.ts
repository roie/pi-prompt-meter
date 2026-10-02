import test from 'node:test';
import assert from 'node:assert/strict';

import { registerPromptMeter } from '../src/index.ts';

class FakePi {
  handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  appended: Array<{ customType: string; data: any }> = [];

  on(name: string, handler: (event: any, ctx: any) => unknown) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => {};
  }

  registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
    this.commands.set(name, command);
  }

  appendEntry(customType: string, data: any) {
    this.appended.push({ customType, data });
  }

  async emit(name: string, event: any, ctx: any) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }

  async runCommand(name: string, ctx: any) {
    await this.commands.get(name)!.handler('', ctx);
  }
}

class Clock {
  nowMs = 0;
  now = () => this.nowMs;
  setInterval = () => 1;
  clearInterval = () => {};
  advance(ms: number) {
    this.nowMs += ms;
  }
}

function usage(
  input = 100,
  output = 20,
  cacheRead = 300,
  cacheWrite = 4,
  cost = 0.025,
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { total: cost },
  };
}

function context(entries: any[] = [], subscription: boolean | 'unknown' = true) {
  const widgets = new Map<string, { lines: string[] }>();
  const working: Array<string | undefined> = [];
  const modelRegistry = subscription === 'unknown'
    ? {}
    : { isUsingOAuth: () => subscription };

  return {
    mode: 'tui',
    cwd: '/project',
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => '/current',
    },
    model: { provider: 'x', id: 'm' },
    modelRegistry,
    waitForIdle: async () => {},
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    ui: {
      theme: {
        fg: (role: string, text: string) => role === 'dim' ? `[dim]${text}[/dim]` : text,
      },
      setStatus() {},
      setWorkingMessage(value?: string) {
        working.push(value);
      },
      setWidget(key: string, value?: string[]) {
        if (value) widgets.set(key, { lines: value });
        else widgets.delete(key);
      },
      notify() {},
      custom: async () => ({ kind: 'close' }),
    },
    widgets,
    working,
  };
}

async function beginPrompt(
  pi: FakePi,
  ctx: any,
  entries: any[],
  prompt = 'Fix it',
  id = 'u1',
) {
  const user = { role: 'user', content: prompt, timestamp: 1 };
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt }, ctx);
  await pi.emit('message_start', { type: 'message_start', message: user }, ctx);
  entries.push({ type: 'message', id, message: user });
}

test('settled prompt persists exact aggregated v1 record while preserving live meter output', async () => {
  const pi = new FakePi();
  const clock = new Clock();
  const entries: any[] = [];
  const ctx: any = context(entries, true);
  registerPromptMeter(pi as any, clock as any);

  await beginPrompt(pi, ctx, entries);
  await pi.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: 1 }, ctx);
  await pi.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: 2 }, ctx);
  await pi.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: 2 }, ctx);
  await pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'codemode',
  }, ctx);
  await pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 'tool-1/1',
    toolName: 'read',
    parentToolCallId: 'tool-1',
  }, ctx);
  await pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 'tool-1/1',
    toolName: 'read',
    parentToolCallId: 'tool-1',
  }, ctx);
  clock.advance(5_000);
  await pi.emit('message_end', {
    type: 'message_end',
    message: { role: 'assistant', timestamp: 2, usage: usage(100, 20, 300, 4, 0.025) },
  }, ctx);
  await pi.emit('message_end', {
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 'tool-1', usage: usage(5, 1, 10, 0, 0.001) },
  }, ctx);
  await pi.emit('session_compact', {
    type: 'session_compact',
    compactionEntry: { id: 'compact-1', usage: usage(50, 5, 100, 0, 0.01) },
  }, ctx);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(pi.appended.length, 1);
  assert.equal(pi.appended[0]?.customType, 'pi-prompt-meter/v1');
  assert.deepEqual(
    { ...pi.appended[0]?.data, cost: undefined },
    {
      userEntryId: 'u1',
      prompt: 'Fix it',
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      input: 155,
      output: 26,
      cacheRead: 410,
      cacheWrite: 4,
      cost: undefined,
      turns: 2,
      toolCalls: 2,
      compactions: 1,
      billing: 'subscription',
      outcome: 'completed',
    },
  );
  assert.ok(Math.abs((pi.appended[0]?.data.cost ?? 0) - 0.036) < 1e-12);
  assert.equal(
    ctx.widgets.get('pi-prompt-meter')?.lines[0],
    '[dim]Done · 00:05 · ↑155 ↓26 R410 W4 · ↻2 TC2 Cmp1 · $0.036 (sub)[/dim]',
  );
});

test('canceled and error prompts persist their exact outcomes', async () => {
  const cases = [
    ['aborted', 'canceled', 'Canceled'],
    ['error', 'error', 'Error'],
  ] as const;

  for (const [agentOutcome, storedOutcome, label] of cases) {
    const pi = new FakePi();
    const clock = new Clock();
    const entries: any[] = [];
    const ctx: any = context(entries, false);
    registerPromptMeter(pi as any, clock as any);

    await beginPrompt(pi, ctx, entries, agentOutcome);
    clock.advance(1_500);
    await pi.emit('agent_before_settle', {
      type: 'agent_before_settle',
      outcome: agentOutcome,
    }, ctx);
    await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

    assert.equal(pi.appended[0]?.data.outcome, storedOutcome);
    assert.equal(pi.appended[0]?.data.billing, 'metered');
    assert.match(ctx.widgets.get('pi-prompt-meter')?.lines[0] ?? '', new RegExp(`^${label} · 00:01 ·`));
  }
});

test('exact history duration excludes time paused for UI input', async () => {
  const pi = new FakePi();
  const clock = new Clock();
  const entries: any[] = [];
  const ctx: any = context(entries, false);
  registerPromptMeter(pi as any, clock as any);

  await beginPrompt(pi, ctx, entries, 'Approve this');
  clock.advance(2_000);
  await pi.emit('ui_prompt_start', { type: 'ui_prompt_start' }, ctx);
  clock.advance(10_000);
  await pi.emit('ui_prompt_end', { type: 'ui_prompt_end' }, ctx);
  clock.advance(3_000);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(pi.appended[0]?.data.startedAt, 0);
  assert.equal(pi.appended[0]?.data.endedAt, 15_000);
  assert.equal(pi.appended[0]?.data.durationMs, 5_000);
  assert.match(ctx.widgets.get('pi-prompt-meter')?.lines[0] ?? '', /Done · 00:05 ·/);
});

test('history billing records subscription, metered, and unknown explicitly', async () => {
  const cases = [
    [true, 'subscription'],
    [false, 'metered'],
    ['unknown', 'unknown'],
  ] as const;

  for (const [subscription, expected] of cases) {
    const pi = new FakePi();
    const clock = new Clock();
    const entries: any[] = [];
    const ctx: any = context(entries, subscription);
    registerPromptMeter(pi as any, clock as any);

    await beginPrompt(pi, ctx, entries, expected);
    await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
    await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

    assert.equal(pi.appended[0]?.data.billing, expected);
  }
});

test('persistence failures do not affect live meter', async () => {
  const pi = new FakePi();
  const clock = new Clock();
  const entries: any[] = [];
  const ctx: any = context(entries, false);
  registerPromptMeter(pi as any, clock as any);

  await beginPrompt(pi, ctx, entries, 'x');
  pi.appendEntry = () => {
    throw new Error('disk');
  };
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'aborted' }, ctx);
  await assert.doesNotReject(() => pi.emit('agent_settled', { type: 'agent_settled' }, ctx));
  assert.match(ctx.widgets.get('pi-prompt-meter')?.lines[0] ?? '', /^Canceled ·/);
});

test('session startup performs no history listing or parsing', async () => {
  const pi = new FakePi();
  const clock = new Clock();
  let historyReads = 0;
  registerPromptMeter(pi as any, clock as any, {
    listProjectHistory: async () => {
      historyReads++;
      throw new Error('history should be lazy');
    },
    createMeterView: async () => {
      throw new Error('view should not open');
    },
    navigateToHistoryPrompt: async () => 'unavailable',
  } as any);

  const ctx: any = context();
  await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
  assert.equal(historyReads, 0);
});

test('history read failures are isolated from ordinary live-meter prompts', async () => {
  const pi = new FakePi();
  const clock = new Clock();
  let historyReads = 0;
  registerPromptMeter(pi as any, clock as any, {
    listProjectHistory: async () => {
      historyReads++;
      throw new Error('broken history');
    },
    createMeterView: async () => {
      throw new Error('broken history');
    },
    navigateToHistoryPrompt: async () => 'unavailable',
  } as any);

  const entries: any[] = [];
  const ctx: any = context(entries, false);
  await beginPrompt(pi, ctx, entries, 'normal prompt');
  clock.advance(2_000);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(historyReads, 0);
  assert.match(ctx.widgets.get('pi-prompt-meter')?.lines[0] ?? '', /Done · 00:02 ·/);
});

test('/meter is lazy, TUI-only, and delegates navigation target', async () => {
  const pi = new FakePi();
  const clock = new Clock();
  let lists = 0;
  let navigated: any;
  registerPromptMeter(pi as any, clock as any, {
    listProjectHistory: async (cwd: string) => {
      lists++;
      assert.equal(cwd, '/project');
      return {} as any;
    },
    createMeterView: async (_t: any, _th: any, _c: any, done: any) => {
      done({ kind: 'navigate', sessionPath: '/old', userEntryId: 'u9' });
      return { render: () => [] };
    },
    navigateToHistoryPrompt: async (_ctx: any, target: any) => {
      navigated = target;
      return 'navigated';
    },
  } as any);

  assert.equal(lists, 0);
  const ctx: any = context();
  ctx.ui.custom = async (factory: any) => await new Promise(async (resolve) => {
    await factory({ requestRender() {} }, ctx.ui.theme, {}, resolve);
  });
  await pi.runCommand('meter', ctx);
  assert.equal(lists, 1);
  assert.deepEqual(navigated, { sessionPath: '/old', userEntryId: 'u9' });

  const print: any = context();
  print.mode = 'print';
  const notices: string[] = [];
  print.ui.notify = (message: string) => notices.push(message);
  await pi.runCommand('meter', print);
  assert.equal(lists, 1);
  assert.match(notices[0] ?? '', /requires TUI/i);
});
