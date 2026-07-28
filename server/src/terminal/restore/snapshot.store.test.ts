import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Snapshot } from './snapshot.types';
import { readSnapshot, writeSnapshot, consumeSnapshot, SNAPSHOT_FILE } from './snapshot.store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-snap-'));
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    capturedAt: 1_700_000_000_000,
    serverPid: 4242,
    entries: [{
      id: 'sess-1', label: 'Shell 1', cwd: '/Users/x/Desktop/TMS Terminal',
      cols: 80, rows: 24, claude: { sessionId: 'claude-abc', status: 'idle' },
    }],
    ...over,
  };
}

test('write then read round-trips including the claude mark', () => {
  const dir = tmpDir();
  writeSnapshot(snap(), dir);
  const back = readSnapshot(dir)!;
  assert.equal(back.serverPid, 4242);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].claude?.sessionId, 'claude-abc');
  assert.equal(back.entries[0].cwd, '/Users/x/Desktop/TMS Terminal');
});

test('a missing file yields null, not a crash', () => {
  assert.equal(readSnapshot(tmpDir()), null);
});

test('a corrupt file yields null and is moved aside, never deleted', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), '{ kaputt');
  assert.equal(readSnapshot(dir), null);
  assert.equal(fs.existsSync(path.join(dir, SNAPSHOT_FILE)), false, 'original weggeräumt');
  const quarantined = fs.readdirSync(dir).filter(f => f.startsWith(`${SNAPSHOT_FILE}.corrupt-`));
  assert.equal(quarantined.length, 1, 'als .corrupt-<zeit> aufgehoben');
});

test('the written file is not world-readable', () => {
  const dir = tmpDir();
  writeSnapshot(snap(), dir);
  assert.equal(fs.statSync(path.join(dir, SNAPSHOT_FILE)).mode & 0o777, 0o600);
});

test('consumeSnapshot returns the content AND removes the file', () => {
  const dir = tmpDir();
  writeSnapshot(snap(), dir);
  const taken = consumeSnapshot(dir)!;
  assert.equal(taken.entries.length, 1);
  assert.equal(fs.existsSync(path.join(dir, SNAPSHOT_FILE)), false,
    'sofort weg — sonst reisst ein Absturz mitten in der Wiederherstellung bei jedem Start erneut Terminals auf');
  assert.equal(consumeSnapshot(dir), null, 'ein zweiter Versuch findet nichts mehr');
});

test('an entry without a claude mark survives the round-trip', () => {
  const dir = tmpDir();
  writeSnapshot(snap({ entries: [{ id: 's2', cwd: '/tmp', cols: 100, rows: 30 }] }), dir);
  const back = readSnapshot(dir)!;
  assert.equal(back.entries[0].claude, undefined);
});
