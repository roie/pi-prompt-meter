import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('tests against Pi v1 and documents its minimum runtime versions', () => {
  assert.equal(packageJson.devDependencies['@earendil-works/pi-coding-agent'], '^1.0.0');
  assert.equal(packageJson.devDependencies['@earendil-works/pi-tui'], '^1.0.0');
  assert.match(readme, /Pi `>= 1\.0\.0`/);
  assert.match(readme, /Node\.js `>= 22\.19\.0`/);
  assert.equal(packageJson.engines.node, '>=22.19.0');
});

test('documents meter history, trends, backfill uncertainty, and TUI requirement', () => {
  assert.match(readme, /## History/);
  assert.match(readme, /History\s+Trends/);
  assert.match(readme, /‹ September 2026 ›/);
  assert.match(readme, /≈/);
  assert.match(readme, /date as the primary unit/i);
  assert.match(readme, /Time.*Input.*Output.*Cache.*Cost/s);
  assert.match(readme, /only control is range/i);
  assert.match(readme, /interactive TUI/i);
});

test('requires Pi v1 and TUI peer dependency', () => {
  assert.equal(packageJson.peerDependencies['@earendil-works/pi-coding-agent'], '>=1.0.0');
  assert.equal(packageJson.peerDependencies['@earendil-works/pi-tui'], '>=1.0.0');
});
