import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('documents the minimum Pi version that provides settlement boundaries', () => {
  assert.equal(packageJson.devDependencies['@earendil-works/pi-coding-agent'], '^0.99.2');
  assert.match(readme, /Pi `>= 0\.99\.2`/);
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

test('requires Pi 0.99.2 APIs and TUI peer dependency', () => {
  assert.equal(packageJson.peerDependencies['@earendil-works/pi-coding-agent'], '>=0.99.2');
  assert.equal(packageJson.peerDependencies['@earendil-works/pi-tui'], '>=0.99.2');
});
