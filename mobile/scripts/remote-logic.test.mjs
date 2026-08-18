/**
 * Prueft die reinen Rechenfunktionen des Mockups.
 *
 * Der Mockup ist bewusst eine einzige HTML-Datei — deshalb schneidet dieser Test
 * den markierten Block heraus und wertet ihn aus, statt die Architektur fuer die
 * Testbarkeit aufzubrechen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MOCKUP = '/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html';

function loadBlock(name) {
  const html = fs.readFileSync(MOCKUP, 'utf8');
  const re = new RegExp(`// ── TMS-TEST-EXPORT: ${name} ──([\\s\\S]*?)// ── /TMS-TEST-EXPORT ──`);
  const m = re.exec(html);
  assert.ok(m, `Block "${name}" fehlt im Mockup — Markierungen nicht entfernen`);
  return new Function(`${m[1]}; return { pointerGain, nextSticky, fitRect, classifyPadTap };`)();
}

test('der markierte Block laesst sich laden', () => {
  const api = loadBlock('remoteMath');
  assert.equal(typeof api.pointerGain, 'function');
  assert.equal(typeof api.nextSticky, 'function');
  assert.equal(typeof api.fitRect, 'function');
  assert.equal(typeof api.classifyPadTap, 'function');
});

test('fitRect legt das Bild seitenrichtig in die Flaeche', () => {
  const { fitRect } = loadBlock('remoteMath');
  // Breites Bild in hohe Flaeche: links und rechts voll, oben/unten Rand.
  assert.deepEqual(fitRect(1600, 1000, 400, 800), { x: 0, y: 275, w: 400, h: 250 });
  // Genau passendes Seitenverhaeltnis: kein Rand.
  assert.deepEqual(fitRect(1600, 800, 400, 200), { x: 0, y: 0, w: 400, h: 200 });
});

test('pointerGain bleibt bei langsamem Wischen bei 1:1', () => {
  const { pointerGain } = loadBlock('remoteMath');
  assert.equal(pointerGain(0), 1, 'Stillstand darf nicht verstaerken');
  assert.equal(pointerGain(0.05), 1, 'langsam heisst pixelgenau');
});

test('pointerGain verstaerkt schnelles Wischen, aber gedeckelt', () => {
  const { pointerGain } = loadBlock('remoteMath');
  assert.equal(pointerGain(10), 4, 'die Verstaerkung ist bei 4 gedeckelt');
  assert.ok(pointerGain(1) > 1 && pointerGain(1) < 4, 'dazwischen gleitend');
  assert.ok(pointerGain(2) > pointerGain(1), 'schneller heisst immer weiter');
});

test('pointerGain behandelt beide Richtungen gleich', () => {
  const { pointerGain } = loadBlock('remoteMath');
  assert.equal(pointerGain(-2), pointerGain(2));
});

test('nextSticky laeuft aus/einmal/fest im Kreis', () => {
  const { nextSticky } = loadBlock('remoteMath');
  assert.equal(nextSticky('off'), 'once');
  assert.equal(nextSticky('once'), 'locked');
  assert.equal(nextSticky('locked'), 'off');
});

test('classifyPadTap: ein Finger, kurz, kaum Weg -> Linksklick', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(1, false, 100, 3, 250, 10), 'left');
  assert.equal(classifyPadTap(0, false, 50, 0, 250, 10), 'left', 'kein Finger gezaehlt zaehlt wie einer');
});

test('classifyPadTap: zwei Finger gleichzeitig, kurz, kaum Weg -> Rechtsklick', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(2, false, 100, 3, 250, 10), 'right');
});

test('classifyPadTap: Weg ueber dem Schwellwert -> kein Klick (das war Wischen/Scrollen)', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(1, false, 100, 11, 250, 10), null);
  assert.equal(classifyPadTap(2, false, 100, 50, 250, 10), null);
});

test('classifyPadTap: zu lange gehalten -> kein Klick', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(1, false, 300, 0, 250, 10), null);
});

test('classifyPadTap: waehrend eines Halte-Ziehens -> kein Klick', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(1, true, 50, 0, 250, 10), null);
});

test('classifyPadTap: drei oder mehr Finger -> keine zugesagte Geste, kein Klick', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(3, false, 50, 0, 250, 10), null);
});
