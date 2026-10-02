import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';

import { MeterView } from '../src/ui/meter-view.ts';
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
  assert.deepEqual(state.selected, { kind: 'prompt', sessionPath: '/current', userEntryId: 'u' });
  assert.equal(state.sessions.every((session) => session.rows.length > 0), true);
});

test('month paging loads that month prompts and resets selection to its first prompt', async () => {
  const { view } = await makeView();
  view.handleInput('\u001b[D');
  await view.whenIdle();
  const state = view.snapshot();
  assert.equal(state.month, '2026-08');
  assert.deepEqual(state.selected, { kind: 'prompt', sessionPath: '/aug', userEntryId: 'u' });
});

test('up/down navigate prompts only and Enter always jumps to the selected prompt', async () => {
  const { view, getResult } = await makeView();

  view.handleInput('\u001b[B');
  assert.deepEqual(view.snapshot().selected, {
    kind: 'prompt',
    sessionPath: '/other',
    userEntryId: 'u',
  });

  view.handleInput('\r');
  assert.deepEqual(getResult(), {
    kind: 'navigate',
    sessionPath: '/other',
    userEntryId: 'u',
  });
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
