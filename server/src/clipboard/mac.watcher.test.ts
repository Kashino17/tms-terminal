import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClipLine, setLine } from './mac.watcher';

test('Helferzeile mit Kopie → Text, alles andere → null', () => {
  assert.equal(parseClipLine('{"clip":{"text":"Hallo\\nWelt äöü"}}'), 'Hallo\nWelt äöü');
  assert.equal(parseClipLine('{"ready":{"clipboard":true}}'), null);
  assert.equal(parseClipLine('{"clip":{"text":""}}'), null);
  assert.equal(parseClipLine('kaputt'), null);
});

test('Schreibzeile ist genau eine JSON-Zeile — Zeilenumbrüche im Text brechen sie nicht', () => {
  const line = setLine('a\nb "c" \\ d');
  assert.equal(line.split('\n').length, 2);
  assert.deepEqual(JSON.parse(line), { set: 'a\nb "c" \\ d' });
});
