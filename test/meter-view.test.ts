import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';

import { MeterView } from '../src/ui/meter-view.ts';
import { reconstructSessionHistory } from '../src/history/reconstruct.ts';
import type { SessionHistorySummary } from '../src/history/types.ts';

const sep = new Date(2026, 8, 30, 10).getTime();
const aug = new Date(2026, 7, 20, 10).getTime();

function summary(path: string, startedAt: number): SessionHistorySummary {
  return {
    sessionId: path,
    sessionPath: path,
    createdMs: startedAt,
    modifiedMs: startedAt,
    rows: [{
      sessionId: path,
      sessionPath: path,
      userEntryId: 'u',
      prompt: 'Prompt',
      startedAt,
      endedAt: startedAt + 1000,
      durationMs: 1000,
      durationApproximate: false,
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 0,
      cost: .001,
      billing: 'metered',
      outcome: 'completed',
      exact: true,
    }],
    startedAt,
    endedAt: startedAt + 1000,
    durationMs: 1000,
    durationApproximate: false,
    totals: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, cost: .001 },
  };
}

class FakeCatalog {
  byMonth = new Map([
    ['2026-09', [summary('/current', sep), summary('/other', sep - 1000)]],
    ['2026-08', [summary('/aug', aug)]],
  ]);

  async initialMonth() { return '2026-09'; }
  shiftMonth(key: string, delta: number) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y!, m! - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  async sessionsForMonth(key: string) { return this.byMonth.get(key) ?? []; }
  async loadDetails(path: string) {
    return [...this.byMonth.values()].flat().find((s) => s.sessionPath === path);
  }
  async forEachSessionRows(visit: (rows: any[]) => void | Promise<void>) {
    for (const session of [...this.byMonth.values()].flat()) await visit(session.rows);
  }
}

class FakeTui {
  requests = 0;
  terminal = { rows: 24 };
  requestRender() { this.requests++; }
}

async function makeView() {
  const tui = new FakeTui();
  let result: any;
  const view = await MeterView.create(
    tui as any,
    {} as any,
    new FakeCatalog() as any,
    (r) => { result = r; },
    { currentSessionPath: '/current', now: new Date(2026, 8, 30, 12) },
  );
  return { view, tui, getResult: () => result };
}

test('History starts with prompts nested for the selected month and selects the current-session prompt', async () => {
  const { view } = await makeView();
  const state = view.snapshot();
  assert.equal(state.mode, 'history');
  assert.equal(state.month, '2026-09');
  assert.deepEqual(state.selected, { kind: 'prompt', sessionPath: '/current', rowIndex: 0, userEntryId: 'u' });
  assert.equal(state.sessions.every((session) => session.rows.length > 0), true);
});

test('month paging loads that month prompts and resets selection to its first prompt', async () => {
  const { view } = await makeView();
  view.handleInput('\u001b[D');
  await view.whenIdle();
  const state = view.snapshot();
  assert.equal(state.month, '2026-08');
  assert.deepEqual(state.selected, { kind: 'prompt', sessionPath: '/aug', rowIndex: 0, userEntryId: 'u' });
});

test('up/down navigate prompts only and Enter always jumps to the selected prompt', async () => {
  const { view, getResult } = await makeView();

  view.handleInput('\u001b[B');
  assert.deepEqual(view.snapshot().selected, {
    kind: 'prompt',
    sessionPath: '/other',
    rowIndex: 0,
    userEntryId: 'u',
  });

  view.handleInput('\r');
  assert.deepEqual(getResult(), {
    kind: 'navigate',
    sessionPath: '/other',
    userEntryId: 'u',
  });
});

test('exact and uncovered History rows traverse independently and jump to their initiating user', async () => {
  const entry = (id: string, parentId: string | null, ms: number, extra: { type: string } & Record<string, unknown>) => ({
    id, parentId, timestamp: new Date(sep + ms).toISOString(), ...extra,
  });
  const usage = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: .001 } });
  const session = reconstructSessionHistory([
    entry('u1', null, 0, { type: 'message', message: { role: 'user', content: 'First prompt' } }),
    entry('a1', 'u1', 1000, { type: 'message', message: { role: 'assistant', usage: usage(10), stopReason: 'stop' } }),
    entry('m1', 'a1', 1100, { type: 'custom', customType: 'pi-prompt-meter/v1', data: {
      userEntryId: 'u1', prompt: 'First prompt', startedAt: sep, endedAt: sep + 1000, durationMs: 1000,
      input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: .001,
      turns: 1, toolCalls: 2, compactions: 0, billing: 'metered', outcome: 'completed',
    } }),
    entry('c1', 'm1', 2000, { type: 'compaction', usage: usage(7) }),
    entry('u2', 'c1', 3000, { type: 'message', message: { role: 'user', content: 'Next prompt' } }),
    entry('a2', 'u2', 4000, { type: 'message', message: { role: 'assistant', usage: usage(20), stopReason: 'stop' } }),
  ], { id: 's', path: '/s', createdMs: sep, modifiedMs: sep + 4000 });
  assert.deepEqual(session.rows.map(row => [row.userEntryId, row.input, row.exact]), [
    ['u1', 10, true], ['u1', 7, false], ['u2', 20, false],
  ]);
  assert.deepEqual(session.totals, { input: 37, output: 3, cacheRead: 0, cacheWrite: 0, cost: .003 });
  assert.deepEqual([session.rows[0]?.turns, session.rows[0]?.toolCalls, session.rows[0]?.compactions], [1, 2, 0]);
  const unchanged = structuredClone(session);
  const catalog = new FakeCatalog();
  catalog.byMonth.set('2026-09', [session, summary('/other', sep)]);
  const create = async () => {
    const tui = new FakeTui();
    tui.terminal.rows = 40;
    let result: unknown;
    const view = await MeterView.create(tui as any, {}, catalog, r => { result = r; }, {
      currentSessionPath: '/s', now: new Date(sep),
    });
    return { view, getResult: () => result };
  };
  const assertHighlighted = (view: MeterView, prompt: string, input: number) => {
    const lines = view.render(108);
    const selectedLines = lines.flatMap((line, index) => line.includes('› ') ? [index] : []);
    assert.equal(selectedLines.length, 1, 'only the selected row is highlighted');
    assert.ok(lines[selectedLines[0]!]!.includes(`› ${prompt}`));
    assert.match(lines[selectedLines[0]! + 1]!, new RegExp(`↑${input}\\b`));
  };
  const { view } = await create();
  const expected = [['First prompt', 10], ['First prompt', 7], ['Next prompt', 20], ['Prompt', 1]] as const;
  assertHighlighted(view, ...expected[0]);
  for (const [key, index] of [
    ['\u001b[B', 1], ['\u001b[B', 2], ['\u001b[B', 3], ['\u001b[B', 3],
    ['\u001b[A', 2], ['\u001b[A', 1], ['\u001b[A', 0], ['\u001b[A', 0],
  ] as const) {
    view.handleInput(key);
    const [prompt, input] = expected[index];
    assertHighlighted(view, prompt, input);
  }
  for (let index = 0; index < 4; index++) {
    const { view: jumpView, getResult } = await create();
    for (let step = 0; step < index; step++) jumpView.handleInput('\u001b[B');
    jumpView.handleInput('\r');
    assert.deepEqual(getResult(), {
      kind: 'navigate', sessionPath: index === 3 ? '/other' : '/s', userEntryId: index === 3 ? 'u' : index === 2 ? 'u2' : 'u1',
    });
  }
  assert.deepEqual(session, unchanged, 'selection and navigation leave accounting unchanged');
});

test('selected month loads details for every session without touching other months', async () => {
  const catalog: any = new FakeCatalog();
  catalog.detailLoads = [] as string[];
  catalog.sessionsForMonth = async (key: string) =>
    (catalog.byMonth.get(key) ?? []).map((s: SessionHistorySummary) => ({ ...s, rows: [] }));
  catalog.loadDetails = async (path: string) => {
    catalog.detailLoads.push(path);
    return [...catalog.byMonth.values()].flat().find((s: SessionHistorySummary) => s.sessionPath === path);
  };

  const tui = new FakeTui();
  const view = await MeterView.create(
    tui as any,
    {} as any,
    catalog,
    () => {},
    { currentSessionPath: '/current', now: new Date(2026, 8, 30, 12) },
  );

  assert.deepEqual(catalog.detailLoads, ['/current', '/other']);
  assert.equal(view.snapshot().sessions.every((session) => session.rows.length === 1), true);

  view.handleInput('\u001b[D');
  await view.whenIdle();
  assert.deepEqual(catalog.detailLoads, ['/current', '/other', '/aug']);
});

test('tab switches History and Trends; Trends changes range only; escape closes', async () => {
  const { view, getResult } = await makeView();
  view.handleInput('\t');
  await view.whenIdle();
  assert.equal(view.snapshot().mode, 'trends');
  assert.equal(view.snapshot().range, '30d');
  assert.equal('metric' in view.snapshot(), false);
  view.handleInput('\u001b[C');
  assert.equal(view.snapshot().range, '3mo');
  view.handleInput('\u001b[D');
  assert.equal(view.snapshot().range, '30d');
  assert.match(view.render(108).at(-1) ?? '', /←→ Range · Tab History · Esc Close/);
  view.handleInput('\u001b');
  assert.deepEqual(getResult(), { kind: 'close' });
});

test('empty month renders No history and has no prompt selection', async () => {
  const { view } = await makeView();
  view.handleInput('\u001b[C');
  await view.whenIdle();
  assert.match(view.render(70).join('\n'), /No history/);
  assert.equal(view.snapshot().selected, undefined);
});

test('Trends retains aggregate dataset instead of all historical prompt rows', async () => {
  const catalog: any = new FakeCatalog();
  let visits = 0;
  catalog.forEachSessionRows = async (visit: (rows: any[]) => void) => {
    for (const sessions of catalog.byMonth.values()) {
      for (const session of sessions) {
        visits++;
        visit(session.rows);
      }
    }
  };

  const tui = new FakeTui();
  const view = await MeterView.create(
    tui as any,
    {} as any,
    catalog,
    () => {},
    { currentSessionPath: '/current', now: new Date(2026, 8, 30, 12) },
  );

  view.handleInput('\t');
  await view.whenIdle();
  assert.ok(visits > 0);
  assert.equal((view as any).trendRows, undefined);
  assert.ok((view as any).trendDataset);
});

test('busy History keeps the selected nested prompt visible within terminal-height viewport', async () => {
  const busy = Array.from({ length: 20 }, (_, i) => summary(`/s${i}`, sep - i * 60_000));
  const catalog: any = new FakeCatalog();
  catalog.byMonth.set('2026-09', busy);
  catalog.sessionsForMonth = async (key: string) =>
    (catalog.byMonth.get(key) ?? []).map((s: SessionHistorySummary) => ({ ...s, rows: [] }));
  catalog.loadDetails = async (path: string) => busy.find((s) => s.sessionPath === path);
  catalog.forEachSessionRows = async () => {};

  const tui = new FakeTui();
  tui.terminal.rows = 14;
  const view = await MeterView.create(
    tui as any,
    {} as any,
    catalog,
    () => {},
    { currentSessionPath: '/s0', now: new Date(2026, 8, 30, 12) },
  );

  for (let i = 0; i < 20; i++) view.handleInput('\u001b[B');
  const lines = view.render(80);
  assert.ok(lines.length <= 14);
  assert.match(lines.join('\n'), /› Prompt/);
  assert.equal(lines.some((line) => /[▾▸]/.test(line)), false);
});

test('History and Trends use context-style inset notes and individually styled shortcuts', async () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  const tui = new FakeTui();
  const view = await MeterView.create(tui as any, theme, new FakeCatalog() as any, () => {}, {
    now: new Date(2026, 8, 30, 12),
  });
  for (const mode of ['history', 'trends']) {
    calls.length = 0;
    const lines = view.render(108);
    assert.ok(lines.filter(Boolean).every(line => line.startsWith('  ')));
    assert.ok(lines.every(line => visibleWidth(line) <= 108));
    assert.ok(calls.some(([role, text]) => role === 'dim' && text.includes(
      mode === 'history' ? '≈ marks duration' : 'Activity bars are relative',
    )));
    assert.ok(calls.some(([role, text]) => role === 'dim' && text === 'Esc'));
    assert.ok(calls.some(([role, text]) => role === 'muted' && text === ' Close'));
    assert.ok(calls.some(([role, text]) => role === 'dim' && text === ' · '));
    for (const width of [1, 20, 70, 180]) {
      assert.ok(view.render(width).every(line => visibleWidth(line) <= Math.min(width, 108)));
    }
    view.handleInput('\t');
    await view.whenIdle();
  }
});

test('meter view keeps the bounded /context-style frame with resume-style History content', async () => {
  const { view } = await makeView();
  const lines = view.render(180);
  assert.match(lines[0] ?? '', /Prompt Meter/);
  assert.equal(lines[1], '');
  assert.match(lines[2] ?? '', /History/);
  assert.match(lines[2] ?? '', /Trends/);
  assert.equal(lines.some((line) => /^─+$/.test(line)), false);
  assert.equal(lines.some((line) => line.trim() === '‹ September 2026 ›'), true);
  assert.match(lines.join('\n'), /› Prompt/);
  assert.match(lines.at(-1) ?? '', /Enter Jump/);
  assert.equal(lines.some((line) => /≈ marks duration/.test(line)), true);
  assert.ok(lines.length < 24);
  assert.equal(lines.every((line) => visibleWidth(line) <= 108), true);
});
