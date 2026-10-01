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
  return new Function(`${m[1]}; return { pointerGain, nextSticky, fitRect, toStageNormalized, classifyPadTap, remoteShortcutRows, imeKeyFor, clampZoom, clampPan, holdShouldAbort, remoteImeDiff, remoteAltsFor, classifyMultiGesture };`)();
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

test('classifyPadTap: Dauer-Schwelle genau auf tapMs (250) greift schon, nicht erst danach', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(1, false, 249, 0, 250, 10), 'left', 'knapp unter der Schwelle ist noch ein Tippen');
  assert.equal(classifyPadTap(1, false, 250, 0, 250, 10), null, 'genau auf der Schwelle zaehlt schon nicht mehr');
  assert.equal(classifyPadTap(1, false, 251, 0, 250, 10), null, 'knapp ueber der Schwelle erst recht nicht');
});

test('classifyPadTap: Weg-Schwelle genau auf tapSlopPx (10) zaehlt noch als Tippen', () => {
  const { classifyPadTap } = loadBlock('remoteMath');
  assert.equal(classifyPadTap(1, false, 0, 9, 250, 10), 'left', 'knapp unter der Schwelle ist noch ein Tippen');
  assert.equal(classifyPadTap(1, false, 0, 10, 250, 10), 'left', 'genau auf der Schwelle zaehlt noch als Tippen');
  assert.equal(classifyPadTap(1, false, 0, 11, 250, 10), null, 'knapp ueber der Schwelle nicht mehr');
});

test('toStageNormalized rechnet Bildschirmpunkte in Bildkoordinaten', () => {
  const { toStageNormalized } = loadBlock('remoteMath');
  const box = { x: 20, y: 10, w: 200, h: 100 };   // Bild sitzt mit Rand in der Buehne

  assert.deepEqual(toStageNormalized(20, 10, box), { x: 0, y: 0 }, 'linke obere Ecke');
  assert.deepEqual(toStageNormalized(220, 110, box), { x: 1, y: 1 }, 'rechte untere Ecke');
  assert.deepEqual(toStageNormalized(120, 60, box), { x: 0.5, y: 0.5 }, 'Mitte');
});

test('toStageNormalized meldet Punkte neben dem Bild als ungueltig', () => {
  const { toStageNormalized } = loadBlock('remoteMath');
  const box = { x: 20, y: 10, w: 200, h: 100 };
  assert.equal(toStageNormalized(5, 60, box), null, 'im schwarzen Rand links');
  assert.equal(toStageNormalized(120, 200, box), null, 'unterhalb des Bildes');
});

test('clampZoom bleibt zwischen 1 und 3', () => {
  const { clampZoom } = loadBlock('remoteMath');
  assert.equal(clampZoom(0.4), 1, 'kleiner als das Bild ergibt keinen Sinn');
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(9), 3, 'darueber wird es nur noch matschig');
});

test('clampPan laesst bei 1x gar kein Verschieben zu', () => {
  const { clampPan } = loadBlock('remoteMath');
  assert.equal(clampPan(120, 1, 400), 0, 'unvergroessert gibt es nichts zu verschieben');
});

test('clampPan haelt das vergroesserte Bild im Rahmen', () => {
  const { clampPan } = loadBlock('remoteMath');
  // Bei 2x ist das Bild 800 breit, der Rahmen 400 — je 200 Spielraum pro Seite.
  assert.equal(clampPan(0, 2, 400), 0);
  assert.equal(clampPan(500, 2, 400), 200, 'nach rechts abgefangen');
  assert.equal(clampPan(-500, 2, 400), -200, 'nach links abgefangen');
});

test('holdShouldAbort: Zittern um den Startpunkt bricht den langen Druck NICHT ab', () => {
  const { holdShouldAbort } = loadBlock('remoteMath');
  // Viele kleine Zick-Zack-Schritte um den Aufsetzpunkt — die aufsummierte
  // Pfadlaenge waere laengst ueber der Schwelle (8px), die Entfernung zum
  // Startpunkt bleibt aber klein. Genau die Kollision, die diese Funktion
  // gegenueber der alten Einzelschritt-/Summen-Pruefung vermeidet.
  assert.equal(holdShouldAbort(100, 100, 103, 101, 8), false);
  assert.equal(holdShouldAbort(100, 100, 97, 104, 8), false);
});

test('holdShouldAbort: echte Bewegung ueber die Schwelle bricht ab', () => {
  const { holdShouldAbort } = loadBlock('remoteMath');
  assert.equal(holdShouldAbort(100, 100, 130, 100, 8), true);
});

test('holdShouldAbort: genau auf der Schwelle bricht NICHT ab (nur echtes Ueberschreiten zaehlt)', () => {
  const { holdShouldAbort } = loadBlock('remoteMath');
  assert.equal(holdShouldAbort(100, 100, 108, 100, 8), false, 'Abstand genau 8 -> noch kein Abbruch');
  assert.equal(holdShouldAbort(100, 100, 108.01, 100, 8), true, 'knapp darueber bricht ab');
});

test('Handy-Tastatur: Tippen, Autokorrektur, Rueckschritt, Enter', () => {
  const { remoteImeDiff } = loadBlock('remoteMath');
  const Z = '\u200b';
  assert.deepEqual(remoteImeDiff(Z, Z + 'h'), { back: 0, parts: ['h'] }, 'ein Zeichen');
  assert.deepEqual(remoteImeDiff(Z + 'teh', Z + 'the'), { back: 2, parts: ['he'] }, 'Autokorrektur');
  assert.deepEqual(remoteImeDiff(Z + 'ab', Z + 'a'), { back: 1, parts: [''] }, 'Rueckschritt im Text');
  assert.deepEqual(remoteImeDiff(Z, ''), { back: 1, parts: [''] }, 'Rueckschritt bei leerem Feld loescht den Platzhalter');
  assert.deepEqual(remoteImeDiff(Z + 'ls', Z + 'ls\n'), { back: 0, parts: ['', ''] }, 'Enter');
  assert.deepEqual(remoteImeDiff(Z, Z + 'Hallo Welt'), { back: 0, parts: ['Hallo Welt'] }, 'Wischtippen: ganzes Wort');
});

test('langes Halten: Varianten wie auf der Handy-Tastatur', () => {
  const { remoteAltsFor } = loadBlock('remoteMath');
  assert.ok(remoteAltsFor('s').includes('ß'), 's → ß');
  assert.equal(remoteAltsFor('a')[0], 'ä', 'Umlaut zuerst');
  assert.equal(remoteAltsFor('a', true)[0], 'Ä', 'mit ⇧ gross');
  assert.equal(remoteAltsFor('s', true)[0], 'ẞ', 'ß gross ist ẞ, nicht SS');
  assert.ok(remoteAltsFor('"').includes('„'), 'deutsche Anfuehrungszeichen');
  assert.deepEqual(remoteAltsFor('x'), [], 'ohne Varianten: nichts');
});

test('Mehrfinger-Gesten wie auf dem Mac-Trackpad', () => {
  const { classifyMultiGesture: g } = loadBlock('remoteMath');
  assert.equal(g(3, -120, 5, 1, 70), 'swipe-left', 'drei Finger nach links');
  assert.equal(g(4, 110, -8, 1, 70), 'swipe-right', 'vier Finger nach rechts');
  assert.equal(g(3, 4, -90, 1, 70), 'swipe-up', 'hoch = Mission Control');
  assert.equal(g(3, 0, 95, 1, 70), 'swipe-down');
  assert.equal(g(5, 3, 2, 0.55, 70), 'pinch-in', 'fuenf Finger zusammen = Spotlight');
  assert.equal(g(4, 0, 0, 1.6, 70), 'pinch-out', 'auseinander = Schreibtisch');
  assert.equal(g(3, 30, 10, 1, 70), null, 'zu kurz: noch nichts');
  assert.equal(g(3, 80, 75, 1, 70), null, 'schraeg: unentschieden');
  assert.equal(g(2, -150, 0, 1, 70), null, 'zwei Finger sind Scrollen, keine Geste');
  assert.equal(g(3, 0, 0, 0.5, 70), null, 'Zusammenziehen erst ab vier Fingern');
});

test('Kuerzelleiste: Reihe 1 fest mit esc, ⇥, Sondertasten (haftend) und Pfeilen', () => {
  const { remoteShortcutRows } = loadBlock('remoteMath');
  const [r1, r2] = remoteShortcutRows();
  assert.equal(r1.scroll, undefined, 'Reihe 1 scrollt nicht');
  assert.deepEqual(r1.keys.map((k) => k.c), ['Escape', 'Tab', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft',
    'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']);
  for (const k of r1.keys.filter((k) => /Left$/.test(k.c) && !/^Arrow/.test(k.c))) assert.ok(k.sticky && k.m, k.l + ' haftet');
  assert.equal(r2.scroll, true, 'Reihe 2 scrollt quer');
});

test('Kuerzelleiste: Reihe 2 bringt Handy-Tastatur, Zwischenablage, F1–F12 und Kuerzel', () => {
  const { remoteShortcutRows } = loadBlock('remoteMath');
  const keys = remoteShortcutRows()[1].keys;
  const codes = keys.map((k) => k.c);
  assert.deepEqual(codes.slice(0, 3), ['__ime', '__clip', '__mic'], 'Tastatur, 📋, 🎙 zuerst');
  for (let i = 1; i <= 12; i++) assert.ok(codes.includes('F' + i), 'F' + i);
  for (const c of ['Enter', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown', 'Delete']) assert.ok(codes.includes(c), c);
  const combos = keys.filter((k) => k.combo);
  assert.ok(combos.length >= 20);
  for (const k of combos) {
    assert.match(k.combo, /^[mcas]+$/, k.l);
    assert.ok(k.sub, k.l + ' erklaert sich');
  }
  const z = combos.find((k) => k.l === '⌘Z');
  assert.equal(z.c, 'KeyY', '⌘Z auf der deutschen Z-Position');
});

test('Kuerzel ueber die Handy-Tastatur: Zeichen → Taste (deutsche Mac-Belegung)', () => {
  const { imeKeyFor } = loadBlock('remoteMath');
  assert.deepEqual(imeKeyFor('c'), { c: 'KeyC', shift: false });
  assert.deepEqual(imeKeyFor('C'), { c: 'KeyC', shift: true });
  assert.deepEqual(imeKeyFor('z'), { c: 'KeyY', shift: false }, 'deutsches z = US-Y-Position');
  assert.deepEqual(imeKeyFor('y'), { c: 'KeyZ', shift: false });
  assert.deepEqual(imeKeyFor('5'), { c: 'Digit5', shift: false });
  assert.deepEqual(imeKeyFor(' '), { c: 'Space', shift: false });
  assert.equal(imeKeyFor('ä'), null);
  assert.equal(imeKeyFor('ab'), null, 'nur ein Zeichen');
  assert.equal(imeKeyFor(''), null);
});
