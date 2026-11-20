/**
 * Terminal-Text: wann sind zwei Bildschirmzeilen in Wahrheit eine?
 * Die Beispielzeilen sind echte Ausgabe von Claude Code 2.1.280 bei 42 Spalten
 * (gemessen): Claude bricht lange Zeilen SELBST um und rueckt die Fortsetzung
 * um zwei Leerzeichen ein — kein Terminal-Umbruch (isWrapped = false).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MOCKUP = new globalThis.URL('../../mockups/season2/liquid-deck/index.html', import.meta.url);
function load() {
  const html = fs.readFileSync(MOCKUP, 'utf8');
  const m = /\/\/ ── TMS-TEST-EXPORT: termText ──([\s\S]*?)\/\/ ── \/TMS-TEST-EXPORT ──/.exec(html);
  assert.ok(m, 'Block termText fehlt im Mockup');
  return new Function(`var window; ${m[1]}; return { stitchRows, stitchLinks, copyRange, rangeAt };`)();
}
const URL = 'https://github.com/Kashino17/tms-terminal/releases/download/v1.114.0/TMS-Terminal-v1.114.0.apk?raw=true&x=1234567890';
const row = (text, wrapped = false) => ({ text, wrapped });

// So sieht Claudes Antwort mit der URL aus (volle Breite, Fortsetzung eingerueckt).
const CLAUDE = [
  row('⏺ https://github.com/Kashino17/tms-termina'),
  row('  l/releases/download/v1.114.0/TMS-Termina'),
  row('  l-v1.114.0.apk?raw=true&x=1234567890'),
];
// Und so im eigenen Eingabefeld: Text endet 2 Spalten vor dem Rand (Rahmen).
const PROMPT = [
  row('  https://github.com/Kashino17/tms-termin  '),
  row('  al/releases/download/v1.114.0/TMS-Termi  '),
  row('  nal-v1.114.0.apk?raw=true&x=1234567890   '),
];

test('Link ueber drei von Claude umgebrochene Zeilen wird als EIN Link erkannt', () => {
  const { stitchLinks } = load();
  const links = stitchLinks(CLAUDE, 42);
  for (const r of [0, 1, 2]) assert.equal(links[r][0].url, URL, `Zeile ${r}`);
  assert.deepEqual([links[1][0].from, links[1][0].to], [2, 42], 'die Einrueckung gehoert nicht zum Link');
});

test('dasselbe im Eingabefeld mit Rahmen und Fuellzeichen', () => {
  const { stitchLinks } = load();
  const links = stitchLinks(PROMPT, 42);
  for (const r of [0, 1, 2]) assert.equal(links[r][0].url, URL, `Zeile ${r}`);
});

test('Kopieren ueber den Link: vollstaendig, ohne Umbrueche und Leerzeichen', () => {
  const { copyRange } = load();
  assert.equal(copyRange(CLAUDE, 42, 0, 2, 2, 999), URL);
  assert.equal(copyRange(PROMPT, 42, 0, 2, 2, 999), URL);
});

test('Kopieren nur des zweiten Teils eines Links kennt trotzdem den Zusammenhang', () => {
  const { copyRange } = load();
  assert.equal(copyRange(CLAUDE, 42, 1, 2, 2, 999), URL.slice(URL.indexOf('l/releases')));
});

test('normaler Text behaelt seine Zeilenumbrueche, auch wenn er bis zum Rand reicht', () => {
  const { copyRange } = load();
  const prose = [row('⏺ Das ist ein langer Satz, der genau bis'), row('  zum Rand reicht und dann weitergeht.')];
  assert.equal(prose[0].text.length >= 39, true);
  assert.equal(copyRange(prose, 42, 0, 0, 1, 999), '⏺ Das ist ein langer Satz, der genau bis\n  zum Rand reicht und dann weitergeht.');
});

test('echter Terminal-Umbruch (isWrapped) wird immer direkt verbunden', () => {
  const { copyRange } = load();
  const rows = [row('abcdefghij'), row('klmnop', true)];
  assert.equal(copyRange(rows, 10, 0, 0, 1, 999), 'abcdefghijklmnop');
});

test('zeichengenau: Anfang und Ende mitten in einer Zeile', () => {
  const { copyRange } = load();
  const rows = [row('$ git status'), row('On branch feat/fernzugriff')];
  assert.equal(copyRange(rows, 80, 0, 2, 0, 5), 'git');
  assert.equal(copyRange(rows, 80, 0, 6, 1, 9), 'status\nOn branch');
});

test('Fuellzeichen am Zeilenende werden beim Kopieren abgeschnitten', () => {
  const { copyRange } = load();
  const rows = [row('eins      '), row('zwei   ')];
  assert.equal(copyRange(rows, 80, 0, 0, 1, 999), 'eins\nzwei');
});

test('rangeAt: langer Druck auf einen Link markiert den GANZEN Link ueber alle Zeilen', () => {
  const { rangeAt } = load();
  assert.deepEqual(rangeAt(CLAUDE, 42, 1, 10), { sr: 0, sc: 2, er: 2, ec: CLAUDE[2].text.length });
});

test('rangeAt: langer Druck auf ein Wort markiert das Wort', () => {
  const { rangeAt } = load();
  const rows = [row('$ git status --short')];
  assert.deepEqual(rangeAt(rows, 80, 0, 7), { sr: 0, sc: 6, er: 0, ec: 12 });
  assert.deepEqual(rangeAt(rows, 80, 0, 5), { sr: 0, sc: 5, er: 0, ec: 5 }, 'auf Leerraum: leer, Griffe am Punkt');
});

// Claude bricht nur Woerter hart um, die LAENGER als eine Zeile sind — ein
// kuerzeres wandert komplett in die naechste Zeile. Ein 35-Zeichen-Link, der bei
// 42 Spalten am Rand endet, ist also zu Ende und nicht zerschnitten.
test('ein Link, der zufaellig genau am Rand endet, schluckt nicht die naechste Zeile', () => {
  const { stitchLinks } = load();
  const rows = [row('siehe https://example.com/abcdefghijklmno'), row('  und dann gehts weiter')];
  const links = stitchLinks(rows, 42);
  assert.equal(links[0][0].url, 'https://example.com/abcdefghijklmno');
  assert.equal(links[1], undefined);
});

// Echter Fall vom 05.11. (Screenshot 17:28): Claude schrieb bei 39 Spalten eine
// Aufzaehlung mit Links (Fortsetzung 4 Leerzeichen eingerueckt). Angezeigt wird
// danach bei 50 Spalten (feste Breite seit v1.124.0) — der Verlauf behaelt seine
// alte Breite. Die Rand-Regel darf deshalb nicht nur die AKTUELLE Breite kennen.
const LIST39 = [
  row('⏺ The mockup is reworked and live on'),
  row('  the same links:'),
  row('  - Normal (own domain, enough'),
  row('    credits):'),
  row('    https://macbook-pro-2.taile64a95.ts'),
  row('    .net:8494/preview-email.html?v=voll'),
  row('  - Without own domain: https://macbook'),
  row('    -pro-2.taile64a95.ts.net:8494/previ'),
  row('    ew-email.html?v=ohne-domain'),
  row('  - 0 credits, mails waiting: https://m'),
  row('    acbook-pro-2.taile64a95.ts.net:8494'),
  row('    /preview-email.html?v=warten'),
  row(''),
  row('  What changed:'),
];
const BASE = 'https://macbook-pro-2.taile64a95.ts.net:8494/preview-email.html?v=';

for (const cols of [39, 50]) {
  test(`Aufzaehlungs-Links (bei 39 Spalten geschrieben) sind bei ${cols} Spalten je EIN Link`, () => {
    const { stitchLinks } = load();
    const links = stitchLinks(LIST39, cols);
    for (const r of [4, 5]) assert.equal(links[r]?.[0]?.url, BASE + 'voll', `Zeile ${r}`);
    for (const r of [6, 7, 8]) assert.equal(links[r]?.at(-1)?.url, BASE + 'ohne-domain', `Zeile ${r}`);
    for (const r of [9, 10, 11]) assert.equal(links[r]?.at(-1)?.url, BASE + 'warten', `Zeile ${r}`);
    assert.deepEqual([links[5][0].from, links[5][0].to], [4, 39], 'Einrueckung gehoert nicht zum Link');
  });
}

test('kurze Zeilen mit Link am Ende werden NICHT mit der naechsten Zeile verklebt', () => {
  const { stitchLinks } = load();
  for (const cols of [39, 50]) {
    // realistische Umgebung: normal umbrochener Fliesstext bis an den Rand
    const prose = 'Das ist ganz normaler Text, der umgebrochen wird und weiter laeuft bis zum Rand';
    const lines = []; let cur = '⏺';
    for (const w of prose.split(' ')) { if ((cur + ' ' + w).length > cols) { lines.push(cur); cur = ' '; } cur += ' ' + w; }
    lines.push(cur);
    const rows = [...lines.map((l) => row(l)), row('  Siehe https://example.com/a'), row('  README.md liegt daneben.')];
    const at = lines.length;
    assert.equal(stitchLinks(rows, cols)[at][0].url, 'https://example.com/a', `${cols} Spalten`);
  }
});

test('eine einzelne lange Zeile ist kein Beleg fuer einen schmaleren Rand', () => {
  const { stitchLinks } = load();
  const rows = [row('  Siehe https://example.com/a'), row('  README.md liegt daneben.')];
  assert.equal(stitchLinks(rows, 50)[0][0].url, 'https://example.com/a');
});
