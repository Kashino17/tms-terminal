import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHelperLine } from './input.darwin';

const mods = { s: false, c: false, a: false, m: false };

test('relative Bewegung wird in logische Punkte umgerechnet', () => {
  // `scale` ist aufgenommene Pixel je logischem Punkt. Die App liefert das Delta
  // in Bildpixeln; geteilt durch scale ergibt es Punkte, die CGEvent versteht.
  assert.equal(toHelperLine({ t: 'd', dx: 20, dy: -10 }, 2), 'rel 10 -5',
    'bei 2 Pixeln je Punkt legt der Zeiger halb so viele Punkte zurueck');
  assert.equal(toHelperLine({ t: 'd', dx: 20, dy: -10 }, 1), 'rel 20 -10');
  assert.equal(toHelperLine({ t: 'd', dx: 16, dy: 0 }, 0.9259259259259259), 'rel 17 0',
    'Standardstufe 1600/1728: das Bild ist gestaucht, der Zeiger laeuft weiter');
});

test('absolute Bewegung bleibt normiert', () => {
  assert.equal(toHelperLine({ t: 'm', x: 0.25, y: 0.5 }, 2), 'abs 0.25 0.5');
  assert.equal(toHelperLine({ t: 'm', x: -3, y: 9 }, 1), 'abs 0 1', 'Ausreisser werden gekappt');
});

test('Maustasten und Scrollen', () => {
  assert.equal(toHelperLine({ t: 'b', b: 'r', d: true }, 1), 'btn r 1');
  assert.equal(toHelperLine({ t: 'b', b: 'l', d: false }, 1), 'btn l 0');
  assert.equal(toHelperLine({ t: 's', dx: 0, dy: -3 }, 1), 'scroll 0 -3');
});

test('Tasten werden mit Zahlencode und Zustandsflags gesendet', () => {
  assert.equal(toHelperLine({ t: 'k', c: 'KeyA', d: true, mods }, 1), 'key 0 1 0');
  assert.equal(
    toHelperLine({ t: 'k', c: 'KeyC', d: true, mods: { s: false, c: false, a: false, m: true } }, 1),
    'key 8 1 8', 'Befehlstaste setzt Bit 8');
});

test('unbekannte Tasten und Unfug ergeben keine Zeile', () => {
  assert.equal(toHelperLine({ t: 'k', c: 'Kaugummi', d: true, mods }, 1), null);
  assert.equal(toHelperLine({ t: 'zz' } as any, 1), null);
});

test('Text wird als eine Zeile mit maskierten Zeilenumbruechen gesendet', () => {
  assert.equal(toHelperLine({ t: 'x', s: 'Hallo Welt' }, 1), 'text Hallo Welt');
  assert.equal(toHelperLine({ t: 'x', s: 'a\nb' }, 1), 'text a\\nb',
    'ein echter Umbruch wuerde die Zeilenstruktur des Protokolls sprengen');
});
