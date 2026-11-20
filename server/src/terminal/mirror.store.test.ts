import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveMirrorStates, takeMirrorStates, MIRROR_FILE } from './mirror.store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-store-'));

test('gesicherte Spiegel kommen genau einmal zurück', () => {
  const dir = tmp();
  saveMirrorStates(dir, { a: { cols: 50, rows: 31, data: 'hallo' } }, 1000);
  assert.deepEqual(takeMirrorStates(dir, 2000), { a: { cols: 50, rows: 31, data: 'hallo' } });
  assert.equal(fs.existsSync(path.join(dir, MIRROR_FILE)), false, 'Datei ist verbraucht');
  assert.deepEqual(takeMirrorStates(dir, 2000), {});
});

test('zu alte oder kaputte Sicherung wird verworfen', () => {
  const dir = tmp();
  saveMirrorStates(dir, { a: { cols: 50, rows: 31, data: 'x' } }, 0);
  assert.deepEqual(takeMirrorStates(dir, 7 * 60 * 60 * 1000), {});
  fs.writeFileSync(path.join(dir, MIRROR_FILE), '{kaputt');
  assert.deepEqual(takeMirrorStates(dir), {});
});
