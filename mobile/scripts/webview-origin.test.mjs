/**
 * Die Season-2-Oberflaeche MUSS in einem sicheren Kontext laufen: nur dort gibt
 * Chrome WebCodecs (VideoDecoder) frei, ohne den der Fernzugriff kein Bild zeigt.
 * Unter http://tms.local fehlte er — Bilder kamen an, nichts wurde gemalt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/season2/SeasonTwoWebRoot.tsx', import.meta.url), 'utf8');

test('die Oberflaeche laedt in einem sicheren Kontext (WebCodecs)', () => {
  // Android: https://tms.local (mixedContentMode erlaubt ws://). iOS: WKWebView kennt kein
  // mixedContentMode und sperrte von https jedes ws:// — http://localhost ist ebenfalls ein
  // sicherer Kontext (VideoDecoder vorhanden) und hat als http-Seite keinen gemischten Inhalt.
  const m = /baseUrl:\s*Platform\.OS === 'ios' \? '([^']+)' : '([^']+)'/.exec(src);
  assert.ok(m, 'baseUrl nicht gefunden');
  assert.equal(m[1], 'http://localhost', `iOS-baseUrl ist ${m[1]} — nur localhost ist unter http ein sicherer Kontext`);
  assert.match(m[2], /^https:\/\//, `Android-baseUrl ist ${m[2]} — ohne https kein VideoDecoder, kein Fernzugriff-Bild`);
});

test('ws:// und http:// zum Server bleiben erlaubt (gemischter Inhalt)', () => {
  assert.match(src, /mixedContentMode="always"/, 'ohne mixedContentMode="always" blockiert die https-Seite die ws://-Verbindung');
});
