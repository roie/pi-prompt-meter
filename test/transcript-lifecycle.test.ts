import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomEntryComponent } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js';
import { initTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { registerPromptMeter } from '../src/index.ts';

initTheme('dark');

function harness() {
  const entries: any[] = [];
  const handlers = new Map<string, any>();
  const renderers = new Map<string, any>();
  let rows: CustomEntryComponent[] = [];
  let working: string | undefined;
  const widgets = new Map<string, any>();
  const notices: string[] = [];
  let failure: 'before' | 'after' | undefined;
  const render = (entry: any) => {
    const renderer = renderers.get(entry.customType);
    if (!renderer) return;
    const component = new CustomEntryComponent(entry, renderer);
    if (component.hasContent()) rows.push(component);
  };
  const pi = {
    on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerEntryRenderer: (type: string, renderer: any) => { renderers.set(type, renderer); },
    appendEntry: (customType: string, data: any) => {
      if (failure === 'before') throw new Error('disk unavailable');
      const entry = { type: 'custom', id: `e${entries.length}`, customType, data };
      entries.push(entry);
      render(entry); // Pi's entry_appended path, after persistence
      if (failure === 'after') throw new Error('listener failed after append');
    },
  };
  const ctx: any = {
    sessionManager: { getEntries: () => entries },
    modelRegistry: {},
    ui: {
      setWorkingMessage: (text?: string) => { working = text; },
      setStatus: () => {},
      setWidget: (key: string, value: any) => { if (value) widgets.set(key, value); else widgets.delete(key); },
      notify: (text: string) => notices.push(text),
    },
  };
  const runtime = { now: () => 1000, setInterval: () => 1, clearInterval: () => {} };
  const reload = async () => {
    handlers.clear(); renderers.clear();
    registerPromptMeter(pi, runtime);
    await emit('session_start', {});
    rows = [];
    entries.splice(0, entries.length, ...JSON.parse(JSON.stringify(entries)));
    entries.forEach(render); // Pi rebuild clears its container, then renders the branch
  };
  const emit = async (name: string, event: any) => { await handlers.get(name)?.(event, ctx); };
  const begin = async () => {
    await emit('before_agent_start', { prompt: 'hello' });
    const message = { role: 'user' };
    await emit('message_start', { message });
    entries.push({ type: 'message', id: `u${entries.length}`, message });
  };
  const settle = async (outcome = 'completed') => {
    await emit('agent_before_settle', { outcome });
    await emit('agent_settled', {});
  };
  registerPromptMeter(pi, runtime);
  return { entries, renderers, widgets, notices, emit, begin, settle, reload,
    fail: (value: typeof failure) => { failure = value; },
    working: () => working,
    texts: () => rows.flatMap(row => row.render(160)).filter(line => /Prompt Meter ·|Canceled ·|Error ·/.test(line)),
  };
}

test('opening context before a real prompt does not meter its empty synthetic probe', async () => {
  const h = harness();
  await h.emit('session_start', {});
  await h.emit('before_agent_start', { prompt: '' });
  const message = { role: 'user', content: [], timestamp: 10 };
  await h.emit('message_start', { message });
  h.entries.push({ type: 'message', id: 'probe', message });
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('message_end', { message: { role: 'assistant', content: [], stopReason: 'stop' } });
  await h.settle('error');
  assert.equal(h.working(), undefined);
  assert.equal(h.texts().length, 0);
  assert.equal(h.entries.filter(e => e.type === 'custom').length, 0);
  assert.equal(h.notices.length, 0);
  await h.reload();
  assert.equal(h.texts().length, 0);
  await h.begin();
  await h.settle();
  assert.equal(h.texts().length, 1);
});

test('image-only prompts still receive a completed meter', async () => {
  const h = harness();
  await h.emit('before_agent_start', { prompt: '', images: [{ type: 'image', data: 'image', mimeType: 'image/png' }] });
  assert.match(h.working()!, /^Working ·/);
  const message = { role: 'user' };
  await h.emit('message_start', { message });
  h.entries.push({ type: 'message', id: 'image-prompt', message });
  await h.settle();
  assert.equal(h.texts().length, 1);
});

test('one live owner, two durable settlements, and idempotent reload through Pi custom-entry components', async () => {
  const h = harness();
  await h.begin();
  assert.match(h.working()!, /^Working ·/);
  assert.equal(h.widgets.size, 0);
  assert.equal(h.texts().length, 0);
  for (let turnIndex = 0; turnIndex < 23; turnIndex++) await h.emit('turn_start', { turnIndex });
  await h.emit('tool_execution_start', { toolCallId: 'parent', toolName: 'codemode' });
  for (let n = 1; n < 22; n++) await h.emit('tool_execution_start', {
    toolCallId: `parent/${n}`, toolName: 'read', parentToolCallId: 'parent',
  });
  await h.emit('turn_start', { turnIndex: 22 });
  await h.emit('tool_execution_start', { toolCallId: 'parent/21', parentToolCallId: 'parent' });
  await h.emit('session_compact', { compactionEntry: { id: 'c1' } });
  await h.settle();
  await h.settle();
  assert.equal(h.working(), undefined);
  assert.equal(h.widgets.size, 0);
  assert.equal(h.texts().length, 1);
  assert.match(h.texts()[0]!, /↻23 TC22 Cmp1/);
  await h.begin();
  assert.match(h.working()!, /^Working ·/);
  assert.equal(h.texts().length, 1);
  assert.equal(h.widgets.size, 0);
  await h.settle();
  assert.equal(h.working(), undefined);
  assert.equal(h.texts().length, 2);
  for (let n = 0; n < 2; n++) {
    await h.reload();
    assert.equal(h.texts().length, 2);
    assert.match(h.texts()[0]!, /↻23 TC22 Cmp1/);
    assert.equal(h.widgets.size, 0);
  }
  const stored = h.entries.filter(e => e.type === 'custom');
  assert.equal(stored.length, 2);
  assert.deepEqual(
    { turns: stored[0].data.turns, toolCalls: stored[0].data.toolCalls, compactions: stored[0].data.compactions },
    { turns: 23, toolCalls: 22, compactions: 1 },
  );
  h.entries.push({ ...stored[0], id: 'legacy', data: { ...stored[0].data, transcript: undefined } });
  await h.reload();
  assert.equal(h.texts().length, 2);
});

for (const [outcome, label] of [['aborted', 'Canceled'], ['error', 'Error']]) {
  test(`${label} has one durable owner`, async () => {
    const h = harness(); await h.begin(); await h.settle(outcome);
    assert.equal(h.working(), undefined);
    assert.equal(h.widgets.size, 0);
    assert.equal(h.texts().length, 1);
    assert.ok(h.texts()[0]!.includes(`${label} ·`));
    await h.reload(); assert.equal(h.texts().length, 1);
  });
}

for (const [stopReason, label] of [['aborted', 'Canceled'], ['error', 'Error']]) {
  test(`${label} survives settlement without agent_before_settle (Pi abort path)`, async () => {
    const h = harness();
    await h.begin();
    await h.emit('message_end', { message: { role: 'assistant', stopReason } });
    await h.emit('agent_settled', {});
    assert.equal(h.working(), undefined);
    assert.equal(h.widgets.size, 0);
    assert.equal(h.texts().length, 1);
    assert.ok(h.texts()[0]!.includes(`${label} ·`));
    await h.reload();
    assert.equal(h.texts().length, 1);
    assert.ok(h.texts()[0]!.includes(`${label} ·`));
  });
}

test('Pi continuation resets turnIndex but not the prompt meter or exact persisted turns', async () => {
  const h = harness();
  await h.begin();
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('turn_start', { turnIndex: 1 });
  await h.emit('agent_end', {});
  await h.emit('agent_start', {});
  await h.emit('turn_start', { turnIndex: 0 });
  await h.emit('turn_start', { turnIndex: 1 });
  await h.emit('turn_start', { turnIndex: 1 });
  await h.settle();
  assert.equal(h.texts().length, 1);
  assert.match(h.texts()[0]!, /↻4 TC0 Cmp0/);
  await h.reload();
  assert.equal(h.texts().length, 1);
  assert.match(h.texts()[0]!, /↻4 TC0 Cmp0/);
});

test('successful recovery replaces a terminal error before final settlement', async () => {
  const h = harness();
  await h.begin();
  await h.emit('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'error' } });
  await h.emit('message_start', { message: { role: 'assistant', timestamp: 2 } });
  await h.emit('message_end', { message: { role: 'assistant', timestamp: 2, stopReason: 'stop' } });
  await h.emit('agent_settled', {});
  assert.equal(h.texts().length, 1);
  assert.ok(h.texts()[0]!.includes('Prompt Meter ·'));
  assert.equal(h.entries.find(e => e.type === 'custom')?.data.outcome, 'completed');
});

test('Pi renderer failure stays on the entry surface and recovers on reload without a final widget', async () => {
  const h = harness();
  await h.begin();
  h.renderers.set('pi-prompt-meter/v1', () => { throw new Error('renderer unavailable'); });
  await h.settle();
  assert.equal(h.working(), undefined);
  assert.equal(h.widgets.size, 0);
  assert.equal(h.entries.filter(e => e.type === 'custom').length, 1);
  assert.equal(h.texts().length, 0);
  assert.equal(h.notices.length, 0);
  await h.reload();
  assert.equal(h.texts().length, 1);
  assert.equal(h.widgets.size, 0);
});

for (const failure of ['before', 'after'] as const) {
  test(`append failure ${failure} persistence cannot create a final widget alongside a row`, async () => {
    const h = harness(); await h.begin(); h.fail(failure); await h.settle();
    assert.equal(h.working(), undefined);
    assert.equal(h.widgets.size, 0);
    assert.equal(h.texts().length, failure === 'before' ? 0 : 1);
    assert.equal(h.notices.length, 1);
    await h.reload();
    assert.equal(h.texts().length, failure === 'before' ? 0 : 1);
  });
}
