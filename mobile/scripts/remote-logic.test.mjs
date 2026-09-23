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
  return new Function(`${m[1]}; return { pointerGain, nextSticky, fitRect, toStageNormalized, classifyPadTap, remoteKeyRows, clampZoom, clampPan, holdShouldAbort, remoteImeDiff };`)();
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

test('die Grundebene ist eine deutsche Tastatur', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const codes = remoteKeyRows('base').flat().map((k) => k.c);

  const byLabel = Object.fromEntries(remoteKeyRows('base').flat().map((k) => [k.l, k.c]));
  // Positionscodes fuer die deutsche Mac-Belegung: das deutsche z sitzt auf der
  // US-Y-Position. Frueher stand hier KeyZ — der Mac tippte "y" statt "z".
  assert.equal(byLabel.z, 'KeyY', 'z muss die US-Y-Position schicken');
  assert.equal(byLabel.y, 'KeyZ', 'y muss die US-Z-Position schicken');
  assert.ok(codes.includes('Semicolon'), 'Umlaut-Position oe');
  assert.ok(codes.includes('Enter'));
  assert.ok(codes.includes('Backspace'));
  assert.ok(codes.includes('Space'));
});

test('jede Sondertaste ist als haftend gekennzeichnet', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const alle = remoteKeyRows('base').flat();
  const cmd = alle.find((k) => k.c === 'MetaLeft');
  const a = alle.find((k) => k.c === 'KeyA');

  assert.equal(cmd.sticky, true, 'ohne haftende Befehlstaste ist Befehl+Tab nicht tippbar');
  assert.ok(!a.sticky, 'Buchstaben haften nicht');
});

test('die Funktionsebene bringt F1 bis F12', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const codes = remoteKeyRows('fn').flat().map((k) => k.c);
  assert.ok(codes.includes('F1'));
  assert.ok(codes.includes('F12'));
});

test('jede Taste hat eine Beschriftung und entweder einen Positionscode oder einen Textweg', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  for (const layer of ['base', 'num', 'fn', 'sc']) {
    for (const key of remoteKeyRows(layer).flat()) {
      assert.ok(key.l && key.l.length > 0, `Beschriftung fehlt bei ${JSON.stringify(key)}`);
      const hasCode = key.c && key.c.length > 0;
      const hasText = key.s && key.s.length > 0;
      assert.ok(hasCode || hasText, `weder Code noch Textweg bei ${key.l}`);
      assert.ok(!(hasCode && hasText), `${key.l} hat sowohl Code als auch Textweg — genau einer ist erlaubt`);
    }
  }
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

test('die Zeichenebene sendet Satzzeichen ueber den Textweg, nie ueber einen US-Positionscode', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');

  // Positionscodes, die in der Grundebene schon fuer einen Umlaut belegt sind
  // (BracketLeft->ü, Semicolon->ö, Quote->ä). Ein Zeichen-Layout, das versehentlich
  // wieder auf so einen Code zurueckfaellt, wuerde auf einer deutschen
  // Mac-Belegung ein Zeichen tippen statt des draufstehenden Satzzeichens.
  const baseCodes = new Set(remoteKeyRows('base').flat().map((k) => k.c).filter(Boolean));
  const DIGIT_CODES = new Set(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
    'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']);
  const STRUCTURAL_CODES = new Set(['Space', 'Enter', 'Backspace']);

  for (const key of remoteKeyRows('num').flat()) {
    if (key.c) {
      const isDigit = DIGIT_CODES.has(key.c);
      const isStructural = STRUCTURAL_CODES.has(key.c) || key.c.indexOf('__layer:') === 0;
      assert.ok(isDigit || isStructural,
        `"${key.l}" (${key.c}) ist ein Zeichen ueber Positionscode — auf einer deutschen ` +
        'Belegung tippt diese Position etwas anderes als draufsteht; muss ueber den Textweg (s) gehen');
      assert.ok(!baseCodes.has(key.c) || isStructural,
        `Positionscode ${key.c} bei "${key.l}" ist in der Grundebene schon fuer einen Umlaut belegt`);
    } else {
      assert.ok(key.s, `"${key.l}" hat weder Ziffern-Positionscode noch Textweg`);
    }
  }
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

test('die Kuerzel-Ebene: jede Taste ist ein Kuerzel mit Sondertaste und Erklaerung', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const keys = remoteKeyRows('sc').flat().filter((k) => k.combo);
  assert.ok(keys.length >= 20, 'genug Kuerzel');
  for (const k of keys) {
    assert.match(k.combo, /^[msac]+$/, `${k.l}: nur m/s/a/c erlaubt`);
    assert.ok(k.sub, `${k.l}: kurze Erklaerung fehlt`);
  }
  const find = (l) => keys.find((k) => k.l === l);
  assert.equal(find('⌘Z').c, 'KeyY', 'Rueckgaengig auf deutscher Belegung = US-Y-Position');
  assert.equal(find('⌘C').combo, 'm');
  assert.equal(find('⌃C').combo, 'c', 'Abbruch im Terminal ist ctrl, nicht ⌘');
  assert.ok(remoteKeyRows('sc').flat().some((k) => k.c === 'Enter'), '⏎ auch hier erreichbar');
});

test('die Grundebene fuehrt zu Kuerzeln, F-Tasten und zur Handy-Tastatur', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const codes = remoteKeyRows('base').flat().map((k) => k.c);
  for (const c of ['Escape', '__layer:sc', '__layer:fn', '__ime', 'Tab']) assert.ok(codes.includes(c), c);
});

test('die Zeichenebene hat @ # % & ^ ` ß € § °', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const texts = new Set(remoteKeyRows('num').flat().map((k) => k.s).filter(Boolean));
  for (const ch of ['@', '#', '%', '&', '^', '`', 'ß', '€', '§', '°']) assert.ok(texts.has(ch), ch);
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
