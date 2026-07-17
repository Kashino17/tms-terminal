import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeShimDir } from './shim';

test('materializeShimDir creates executable tms-open + command symlinks', () => {
  const dir = materializeShimDir();
  const tmsOpen = path.join(dir, 'tms-open');
  assert.ok(fs.existsSync(tmsOpen), 'tms-open exists');
  assert.ok((fs.statSync(tmsOpen).mode & 0o111) !== 0, 'tms-open is executable');
  for (const name of ['open', 'xdg-open', 'sensible-browser', 'www-browser']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} exists`);
  }
  const src = fs.readFileSync(tmsOpen, 'utf8');
  assert.ok(src.includes('/internal/open-url'));
  assert.ok(src.includes('https://'));
});

test('the generated shim script parses as valid JS (node --check)', () => {
  const dir = materializeShimDir();
  // Throws if the embedded script has a syntax error.
  execFileSync(process.execPath, ['--check', path.join(dir, 'tms-open')]);
});
