import { test } from 'node:test';
import assert from 'node:assert';
import { planReattach, wantsSnapshot, CLEAR_SEQUENCE } from './reattach.policy';

// Breite unverändert, Puffer sauber → wie bisher: nur nachspülen.
test('gleiche Breite, kein Überlauf -> replay ohne clear', () => {
  assert.deepStrictEqual(planReattach(80, 80, false), { clear: false, replay: true });
});

// Breite hat sich geändert (Falten/Drehen/Schriftgröße während der Abwesenheit):
// der Puffer wurde für die ALTE Breite gemalt — abspielen ergäbe nur Müll.
// Stattdessen Bildschirm leeren; das SIGWINCH des folgenden Resize lässt die
// laufende TUI ein frisches Bild malen.
test('andere Breite -> clear ohne replay', () => {
  assert.deepStrictEqual(planReattach(80, 40, false), { clear: true, replay: false });
});

test('andere Breite mit Überlauf -> weiterhin clear ohne replay', () => {
  assert.deepStrictEqual(planReattach(40, 90, true), { clear: true, replay: false });
});

// Puffer übergelaufen (Client steigt mitten im Strom ein): erst leeren, dann
// abspielen — die cursor-relativen Frames laufen so gegen einen sauberen
// Schirm statt gegen alte Historie.
test('gleiche Breite mit Überlauf -> clear und replay', () => {
  assert.deepStrictEqual(planReattach(80, 80, true), { clear: true, replay: true });
});

// Selbstheilungs-Pfade (Input auf abgehängter Session) kennen die Client-Maße
// nicht — Verhalten von heute beibehalten, nichts zerstören.
test('unbekannte Client-Breite -> replay ohne clear', () => {
  assert.deepStrictEqual(planReattach(80, undefined, false), { clear: false, replay: true });
  assert.deepStrictEqual(planReattach(80, undefined, true), { clear: false, replay: true });
});

// ── Snapshot-Weg (mit Spiegel-Emulator) ──────────────────────────────────────
// Nur wenn der Client-Stand vom Server-Stand abweichen KANN, lohnt sich ein
// Clear+Snapshot — sonst zuckte der Karteninhalt bei jedem Vordergrund-Wechsel.
test('nichts verpasst, gleiche Breite -> kein Snapshot (Client bleibt unangetastet)', () => {
  assert.equal(wantsSnapshot(80, 80, 0, false), false);
  assert.equal(wantsSnapshot(80, undefined, 0, false), false);
});

test('verpasste Ausgabe -> Snapshot, egal welche Breite', () => {
  assert.equal(wantsSnapshot(80, 80, 1, false), true);
  assert.equal(wantsSnapshot(80, 40, 12_000, false), true);
  assert.equal(wantsSnapshot(80, undefined, 5, false), true);
});

test('Breitenwechsel ohne verpasste Ausgabe -> Snapshot (Client ist falsch umgebrochen)', () => {
  assert.equal(wantsSnapshot(80, 40, 0, false), true);
});

test('Puffer-Überlauf -> Snapshot (der Anfang des Stroms fehlt)', () => {
  assert.equal(wantsSnapshot(80, 80, 0, true), true);
});

// Die Clear-Sequenz muss auch die Scrollback-Historie leeren (CSI 3 J) —
// sonst bleiben die gestapelten alten Frames ja gerade stehen.
test('CLEAR_SEQUENCE leert Schirm, Historie und Attribute', () => {
  assert.ok(CLEAR_SEQUENCE.includes('\x1b[2J'), 'Schirm leeren');
  assert.ok(CLEAR_SEQUENCE.includes('\x1b[3J'), 'Scrollback leeren');
  assert.ok(CLEAR_SEQUENCE.includes('\x1b[0m'), 'SGR zurücksetzen');
  assert.ok(CLEAR_SEQUENCE.includes('\x1b[H'), 'Cursor nach Hause');
});
