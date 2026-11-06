/**
 * Die Season-2-Oberflaeche MUSS in einem sicheren Kontext laufen: nur dort gibt
 * Chrome WebCodecs (VideoDecoder) frei, ohne den der Fernzugriff kein Bild zeigt.
 * Unter http://tms.local fehlte er — Bilder kamen an, nichts wurde gemalt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/season2/SeasonTwoWebRoot.tsx', import.meta.url), 'utf8');

test('die Oberflaeche laedt unter https (sicherer Kontext fuer WebCodecs)', () => {
  const m = /baseUrl:\s*'([^']+)'/.exec(src);
  assert.ok(m, 'baseUrl nicht gefunden');
  assert.match(m[1], /^https:\/\//, `baseUrl ist ${m[1]} — ohne https kein VideoDecoder, kein Fernzugriff-Bild`);
});

test('ws:// und http:// zum Server bleiben erlaubt (gemischter Inhalt)', () => {
  assert.match(src, /mixedContentMode="always"/, 'ohne mixedContentMode="always" blockiert die https-Seite die ws://-Verbindung');
});
