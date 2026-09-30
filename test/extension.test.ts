import test from 'node:test';
import assert from 'node:assert/strict';

import { registerPromptMeter } from '../src/index.ts';

class FakePi {
  handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  on(name: string, handler: (event: any, ctx: any) => unknown): () => void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
    return () => {};
  }
  async emit(name: string, event: any, ctx: any): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
  }
}

class FakeClock {
  nowMs = 0;
  nextId = 1;
  intervals = new Map<number, () => void>();
  now = () => this.nowMs;
  setInterval = (callback: () => void): number => {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  };
  clearInterval = (id: unknown): void => { this.intervals.delete(id as number); };
  advance(ms: number): void { this.nowMs += ms; }
  fireIntervals(): void { for (const callback of this.intervals.values()) callback(); }
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
      if (value === undefined) status.delete(key); else status.set(key, value);
    },
    setWorkingMessage(value?: string) { working.push(value); },
    setWidget(key: string, lines: string[] | undefined, options?: { placement?: string }) {
      if (lines === undefined) widgets.delete(key); else widgets.set(key, { lines, placement: options?.placement });
    },
  };
}

function createContext(subscription = false) {
  const ui = createUI();
  return {
    ui,
    model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    modelRegistry: { isUsingOAuth: () => subscription },
  };
}

function use(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: cost } };
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

test('prompt start clears previous result and starts Working', async () => {
  const { pi, ctx } = setup();
  ctx.ui.setWidget('pi-prompt-meter', ['Done · stale'], { placement: 'aboveEditor' });
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);
  assert.equal(ctx.ui.widgets.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.working.at(-1), 'Working · 00:00 · ↑0 ↓0 R0 · $0.000');
});

test('timer refreshes elapsed time without provider events', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);
  clock.advance(2_100); clock.fireIntervals();
  assert.equal(ctx.ui.working.at(-1), 'Working · 00:02 · ↑0 ↓0 R0 · $0.000');
});

test('assistant messages aggregate and settle as dim Done above the editor', async () => {
  const { pi, clock, ctx } = setup(true);
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hello' }, ctx);
  const first = { role: 'assistant', usage: use(10, 2, 20, 3, 0.01) };
  await pi.emit('message_start', { type: 'message_start', message: first }, ctx);
  await pi.emit('message_update', { type: 'message_update', message: first }, ctx);
  await pi.emit('message_end', { type: 'message_end', message: first }, ctx);
  const second = { role: 'assistant', usage: use(5, 1, 7, 4, 0.005) };
  await pi.emit('message_start', { type: 'message_start', message: second }, ctx);
  await pi.emit('message_update', { type: 'message_update', message: second }, ctx);
  await pi.emit('message_end', { type: 'message_end', message: second }, ctx);
  clock.advance(4_000);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.deepEqual(ctx.ui.widgets.get('pi-prompt-meter'), {
    lines: ['[dim]Done · 00:04 · ↑15 ↓3 R27 W7 · $0.015 (sub)[/dim]'],
    placement: 'aboveEditor',
  });
});

test('blocking UI wait time is excluded', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'approve' }, ctx);
  clock.advance(3_000);
  await pi.emit('ui_prompt_start', { type: 'ui_prompt_start' }, ctx);
  clock.advance(10_000);
  await pi.emit('ui_prompt_end', { type: 'ui_prompt_end' }, ctx);
  clock.advance(2_000);
  await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome: 'completed' }, ctx);
  await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);
  assert.match(meterWidgetText(ctx) ?? '', /^\[dim\]Done · 00:05 ·.*\[\/dim\]$/);
});

test('settlement maps outcomes to final labels', async () => {
  for (const [outcome, prefix] of [['completed','[dim]Done ·'],['aborted','Canceled ·'],['error','Error ·']] as const) {
    const { pi, ctx } = setup();
    await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: outcome }, ctx);
    await pi.emit('agent_before_settle', { type: 'agent_before_settle', outcome }, ctx);
    await pi.emit('agent_settled', { type: 'agent_settled' }, ctx);
    assert.equal((meterWidgetText(ctx) ?? '').startsWith(prefix), true);
  }
});

test('session reset clears meter and timer', async () => {
  const { pi, clock, ctx } = setup();
  await pi.emit('before_agent_start', { type: 'before_agent_start', prompt: 'one' }, ctx);
  assert.equal(clock.intervals.size, 1);
  await pi.emit('session_start', { type: 'session_start', reason: 'new' }, ctx);
  assert.equal(ctx.ui.widgets.has('pi-prompt-meter'), false);
  assert.equal(ctx.ui.status.has('pi-prompt-meter'), false);
  assert.equal(clock.intervals.size, 0);
});
