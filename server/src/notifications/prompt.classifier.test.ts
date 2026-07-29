/**
 * Der Klassifikator entscheidet, ob Auto-Approve drücken darf. Deshalb prüfen
 * diese Tests beide Richtungen gleich streng: eine echte Berechtigungsbox MUSS
 * erkannt werden (sonst steht das Terminal), und alles, was keine ist, darf
 * NIEMALS eine Taste bekommen (sonst beantwortet der Server dem Nutzer seine
 * inhaltlichen Fragen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScreen, promptFingerprint } from './prompt.classifier';
import type { ScreenView } from '../terminal/emulator.mirror';

/** Baut einen Bildschirm aus Zeilen. cursorY zeigt standardmäßig auf die letzte Zeile. */
function screen(rows: string[], cursorY = rows.length - 1, cursorX = 0): ScreenView {
  return { rows, cursorX, cursorY, cols: 40 };
}

// Aufgezeichnet aus einer echten Sitzung bei 40 Spalten (siehe Spec).
const CLAUDE_PERMISSION = [
  '  Read(/etc/hosts · lines 1-1)',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, allow reading from etc/',
  '      during this session',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

test('Claude-Berechtigungsbox → permission, Enter', () => {
  const cls = classifyScreen(screen(CLAUDE_PERMISSION, 3, 1));
  assert.equal(cls.kind, 'permission');
  assert.equal(cls.key, '\r');
  assert.equal(cls.question, 'Do you want to proceed?');
  assert.equal(cls.options.length, 3);
  assert.equal(cls.options[0].text, 'Yes');
});

test('Codex-Berechtigung (Allow-Formulierung) → permission', () => {
  const cls = classifyScreen(screen([
    ' Codex wants to run `npm test`',
    '',
    ' ❯ 1. Allow this request and continue',
    '   2. Allow for this session',
    '   3. Cancel this tool call',
    '',
    ' esc to cancel',
  ], 2, 1));
  assert.equal(cls.kind, 'permission');
  assert.equal(cls.key, '\r');
});

test('Gemini-Radioliste ohne Nummern → permission', () => {
  const cls = classifyScreen(screen([
    ' Allow execution of `rm -rf build`?',
    '',
    ' ● Yes, allow once',
    ' ○ Yes, allow always',
    ' ○ No, suggest changes (esc)',
  ], 2, 1));
  assert.equal(cls.kind, 'permission');
  assert.equal(cls.key, '\r');
});

test('Auswahlfrage mit inhaltlichen Antworten → question, keine Taste', () => {
  const cls = classifyScreen(screen([
    ' Welchen Ansatz sollen wir nehmen?',
    ' ❯ 1. Redis als Cache',
    '   2. In-Memory-Map',
    '   3. Gar kein Cache',
    '',
    ' Esc to cancel',
  ], 1, 1));
  assert.equal(cls.kind, 'question');
  assert.equal(cls.key, null);
  assert.equal(cls.question, 'Welchen Ansatz sollen wir nehmen?');
});

test('Formular-Umfrage schlägt die Ja-Option → question', () => {
  // Codex-Formular: die erste Option ist zwar ja-artig, aber es ist ein
  // mehrteiliges Formular. Der Formularhinweis gewinnt immer.
  const cls = classifyScreen(screen([
    ' Question requested',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Answer required fields before submitting.',
  ], 1, 1));
  assert.equal(cls.kind, 'question');
  assert.equal(cls.key, null);
});

test('Nummerierte Aufzählung im Fließtext ist kein Prompt', () => {
  const cls = classifyScreen(screen([
    'Ich habe drei Dinge geändert:',
    '1. Yes-Pfad korrigiert',
    '2. Test ergänzt',
    '3. Doku aktualisiert',
    '',
    '❯ ',
  ], 5, 2));
  assert.equal(cls.kind, 'none');
});

test('Eingabezeile unten, nichts wartet', () => {
  const cls = classifyScreen(screen([
    '  Fertig.',
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
  ], 3, 2));
  assert.equal(cls.kind, 'none');
});

test('[y/N] am Zeilenende mit Cursor dahinter → confirm mit y', () => {
  const cls = classifyScreen(screen([
    'Überschreiben? [y/N] ',
  ], 0, 21));
  assert.equal(cls.kind, 'confirm');
  assert.equal(cls.key, 'y\r');
});

test('[Y/n] am Zeilenende → confirm mit Enter', () => {
  const cls = classifyScreen(screen([
    'Fortfahren? [Y/n] ',
  ], 0, 18));
  assert.equal(cls.kind, 'confirm');
  assert.equal(cls.key, '\r');
});

test('Ja/Nein-Muster mitten im Fließtext ist kein Prompt', () => {
  const cls = classifyScreen(screen([
    'Das Skript fragt am Ende mit [y/N] nach.',
    'Ich habe es angepasst.',
    '',
    '❯ ',
  ], 3, 2));
  assert.equal(cls.kind, 'none');
});

test('Task-Liste unter der Box verdeckt den Prompt nicht', () => {
  const cls = classifyScreen(screen([
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel',
    ' 15 tasks (8 done, 2 in progress)',
    ' ■ Detektor umbauen',
    ' □ Tests ergänzen',
  ], 1, 1));
  assert.equal(cls.kind, 'permission');
});

test('Fingerabdruck bleibt gleich, wenn nur die Auswahl wandert', () => {
  const a = classifyScreen(screen(CLAUDE_PERMISSION, 3, 1));
  const moved = [...CLAUDE_PERMISSION];
  moved[3] = '   1. Yes';
  moved[4] = ' ❯ 2. Yes, allow reading from etc/';
  const b = classifyScreen(screen(moved, 4, 1));
  assert.equal(promptFingerprint(a), promptFingerprint(b));
});

test('Fingerabdruck ändert sich bei einer anderen Frage', () => {
  const a = classifyScreen(screen(CLAUDE_PERMISSION, 3, 1));
  const other = [...CLAUDE_PERMISSION];
  other[0] = '  Bash(rm -rf build)';
  other[2] = ' Do you want to run this command?';
  const b = classifyScreen(screen(other, 3, 1));
  assert.notEqual(promptFingerprint(a), promptFingerprint(b));
});

test('leerer Bildschirm → none', () => {
  assert.equal(classifyScreen(screen(['', '', ''], 0, 0)).kind, 'none');
});
