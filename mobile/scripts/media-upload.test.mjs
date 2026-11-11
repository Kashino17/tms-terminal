/**
 * Screenshots-Galerie: Meldungen und Fortschritt beim Hochladen von Bildern
 * und Videos — und dass die Seite den Fortschritt innerhalb EINES Videos zeigt
 * (200 MB brauchen Minuten; „0 von 1“ saehe wie ein Haenger aus).
 *
 * Node fuehrt die .ts-Datei direkt aus (reine Typannotationen werden entfernt).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { uploadSummary, uploadErrorText, overallPercent, MAX_VIDEO_BYTES } from '../src/season2/web/mediaUpload.ts';

const here = dirname(fileURLToPath(import.meta.url));
const none = { images: 0, videos: 0, failed: 0, tooBig: 0 };

test('200 MB liegen unter der Grenze', () => assert.ok(200 * 1024 * 1024 <= MAX_VIDEO_BYTES));

test('nur Bilder: Wortlaut wie bisher', () => {
  assert.equal(uploadSummary({ ...none, images: 1 }), 'Bild hochgeladen und eingefügt');
  assert.equal(uploadSummary({ ...none, images: 3 }), '3 Bilder hochgeladen und eingefügt');
});

test('nur Videos heissen Videos, gemischt heisst Dateien', () => {
  assert.equal(uploadSummary({ ...none, videos: 1 }), 'Video hochgeladen und eingefügt');
  assert.equal(uploadSummary({ ...none, videos: 2 }), '2 Videos hochgeladen und eingefügt');
  assert.equal(uploadSummary({ ...none, images: 2, videos: 1 }), '3 Dateien hochgeladen und eingefügt');
});

test('Teilerfolg: was durchging wird gemeldet, der Rest dahinter', () => {
  assert.equal(
    uploadSummary({ images: 2, videos: 0, failed: 1, tooBig: 1 }),
    '2 Bilder hochgeladen und eingefügt · 1 fehlgeschlagen · 1 Video zu groß (max. 500 MB)',
  );
});

test('nichts ging durch: der Grund steht da', () => {
  assert.equal(uploadSummary({ ...none, failed: 1, firstError: 'Verbindung abgebrochen' }), 'Upload fehlgeschlagen: Verbindung abgebrochen');
  assert.equal(uploadSummary({ ...none, tooBig: 1 }), '1 Video zu groß (max. 500 MB)');
});

test('alter Rechner (antwortet „No file received“) → Hinweis aufs Update', () => {
  assert.match(uploadErrorText(400, 'No file received'), /tms-terminal update/);
  assert.equal(uploadErrorText(400, 'Unsupported file type: text/plain'), 'Unsupported file type: text/plain');
  assert.equal(uploadErrorText(413), 'Zu groß (max. 500 MB)');
  assert.equal(uploadErrorText(0), 'Verbindung abgebrochen');
});

test('Balken: Datei 1 von 1 zu 40 % → 40; Datei 2 von 4 halb → 38', () => {
  assert.equal(overallPercent(0, 1, 0.4), 40);
  assert.equal(overallPercent(1, 4, 0.5), 38);
  assert.equal(overallPercent(0, 3), 0);
  assert.equal(overallPercent(3, 3, 1), 100);
});

// ── Seite: die Bilder-Karte zeigt den Anteil innerhalb der laufenden Datei ──
const bridge = readFileSync(join(here, '../src/season2/web/bridge.js'), 'utf8');
const from = bridge.indexOf('var uploadState = null;');
const to = bridge.indexOf('window.TMSBridge.uploadFinished');
assert.ok(from > 0 && to > from, 'Bilder-Karte fehlt in bridge.js');

function page() {
  const calls = [];
  const window = { TMS_DATA: {}, TMSBridge: { setTool: (k) => calls.push(k) } };
  const fn = new Function('window', 'document', 'icon', 'post', 'activeCardId',
    bridge.slice(from, to) + '\nreturn window;');
  const w = fn(window, { getElementById: () => null }, () => '', () => {}, () => 't1');
  return { w, calls };
}

test('Karte: ein Video zu 42 % → Balken 42 %, Text nennt die Prozent', () => {
  const { w, calls } = page();
  w.TMSBridge.uploadProgress(0, 1, 'srv', 0.42);
  const html = w.buildScreenshotsSheet().html;
  assert.match(html, /width:42%/);
  assert.match(html, /1 von 1 · 42 %/);
  assert.deepEqual(calls, ['screenshots']);
});

test('Karte: zwischen zwei Dateien (kein Anteil) bleibt der Text wie bisher', () => {
  const { w } = page();
  w.TMSBridge.uploadProgress(2, 5, 'srv');
  const html = w.buildScreenshotsSheet().html;
  assert.match(html, /width:40%/);
  assert.match(html, /Lade hoch … 3 von 5</);
});

test('Karte: fertig → kein Fortschritt mehr, Auswahl ist wieder da', () => {
  const { w } = page();
  w.TMSBridge.uploadProgress(0, 1, 'srv', 0.5);
  w.TMSBridge.uploadProgress(1, 1, 'srv');
  const html = w.buildScreenshotsSheet().html;
  assert.doesNotMatch(html, /up-progress/);
  assert.match(html, /shotPickBtn/);
});
