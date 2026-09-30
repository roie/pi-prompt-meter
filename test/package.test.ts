import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('documents the minimum Pi version that provides settlement boundaries', () => {
  assert.equal(packageJson.devDependencies['@earendil-works/pi-coding-agent'], '^0.87.0');
  assert.match(readme, /Pi `>= 0\.87\.0`/);
});
