import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { winSetLine } from './win.watcher';
import { parseClipLine } from './mac.watcher';

test('Windows-Schreibzeile: genau eine Zeile, Base64 trägt Umlaute, Umbrüche und Anführungszeichen', () => {
  const text = 'a\nb "c" \\ d äöü 😀';
  const line = winSetLine(text);
  assert.equal(line.split('\n').length, 2);
  assert.match(line, /^set [A-Za-z0-9+/=]+\n$/);
  assert.equal(Buffer.from(line.slice(4).trim(), 'base64').toString('utf8'), text);
});

test('Windows-Helfer meldet ASCII-JSON mit \\u-Escapes — derselbe Parser wie am Mac', () => {
  assert.equal(parseClipLine('{"clip":{"text":"Gr\\u00fc\\u00dfe\\nzeile2 \\ud83d\\ude00"}}'), 'Grüße\nzeile2 😀');
});

test('Windows-Helfer startet ohne Konsolenfenster', () => {
  const src = fs.readFileSync(path.join(__dirname, 'win.watcher.ts'), 'utf8');
  assert.match(src, /cmd: 'powershell\.exe'/);
  assert.match(src, /options: \{[^}]*windowsHide: true[^}]*\}/);
});
