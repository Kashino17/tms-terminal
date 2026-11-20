import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo } from './build-info';

test('Stand-Stempel wird gelesen; ohne Stempel null statt Absturz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bi-'));
  assert.equal(readBuildInfo(dir), null);
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ short: 'abc1234', branch: 'feat/x', subject: 's', builtAt: '2026-11-09T00:00:00Z', commit: 'abc1234ffff' }));
  assert.deepEqual(readBuildInfo(dir), { short: 'abc1234', branch: 'feat/x', subject: 's', builtAt: '2026-11-09T00:00:00Z' });
  writeFileSync(join(dir, 'build-info.json'), '{kaputt');
  assert.equal(readBuildInfo(dir), null);
});
