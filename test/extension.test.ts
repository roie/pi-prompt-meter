import test from 'node:test';
import assert from 'node:assert/strict';

import { registerPromptMeter } from '../src/index.ts';

class FakePi {
  handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();

  on(name: string, handler: (event: any, ctx: any) => unknown): () => void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
    return () => {
      const current = this.handlers.get(name) ?? [];
      this.handlers.set(name, current.filter((item) => item !== handler));
    };
  }

  async emit(name: string, event: any, ctx: any): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) {
      await handler(event, ctx);
    }
  }
}

class FakeClock {
  nowMs = 0;
  nextId = 1;
  intervals = new Map<number, () => void>();

  now = () => this.nowMs;
  setInterval = (callback: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  };
  clearInterval = (id: unknown): void => {
    this.intervals.delete(id as number);
  };
  advance(ms: number): void {
    this.nowMs += ms;
  }
  fireIntervals(): void {
    for (const callback of [...this.intervals.values()]) callback();
  }
}

function createUI() {
  const status = new Map<string, string>();
  const working: Array<string | undefined> = [];
  const widgets = new Map<string, { lines: string[]; placement?: string }>();
  const theme = { fg: (role: string, text: string) => role === 'dim' ? `[dim]${text}[/dim]` : text };
  return {
    status,
    working,
    widgets,
    theme,
    setStatus(key: string, value: string | undefined) {
      if (value === undefined) status.delete(key);
      else status.set(key, value);
    },
    setWorkingMessage(value?: string) {
      working.push(value);
    },
    setWidget(key: string, lines: string[] | undefined, options?: { placement?: string }) {
      if (lines === undefined) widgets.delete(key);
      else widgets.set(key, { lines, placement: options?.placement });
    },
  };
}

function createContext(subscription = false) {
  const ui = createUI();
  return {
    ui,
    model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    modelRegistry: {
      isUsingOAuth: () => subscription,
    },
  };
}

function use(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { total: cost },
  };
}

function assistant(timestamp: number, usage = use(0, 0)) {
  return { role: 'assistant', timestamp, usage };
}

function toolResult(toolCallId: string, usage = use(0, 0)) {
  return { role: 'toolResult', toolCallId, usage, timestamp: 0 };
}

function setup(subscription = false) {
  const pi = new FakePi();
  const clock = new FakeClock();
  const ctx = createContext(subscription);
  registerPromptMeter(pi, clock);
  return { pi, clock, ctx };
}

function meterWidgetText(ctx: ReturnType<typeof createContext>): string | undefined {
  return ctx.ui.widgets.get('pi-prompt-meter')?.lines[0];
}

test('session start clears the final widget and restores the default Working message', async () => {
  const { pi, ctx } = setup();
  ctx.ui.setWidget('pi-prompt-meter', ['Done · stale'], { placement: 'aboveEditor' });
  ctx.ui.status.set('pi-prompt-meter', 'legacy footer value');

  await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);

  assert.equal(ctx.ui.widgets.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.working.at(-1), undefined);
});

test('prompt start clears the previous result and starts Working', async () => {
  const { pi, ctx } = setup();
  ctx.ui.setWidget('pi-prompt-meter', ['Done · stale'], { placement: 'aboveEditor' });

  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);

  assert.equal(ctx.ui.widgets.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.working.at(-1), 'Working · 00:00 · ↑0 ↓0 R0 · ↻0 TC0 Cmp0 · $0.000');
});

test('timer refreshes elapsed time without provider events', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);

  clock.advance(2_100);
  clock.fireIntervals();

  assert.equal(ctx.ui.working.at(-1), 'Working · 00:02 · ↑0 ↓0 R0 · ↻0 TC0 Cmp0 · $0.000');
});

test('settled result stays above the editor instead of moving into the footer', async () => {
  const { pi, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.deepEqual(ctx.ui.widgets.get('pi-prompt-meter'), {
    lines: ['[dim]Done · 00:00 · ↑0 ↓0 R0 · ↻0 TC0 Cmp0 · $0.000[/dim]'],
    placement: 'aboveEditor',
  });
  assert.equal(ctx.ui.working.at(-1), undefined);
});

test('multiple assistant messages aggregate and settle as Done', async () => {
  const { pi, clock, ctx } = setup(true);
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);

  const first = assistant(1, use(10, 2, 20, 3, 0.01));
  await pi.emit('message_update', { type: 'message_update', message: first }, ctx);
  await pi.emit('message_end', { type: 'message_end', message: first }, ctx);

  const second = assistant(2, use(5, 1, 7, 4, 0.005));
  await pi.emit('message_update', { type: 'message_update', message: second }, ctx);
  await pi.emit('message_end', { type: 'message_end', message: second }, ctx);

  clock.advance(4_000);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(
    meterWidgetText(ctx),
    '[dim]Done · 00:04 · ↑15 ↓3 R27 W7 · ↻0 TC0 Cmp0 · $0.015 (sub)[/dim]',
  );
  assert.equal(ctx.ui.working.at(-1), undefined);
  assert.equal(clock.intervals.size, 0);
});

test('cloned assistant streaming snapshots are finalized exactly once', async () => {
  const { pi, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'stream' }, ctx);

  await pi.emit('message_start', { type: 'message_start', message: assistant(1) }, ctx);
  await pi.emit('message_update', {
    type: 'message_update',
    message: assistant(1, use(8, 1, 20, 0, 0.008)),
  }, ctx);
  await pi.emit('message_update', {
    type: 'message_update',
    message: assistant(1, use(10, 2, 25, 0, 0.01)),
  }, ctx);
  await pi.emit('message_end', {
    type: 'message_end',
    message: assistant(1, use(10, 2, 25, 0, 0.01)),
  }, ctx);

  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(meterWidgetText(ctx), '[dim]Done · 00:00 · ↑10 ↓2 R25 · ↻0 TC0 Cmp0 · $0.010[/dim]');
});

test('canceled prompt keeps the last streamed usage when the terminal message reports zero', async () => {
  const { pi, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'cancel me' }, ctx);

  await pi.emit('message_start', { type: 'message_start', message: assistant(1) }, ctx);
  await pi.emit('message_update', {
    type: 'message_update',
    message: assistant(1, use(12, 3, 30, 0, 0.012)),
  }, ctx);
  await pi.emit('message_end', {
    type: 'message_end',
    message: assistant(1, use(0, 0, 0, 0, 0)),
  }, ctx);

  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'aborted' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(meterWidgetText(ctx), 'Canceled · 00:00 · ↑12 ↓3 R30 · ↻0 TC0 Cmp0 · $0.012');
});

test('tool-result usage is included when Pi supplies it', async () => {
  const { pi, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'tool' }, ctx);

  const result = toolResult('call-1', use(3, 1, 9, 0, 0.004));
  await pi.emit('message_end', { type: 'message_end', message: result }, ctx);
  await pi.emit('message_end', { type: 'message_end', message: result }, ctx);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(meterWidgetText(ctx), '[dim]Done · 00:00 · ↑3 ↓1 R9 · ↻0 TC0 Cmp0 · $0.004[/dim]');
});

test('automatic compaction usage is included exactly once', async () => {
  const { pi, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'compact' }, ctx);

  const event = {
    type: 'session_compact',
    compactionEntry: { id: 'compact-1', usage: use(100, 20, 200, 0, 0.1) },
    reason: 'overflow',
    willRetry: true,
    fromExtension: false,
  };
  await pi.emit('session_compact', event, ctx);
  await pi.emit('session_compact', event, ctx);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.equal(meterWidgetText(ctx), '[dim]Done · 00:00 · ↑100 ↓20 R200 · ↻0 TC0 Cmp1 · $0.100[/dim]');
});

test('blocking UI wait time is excluded from the prompt timer', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'approve' }, ctx);

  clock.advance(3_000);
  await pi.emit('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm' }, ctx);
  clock.advance(10_000);
  clock.fireIntervals();
  assert.match(ctx.ui.working.at(-1) ?? '', /Working · 00:03 ·/);

  await pi.emit('ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm' }, ctx);
  clock.advance(2_000);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);

  assert.match(meterWidgetText(ctx) ?? '', /\[dim\]Done · 00:05 ·.*\[\/dim\]/);
});

test('agent_end does not finalize because recovery may continue', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'retry' }, ctx);
  await pi.emit('agent_end', { type: 'agent_end', messages: [] }, ctx);

  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.match(ctx.ui.working.at(-1) ?? '', /^Working ·/);
  assert.equal(clock.intervals.size, 1);
});

test('settlement maps completed, aborted, and error outcomes to final labels', async () => {
  const cases = [
    ['completed', '[dim]Done ·'],
    ['aborted', 'Canceled ·'],
    ['error', 'Error ·'],
  ] as const;

  for (const [outcome, prefix] of cases) {
    const { pi, ctx } = setup();
    await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: outcome }, ctx);
    await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome }, ctx);
    await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);
    assert.equal((meterWidgetText(ctx) ?? '').startsWith(prefix), true);
  }
});

test('the next prompt clears the previous final result', async () => {
  const { pi, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'one' }, ctx);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);
  assert.match(meterWidgetText(ctx) ?? '', /^\[dim\]Done ·/);

  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'two' }, ctx);
  assert.equal(ctx.ui.widgets.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.match(ctx.ui.working.at(-1) ?? '', /^Working ·/);
});

test('session reset and repeated shutdown leave no stale meter or timer', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'one' }, ctx);
  assert.equal(clock.intervals.size, 1);

  await pi.emit('session_start', { type: 'session_start', reason: 'new' }, ctx);
  assert.equal(ctx.ui.widgets.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.working.at(-1), undefined);
  assert.equal(clock.intervals.size, 0);

  await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctx);
  await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctx);
  assert.equal(clock.intervals.size, 0);
});

test('UI failures never escape lifecycle handlers', async () => {
  const pi = new FakePi();
  const clock = new FakeClock();
  const ctx = createContext();
  ctx.ui.setStatus = () => { throw new Error('ui unavailable'); };
  ctx.ui.setWorkingMessage = () => { throw new Error('ui unavailable'); };
  ctx.ui.setWidget = () => { throw new Error('ui unavailable'); };
  registerPromptMeter(pi, clock);

  await assert.doesNotReject(async () => {
    await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);
    clock.fireIntervals();
    await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
    await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);
  });
});
