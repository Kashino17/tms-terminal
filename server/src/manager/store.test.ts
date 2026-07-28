import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStore, writeStore, takeCorruptionReports } from './store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-store-'));
}

test('write then read round-trips', () => {
  const dir = tmpDir();
  writeStore('x.json', { items: [1, 2, 3] }, dir);
  assert.deepEqual(readStore('x.json', { items: [] as number[] }, dir), { items: [1, 2, 3] });
});

test('missing file returns the fallback and does not create the file', () => {
  const dir = tmpDir();
  assert.deepEqual(readStore('nope.json', { items: [7] }, dir), { items: [7] });
  assert.equal(fs.existsSync(path.join(dir, 'nope.json')), false);
});

test('written file is not world-readable', () => {
  const dir = tmpDir();
  writeStore('perm.json', { a: 1 }, dir);
  const mode = fs.statSync(path.join(dir, 'perm.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('corrupt file is quarantined, fallback returned, corruption reported', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ this is not json');
  takeCorruptionReports(); // drain anything left over from other tests

  const result = readStore('bad.json', { items: [] as string[] }, dir);

  assert.deepEqual(result, { items: [] }, 'fallback must be returned');
  assert.equal(fs.existsSync(path.join(dir, 'bad.json')), false, 'original must be moved away');
  const quarantined = fs.readdirSync(dir).filter(f => f.startsWith('bad.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'exactly one quarantine file');

  const reports = takeCorruptionReports();
  assert.equal(reports.length, 1);
  assert.match(reports[0], /bad\.json/);
});

test('takeCorruptionReports drains the list', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad2.json'), 'nope');
  takeCorruptionReports();
  readStore('bad2.json', {}, dir);
  assert.equal(takeCorruptionReports().length, 1);
  assert.equal(takeCorruptionReports().length, 0, 'second call must be empty');
});
