import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHelperLine, parseInputReadyLine } from './input.darwin';

const mods = { s: false, c: false, a: false, m: false };

test('relative Bewegung geht unveraendert durch — Zeigergeschwindigkeit haengt nicht von der Bildqualitaet ab', () => {
  // dx/dy kommen aus der Gestenerkennung der App, nicht aus dem aufgenommenen
  // Bild. Eine Division durch die Aufnahme-Skalierung wuerde denselben Wisch
  // je nach gewaehlter Qualitaetsstufe unterschiedlich weit laufen lassen.
  assert.equal(toHelperLine({ t: 'd', dx: 20, dy: -10 }), 'rel 20 -10');
  assert.equal(toHelperLine({ t: 'd', dx: 12.6, dy: -4.4 }), 'rel 13 -4', 'wird nur gerundet, nicht skaliert');
});

test('absolute Bewegung bleibt normiert', () => {
  assert.equal(toHelperLine({ t: 'm', x: 0.25, y: 0.5 }), 'abs 0.25 0.5');
  assert.equal(toHelperLine({ t: 'm', x: -3, y: 9 }), 'abs 0 1', 'Ausreisser werden gekappt');
});

test('Maustasten und Scrollen', () => {
  assert.equal(toHelperLine({ t: 'b', b: 'r', d: true }), 'btn r 1');
  assert.equal(toHelperLine({ t: 'b', b: 'l', d: false }), 'btn l 0');
  assert.equal(toHelperLine({ t: 's', dx: 0, dy: -3 }), 'scroll 0 -3');
});

test('Tasten werden mit Zahlencode und Zustandsflags gesendet', () => {
  assert.equal(toHelperLine({ t: 'k', c: 'KeyA', d: true, mods }), 'key 0 1 0');
  assert.equal(
    toHelperLine({ t: 'k', c: 'KeyC', d: true, mods: { s: false, c: false, a: false, m: true } }),
    'key 8 1 8', 'Befehlstaste setzt Bit 8');
});

test('unbekannte Tasten und Unfug ergeben keine Zeile', () => {
  assert.equal(toHelperLine({ t: 'k', c: 'Kaugummi', d: true, mods }), null);
  assert.equal(toHelperLine({ t: 'zz' } as any), null);
});

test('Text wird als eine Zeile mit maskierten Zeilenumbruechen gesendet', () => {
  assert.equal(toHelperLine({ t: 'x', s: 'Hallo Welt' }), 'text Hallo Welt');
  assert.equal(toHelperLine({ t: 'x', s: 'a\nb' }), 'text a\\nb',
    'ein echter Umbruch wuerde die Zeilenstruktur des Protokolls sprengen');
});

// Pins the exact wire format for backslash-heavy text (Windows-Pfade, UNC-Freigaben,
// Escape-Folgen). Der Swift-Helfer entmaskiert das in genau einem Durchgang (statt
// zwei nacheinander laufenden String-Ersetzungen, die sich gegenseitig verfaelschen
// wuerden — siehe TmsRemoteHelper.swift `unescapeText`); dieser Test haelt fest, was
// er als Eingabe bekommt, damit das Format nicht unbemerkt driftet.
test('Rueckschraegstrich-lastiger Text bekommt ein eindeutiges Drahtformat', () => {
  assert.equal(toHelperLine({ t: 'x', s: 'C:\\Users\\ayysir' }), 'text C:\\\\Users\\\\ayysir');
  assert.equal(toHelperLine({ t: 'x', s: 'C:\\neuer Ordner' }), 'text C:\\\\neuer Ordner',
    'die Falle: ein einzelner Rueckschraegstrich vor "n" darf nicht wie \\n aussehen');
  assert.equal(toHelperLine({ t: 'x', s: '\\\\Server\\Freigabe' }), 'text \\\\\\\\Server\\\\Freigabe');
  assert.equal(toHelperLine({ t: 'x', s: 'endet auf Backslash\\' }), 'text endet auf Backslash\\\\',
    'ein Text, der auf einen einzelnen Rueckschraegstrich endet, bleibt eindeutig');
});

// Die --input-Bereitschaftszeile hat eine andere Form als die Aufnahme-Bereitschaft
// (`{"ready":{"input":true}}` statt `{"ready":{"width":...}}`), darum die eigene,
// schmalere Zerlegung statt capture.darwin.ts's parseHelperLine wiederzuverwenden.
test('parseInputReadyLine erkennt Bereitschaft und Fehler', () => {
  assert.deepEqual(parseInputReadyLine('{"ready":{"input":true}}'), { kind: 'ready' });
  assert.deepEqual(
    parseInputReadyLine('{"error":{"code":"permission_input","message":"Bedienungshilfen sind nicht freigegeben"}}'),
    { kind: 'error', code: 'permission_input', message: 'Bedienungshilfen sind nicht freigegeben' },
  );
  assert.deepEqual(
    parseInputReadyLine('{"error":{"code":"permission_input"}}'),
    { kind: 'error', code: 'permission_input', message: 'permission_input' },
    'ohne eigene Nachricht faellt es auf den Fehlercode zurueck');
  // C1: ein unbekannter Code darf nicht unveraendert an den Client durchgereicht
  // werden — faellt wie in capture.darwin.ts's parseHelperLine auf capture_unavailable zurueck.
  assert.deepEqual(
    parseInputReadyLine('{"error":{"code":"quatsch","message":"x"}}'),
    { kind: 'error', code: 'capture_unavailable', message: 'x' },
  );
});

test('parseInputReadyLine verschluckt sich nicht an Zwischenausgaben', () => {
  assert.equal(parseInputReadyLine('kein json'), null);
  assert.equal(parseInputReadyLine(''), null);
  assert.equal(parseInputReadyLine('{"ready":{"width":100}}'), null,
    'die Aufnahme-Bereitschaft ist nicht die Eingabe-Bereitschaft');
  assert.equal(parseInputReadyLine('{}'), null);
});
