import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';

import { renderHistory, formatSessionRange } from '../src/ui/render-history.ts';
import type { SessionHistorySummary } from '../src/history/types.ts';

const start = new Date(2026, 8, 30, 22, 14).getTime();
const row = {
  sessionId: 's1', sessionPath: '/s1', userEntryId: 'u1', prompt: 'Fix the search picker and make it reliable',
  startedAt: start, endedAt: start + 2 * 60_000, durationMs: 2 * 60_000 + 18_000, durationApproximate: false,
  input: 18_000, output: 1_200, cacheRead: 240_000, cacheWrite: 4_000, cost: 0.006,
  billing: 'metered' as const, outcome: 'completed' as const, exact: true,
};
const summary: SessionHistorySummary = {
  sessionId: 's1', sessionPath: '/s1', createdMs: start, modifiedMs: start,
  rows: [row], startedAt: start, endedAt: new Date(2026, 8, 30, 23, 42).getTime(),
  durationMs: 22 * 60_000 + 48_000, durationApproximate: false,
  totals: { input: 133_000, output: 19_000, cacheRead: 2_700_000, cacheWrite: 4_000, cost: 0.056 },
};

test('history renders session headings with prompts permanently nested below', () => {
  const lines = renderHistory({
    month: '2026-09',
    sessions: [summary],
    selected: { kind: 'prompt', sessionPath: '/s1', userEntryId: 'u1' },
    width: 120,
  });

  assert.equal(lines[0]?.trim(), '‹ September 2026 ›');
  assert.ok((lines[0]?.indexOf('‹') ?? 0) > 0);
  assert.equal(
    lines[2],
    'Sep 30 · 10:14 PM–11:42 PM · 22:48 · ↑133k ↓19k R2.7M W4.0k · $0.056',
  );
  assert.equal(lines[3]?.trimEnd(), '    › Fix the search picker and make it reliable');
  assert.equal(
    lines[4],
    '        10:14 PM–10:16 PM · 02:18 · ↑18k ↓1.2k R240k W4.0k · $0.006',
  );
  assert.equal(lines.some((line) => /[▾▸]/.test(line)), false);
});

test('cross-date session header uses middot and arrow with explicit AM PM and no comma', () => {
  const from = new Date(2026, 8, 30, 22, 14).getTime();
  const to = new Date(2026, 9, 2, 8, 5).getTime();
  const text = formatSessionRange(from, to);
  assert.equal(text, 'Sep 30 · 10:14 PM → Oct 2 · 8:05 AM');
  assert.equal(text.includes(','), false);
});

test('prompt items keep nested identity and degrade metadata before prompt text', () => {
  for (const width of [108, 88, 72, 58, 42]) {
    const lines = renderHistory({
      month: '2026-09',
      sessions: [summary],
      selected: { kind: 'prompt', sessionPath: '/s1', userEntryId: 'u1' },
      width,
    });
    assert.equal(lines.every((line) => visibleWidth(line) <= width), true, `width ${width}`);
    const promptIndex = lines.findIndex((line) => line.includes('Fix the'));
    assert.ok(promptIndex >= 0);
    assert.match(lines[promptIndex] ?? '', /› Fix the/);
    assert.match(lines[promptIndex + 1] ?? '', /10:14|2:18/);
  }

  const wideLines = renderHistory({
    month: '2026-09',
    sessions: [summary],
    selected: { kind: 'prompt', sessionPath: '/s1', userEntryId: 'u1' },
    width: 108,
  });
  const widePromptIndex = wideLines.findIndex((line) => line.includes('Fix the'));
  assert.equal(
    wideLines[widePromptIndex + 1],
    '        10:14 PM–10:16 PM · 02:18 · ↑18k ↓1.2k R240k W4.0k · $0.006',
  );

  const narrowLines = renderHistory({
    month: '2026-09',
    sessions: [summary],
    selected: { kind: 'prompt', sessionPath: '/s1', userEntryId: 'u1' },
    width: 58,
  });
  const narrowPromptIndex = narrowLines.findIndex((line) => line.includes('Fix the'));
  assert.doesNotMatch(narrowLines[narrowPromptIndex + 1] ?? '', /W4\.0k/);
});

test('history groups multiple sessions while only prompt rows are selectable', () => {
  const secondRow = {
    ...row,
    sessionId: 's2',
    sessionPath: '/s2',
    userEntryId: 'u2',
    prompt: 'Second prompt',
    startedAt: start - 60_000,
    endedAt: start - 30_000,
  };
  const second: SessionHistorySummary = {
    ...summary,
    sessionId: 's2',
    sessionPath: '/s2',
    rows: [secondRow],
    startedAt: start - 60_000,
    endedAt: start - 30_000,
  };

  const lines = renderHistory({
    month: '2026-09',
    sessions: [summary, second],
    selected: { kind: 'prompt', sessionPath: '/s2', userEntryId: 'u2' },
    width: 108,
  });
  const text = lines.join('\n');

  assert.match(text, /^Sep 30 ·/m);
  assert.match(text, /^      Fix the search picker/m);
  assert.match(text, /^    › Second prompt/m);
  assert.equal((text.match(/› /g) ?? []).length, 1);
});

test('history renders unknown legacy metrics as dashes in session and prompt usage', () => {
  const unknownRow = { ...row, known: { input:false, output:false, cacheRead:false, cacheWrite:false, cost:false } };
  const unknownSummary: SessionHistorySummary = {
    ...summary,
    rows: [unknownRow],
    totalsKnown: { input:false, output:false, cacheRead:false, cacheWrite:false, cost:false },
  };
  const text = renderHistory({
    month:'2026-09',
    sessions:[unknownSummary],
    selected:{kind:'prompt',sessionPath:'/s1',userEntryId:'u1'},
    width:120,
  }).join('\n');

  assert.match(text, /^Sep 30 .* · 22:48 · ↑— ↓— R— W— · \$—/m);
  assert.match(text, /↑— ↓— R— W— · \$—/);
});
