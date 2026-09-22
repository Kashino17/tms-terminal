import { test } from 'node:test';
import assert from 'node:assert';
import { asPaste, PASTE_MIN_BYTES } from './paste.policy';

const START = '\x1b[200~';
const END = '\x1b[201~';
const big = 'wort '.repeat(600).trim(); // ~3000 Zeichen, wie ein langes Diktat

// Der Fehler: ohne Marker schneidet macOS den Text in 1024-Byte-Lesehäppchen,
// Claude Code macht aus jedem Häppchen einen eigenen Einfügeblock und zeigt nur
// den Rest als Text — "[Pasted text #1][Pasted text #2]425 w426 …".
test('großer Text wird als EIN Einfügeblock verpackt, wenn das Programm es will', () => {
  assert.strictEqual(asPaste(big, true), START + big + END);
});

test('ohne eingeschaltetes Bracketed Paste bleibt alles unverändert', () => {
  assert.strictEqual(asPaste(big, false), big);
});

// Tippen, Wortvorschlag, kurze Antworten: bleiben Tastendrücke wie bisher.
test('kurzer Text und einzelne Tasten bleiben unverändert', () => {
  assert.strictEqual(asPaste('a', true), 'a');
  assert.strictEqual(asPaste('\x7f\x7fHallo', true), '\x7f\x7fHallo');
  assert.strictEqual(asPaste('\r', true), '\r');
});

// Die Eingabezeile schickt die DIFFERENZ: erst Rückschritte, dann neuer Text.
// Die Rückschritte müssen Tasten bleiben, nur der Text wird eingefügt.
test('führende Rückschritte bleiben vor dem Einfügeblock', () => {
  assert.strictEqual(asPaste('\x7f\x7f' + big, true), '\x7f\x7f' + START + big + END);
});

// Steuerzeichen und Escape-Folgen sind Tastenkombinationen, kein Text.
test('Eingaben mit Steuerzeichen werden nie verpackt', () => {
  const withEsc = big + '\x1b[A';
  assert.strictEqual(asPaste(withEsc, true), withEsc);
  const withEnter = big + '\r';
  assert.strictEqual(asPaste(withEnter, true), withEnter);
});

// Die Grenze zählt Bytes, nicht Zeichen: Umlaute sind in UTF-8 zwei Bytes.
test('Grenze in Bytes: Umlaut-Text knapp unter der Zeichengrenze wird trotzdem verpackt', () => {
  const umlauts = 'ä'.repeat(PASTE_MIN_BYTES / 2 + 1); // wenige Zeichen, aber > Grenze in Bytes
  assert.strictEqual(asPaste(umlauts, true), START + umlauts + END);
  const ascii = 'a'.repeat(PASTE_MIN_BYTES - 1);
  assert.strictEqual(asPaste(ascii, true), ascii);
});

test('mehrzeiliger großer Text (Zeilenumbrüche, Tabs) wird verpackt', () => {
  const lines = (big + '\n').repeat(2) + '\tEnde';
  assert.strictEqual(asPaste(lines, true), START + lines + END);
});
