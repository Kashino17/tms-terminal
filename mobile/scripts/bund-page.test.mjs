// Bund-Seite: bund.css und bund.js werden in die App eingebündelt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
test('Build bündelt bund.css und bund.js ein', () => {
  const build = readFileSync(join(here, 'build-season2-html.js'), 'utf8');
  assert.match(build, /<link rel="stylesheet" href="bund\.css">/);
  assert.match(build, /<script src="bund\.js"><\/script>/);
});
