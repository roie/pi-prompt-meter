import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { listProjectHistory } from '../src/history/catalog.ts';
import { createTrendDataset, addRowsToTrendDataset, aggregateTrendDatasetSummary } from '../src/trends.ts';

const usage = (input: number) => ({
  input, output: input, cacheRead: input, cacheWrite: input,
  totalTokens: input * 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input / 100 },
});
function appendAssistant(manager: SessionManager, input: number) {
  return manager.appendMessage({
    role: 'assistant', content: [], api: 'openai-responses', provider: 'test', model: 'test',
    timestamp: Date.now(), usage: usage(input), stopReason: 'stop',
  });
}
function appendPrompt(manager: SessionManager, input: number) {
  const at = Date.now();
  const userEntryId = manager.appendMessage({ role: 'user', content: 'Same prompt', timestamp: at });
  manager.appendLabelChange(userEntryId, 'Bookmark');
  appendAssistant(manager, input);
  return manager.appendCustomEntry('pi-prompt-meter/v1', {
    userEntryId, prompt: 'Same prompt', startedAt: at, endedAt: at + 1_000, durationMs: 1_000,
    ...usage(input), cost: input / 100, billing: 'metered', outcome: 'completed', transcript: true,
  });
}
async function projectSummary(catalog: Awaited<ReturnType<typeof listProjectHistory>>) {
  const dataset = createTrendDataset();
  await catalog.forEachSessionRows((rows) => addRowsToTrendDataset(dataset, rows));
  return aggregateTrendDatasetSummary(dataset, '7d').at(-1)!;
}

test('real disk forks count inherited meters once and retain new work on every branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-meter-forks-'));
  try {
    const manager = SessionManager.create(directory, directory);
    const leaf = appendPrompt(manager, 30);
    const originalPath = manager.getSessionFile()!;
    const forkPath = manager.createBranchedSession(leaf)!;
    appendPrompt(manager, 5);
    const nestedLeaf = manager.getLeafId()!;
    const nestedPath = manager.createBranchedSession(nestedLeaf)!;
    appendPrompt(manager, 9);
    const original = SessionManager.open(originalPath, directory);
    appendPrompt(original, 7);
    const catalog = await listProjectHistory(directory, {
      list: (cwd) => SessionManager.list(cwd, directory),
      open: (path) => SessionManager.open(path, directory),
    });
    // Session-local History/navigation keeps copied ancestors, including cached details.
    assert.equal((await catalog.loadDetails(originalPath))?.totals.input, 37);
    assert.equal((await catalog.loadDetails(forkPath))?.totals.input, 35);
    assert.equal((await catalog.loadDetails(nestedPath))?.totals.input, 44);
    const summary = await projectSummary(catalog);
    assert.equal(summary.input, 51);
    assert.equal(summary.output, 51);
    assert.equal(summary.cache, 51);
    assert.ok(Math.abs(summary.cost - 0.51) < 1e-12);
    assert.equal(summary.time, 4_000);
    assert.equal(catalog.warnings.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('matching entries in unrelated sessions are not treated as inherited history', async () => {
  const manager = SessionManager.inMemory('/project');
  appendPrompt(manager, 30);
  const entries = manager.getEntries();
  const now = new Date();
  const catalog = await listProjectHistory('/project', {
    list: async () => ['one', 'two'].map((id) => ({ id, path: `/${id}`, created: now, modified: now })),
    open: () => ({ getEntries: () => entries }),
  });
  const summary = await projectSummary(catalog);
  assert.equal(summary.input, 60);
  assert.equal(summary.time, 2_000);
});

test('a fork before settlement counts new legacy work under a copied user once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-meter-legacy-fork-'));
  try {
    const manager = SessionManager.create(directory, directory);
    const userId = manager.appendMessage({ role: 'user', content: 'Continue', timestamp: Date.now() });
    manager.appendLabelChange(userId, 'Bookmark');
    const leaf = appendAssistant(manager, 30);
    const originalPath = manager.getSessionFile()!;
    const forkPath = manager.createBranchedSession(leaf)!;
    appendAssistant(manager, 5);
    const catalog = await listProjectHistory(directory, {
      list: (cwd) => SessionManager.list(cwd, directory),
      open: (path) => SessionManager.open(path, directory),
    });
    assert.equal((await catalog.loadDetails(originalPath))?.totals.input, 30);
    assert.equal((await catalog.loadDetails(forkPath))?.totals.input, 35);
    const summary = await projectSummary(catalog);
    assert.equal(summary.input, 35);
    assert.equal(summary.output, 35);
    assert.equal(summary.cache, 35);
    assert.ok(Math.abs(summary.cost - 0.35) < 1e-12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
