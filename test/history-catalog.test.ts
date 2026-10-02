import test from 'node:test';
import assert from 'node:assert/strict';

import { listProjectHistory, monthKeyFromMs } from '../src/history/catalog.ts';

const entry = (id: string, ms: number, prompt = id) => ({
  id,
  parentId: null,
  timestamp: new Date(ms).toISOString(),
  type: 'message',
  message: { role: 'user', content: prompt },
});

function fakeSource(sessionDefs: Array<{
  path: string;
  id: string;
  createdMs: number;
  modifiedMs: number;
  entries: any[];
  fail?: boolean;
}>) {
  const opens = new Map<string, number>();
  return {
    opens,
    async list(_cwd: string) {
      return sessionDefs.map((session) => ({
        path: session.path,
        id: session.id,
        created: new Date(session.createdMs),
        modified: new Date(session.modifiedMs),
      }));
    },
    open(path: string) {
      opens.set(path, (opens.get(path) ?? 0) + 1);
      const found = sessionDefs.find((session) => session.path === path);
      if (!found || found.fail) throw new Error('bad session');
      return { getEntries: () => found.entries };
    },
  };
}

test('catalog builds from metadata without opening session files', async () => {
  const start = new Date(2026, 8, 30).getTime();
  const source = fakeSource([
    { path: '/s1', id: 's1', createdMs: start, modifiedMs: start, entries: [entry('u1', start)] },
  ]);
  const catalog = await listProjectHistory('/project', source as any);
  assert.equal(catalog.sessionCount, 1);
  assert.equal(source.opens.size, 0);
});

test('initial month prefers current month with history otherwise latest active month', async () => {
  const sep = new Date(2026, 8, 30, 12).getTime();
  const aug = new Date(2026, 7, 20, 12).getTime();
  const source = fakeSource([
    { path: '/aug', id: 'aug', createdMs: aug, modifiedMs: aug, entries: [entry('u-aug', aug)] },
    { path: '/sep', id: 'sep', createdMs: sep, modifiedMs: sep, entries: [entry('u-sep', sep)] },
  ]);
  const catalog = await listProjectHistory('/project', source as any);
  assert.equal(await catalog.initialMonth(new Date(2026, 8, 30, 18)), '2026-09');
  assert.equal(await catalog.initialMonth(new Date(2026, 9, 5, 18)), '2026-09');
});

test('empty catalog has no initial month and month paging is calendar based', async () => {
  const catalog = await listProjectHistory('/project', fakeSource([]) as any);
  assert.equal(await catalog.initialMonth(new Date(2026, 8, 30)), undefined);
  assert.equal(catalog.shiftMonth('2026-09', -1), '2026-08');
  assert.equal(catalog.shiftMonth('2026-12', 1), '2027-01');
});

test('session month comes from first represented prompt start', async () => {
  const created = new Date(2026, 8, 30, 23, 59).getTime();
  const promptStart = new Date(2026, 9, 1, 0, 1).getTime();
  const source = fakeSource([
    {
      path: '/cross',
      id: 'cross',
      createdMs: created,
      modifiedMs: promptStart + 1_000,
      entries: [entry('u1', promptStart)],
    },
  ]);
  const catalog = await listProjectHistory('/project', source as any);
  const summary = await catalog.load('/cross');
  assert.equal(monthKeyFromMs(summary!.startedAt!), '2026-10');
  assert.equal(catalog.monthFor(summary!), '2026-10');
});

test('header cache uses path plus modification time', async () => {
  const start = new Date(2026, 8, 30).getTime();
  const defs = [
    { path: '/s1', id: 's1', createdMs: start, modifiedMs: start, entries: [entry('u1', start)] },
  ];
  const source = fakeSource(defs);
  const catalog = await listProjectHistory('/project', source as any);

  await catalog.load('/s1');
  await catalog.load('/s1');
  assert.equal(source.opens.get('/s1'), 1);

  defs[0]!.modifiedMs += 1_000;
  catalog.updateModified('/s1', defs[0]!.modifiedMs);
  await catalog.load('/s1');
  assert.equal(source.opens.get('/s1'), 2);
});

test('corrupt session is isolated as a warning instead of throwing', async () => {
  const start = new Date(2026, 8, 30).getTime();
  const source = fakeSource([
    { path: '/bad', id: 'bad', createdMs: start, modifiedMs: start, entries: [], fail: true },
  ]);
  const catalog = await listProjectHistory('/project', source as any);
  await assert.doesNotReject(() => catalog.load('/bad'));
  assert.equal(await catalog.load('/bad'), undefined);
  assert.match(catalog.warnings[0]?.message ?? '', /bad session/);
});

test('month headers expose no prompt rows and expanded details are cached after first load', async () => {
  const start = new Date(2026, 8, 30, 10).getTime();
  const source = fakeSource([
    { path: '/lazy', id: 'lazy', createdMs: start, modifiedMs: start, entries: [entry('u1', start)] },
  ]);
  const catalog = await listProjectHistory('/project', source as any);

  const headers = await catalog.sessionsForMonth('2026-09');
  assert.equal(headers[0]?.rows.length, 0);
  assert.equal(source.opens.get('/lazy'), 1);

  const details = await catalog.loadDetails('/lazy');
  assert.equal(details?.rows.length, 1);
  assert.equal(source.opens.get('/lazy'), 2);

  const again = await catalog.loadDetails('/lazy');
  assert.equal(again?.rows.length, 1);
  assert.equal(source.opens.get('/lazy'), 2);

  const headersAgain = await catalog.sessionsForMonth('2026-09');
  assert.equal(headersAgain[0]?.rows.length, 0);
  assert.equal(source.opens.get('/lazy'), 2);
});

test('detail cache invalidates when the session modification time changes', async () => {
  const start = new Date(2026, 8, 30, 10).getTime();
  const defs = [
    { path: '/detail', id: 'detail', createdMs: start, modifiedMs: start, entries: [entry('u1', start)] },
  ];
  const source = fakeSource(defs);
  const catalog = await listProjectHistory('/project', source as any);

  await catalog.loadDetails('/detail');
  await catalog.loadDetails('/detail');
  assert.equal(source.opens.get('/detail'), 1);

  defs[0]!.modifiedMs += 1_000;
  catalog.updateModified('/detail', defs[0]!.modifiedMs);
  await catalog.loadDetails('/detail');
  assert.equal(source.opens.get('/detail'), 2);
});

test('trend scanning is sequential and does not retain uncached session details', async () => {
  const a = new Date(2026, 8, 29, 10).getTime();
  const b = new Date(2026, 8, 30, 10).getTime();
  const source = fakeSource([
    { path: '/a', id: 'a', createdMs: a, modifiedMs: a, entries: [entry('ua', a)] },
    { path: '/b', id: 'b', createdMs: b, modifiedMs: b, entries: [entry('ub', b)] },
  ]);
  const catalog: any = await listProjectHistory('/project', source as any);
  const batchSizes: number[] = [];

  await catalog.forEachSessionRows((rows: any[]) => batchSizes.push(rows.length));

  assert.deepEqual(batchSizes, [1, 1]);
  assert.equal('allRows' in catalog, false);
  assert.equal(source.opens.get('/a'), 1);
  assert.equal(source.opens.get('/b'), 1);

  await catalog.loadDetails('/a');
  assert.equal(source.opens.get('/a'), 2);
});

test('trend scanning reuses an already cached expanded session', async () => {
  const start = new Date(2026, 8, 30, 10).getTime();
  const source = fakeSource([
    { path: '/cached', id: 'cached', createdMs: start, modifiedMs: start, entries: [entry('u1', start)] },
  ]);
  const catalog = await listProjectHistory('/project', source as any);

  await catalog.loadDetails('/cached');
  assert.equal(source.opens.get('/cached'), 1);

  await catalog.forEachSessionRows(() => {});
  assert.equal(source.opens.get('/cached'), 1);
});


test('a corrupt session does not prevent other sessions from contributing to Trends', async () => {
  const start = new Date(2026, 8, 30, 10).getTime();
  const source = fakeSource([
    { path: '/bad-trend', id: 'bad', createdMs: start, modifiedMs: start, entries: [], fail: true },
    { path: '/good-trend', id: 'good', createdMs: start, modifiedMs: start, entries: [entry('u1', start)] },
  ]);
  const catalog = await listProjectHistory('/project', source as any);
  const visited: string[] = [];

  await assert.doesNotReject(() =>
    catalog.forEachSessionRows((rows) => {
      visited.push(...rows.map((row) => row.userEntryId));
    }),
  );

  assert.deepEqual(visited, ['u1']);
  assert.match(catalog.warnings[0]?.message ?? '', /bad session/);
});
