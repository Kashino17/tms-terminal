import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClipboardStore, MAX_ITEMS, MAX_CHARS } from './clipboard.store';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-')), 'clipboard.json');

test('neuester Eintrag steht oben, mit Quelle', () => {
  const s = new ClipboardStore(tmpFile(), 0);
  s.add('eins', 'mac', 1);
  s.add('zwei', 'phone', 2);
  assert.deepEqual(s.list().map((x) => [x.text, x.source]), [['zwei', 'phone'], ['eins', 'mac']]);
});

test('derselbe Text erneut kopiert rückt nach oben statt doppelt', () => {
  const s = new ClipboardStore(tmpFile(), 0);
  const first = s.add('hallo', 'mac', 1)!;
  s.add('anderes', 'mac', 2);
  const again = s.add('hallo', 'phone', 3)!;
  assert.deepEqual(again.removed, [first.item.id]);
  assert.deepEqual(s.list().map((x) => x.text), ['hallo', 'anderes']);
  assert.equal(s.list()[0].source, 'phone');
});

test('höchstens 40 Einträge — der älteste fällt raus und wird gemeldet', () => {
  const s = new ClipboardStore(tmpFile(), 0);
  const oldest = s.add('t0', 'mac', 0)!;
  for (let i = 1; i < MAX_ITEMS; i++) s.add('t' + i, 'mac', i);
  const ch = s.add('neu', 'mac', 99)!;
  assert.equal(s.list().length, MAX_ITEMS);
  assert.deepEqual(ch.removed, [oldest.item.id]);
});

test('leere, nur-Leerzeichen und riesige Texte werden nicht aufgenommen', () => {
  const s = new ClipboardStore(tmpFile(), 0);
  assert.equal(s.add('', 'mac'), null);
  assert.equal(s.add('  \n ', 'mac'), null);
  assert.equal(s.add('x'.repeat(MAX_CHARS + 1), 'mac'), null);
  assert.deepEqual(s.list(), []);
});

test('überlebt einen Neustart, Datei nur für den Besitzer lesbar', async () => {
  const f = tmpFile();
  const a = new ClipboardStore(f, 0);
  a.add('bleibt', 'phone', 5);
  await a.flush();
  assert.deepEqual(new ClipboardStore(f, 0).list().map((x) => x.text), ['bleibt']);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('löschen und leeren', () => {
  const s = new ClipboardStore(tmpFile(), 0);
  const a = s.add('a', 'mac')!, b = s.add('b', 'mac')!;
  assert.equal(s.remove(a.item.id), true);
  assert.equal(s.remove('gibtsnicht'), false);
  assert.deepEqual(s.clear(), [b.item.id]);
  assert.deepEqual(s.list(), []);
});

test('kaputte Datei → leer statt Absturz', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{kaputt');
  assert.deepEqual(new ClipboardStore(f, 0).list(), []);
});
