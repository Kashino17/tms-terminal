import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePendingLen, chooseApprovalKey } from './approval.util';

// Never spell the yes/no markers out: node:test echoes test names and failing
// fixtures back into the terminal, and inside a live AI session the server's own
// prompt detector reads that output — it would take this suite for a real prompt.
const YN_NO = '[y/' + 'N]'; // default No  -> needs an explicit 'y'

// ── Fix #4: pending-input length must self-heal on line-clearing edit keys ──
test('computePendingLen counts printable input and clears on submit/cancel', () => {
  assert.equal(computePendingLen(0, 'abc'), 3, 'printable chars increment');
  assert.equal(computePendingLen(3, '\x7f'), 2, 'backspace decrements');
  assert.equal(computePendingLen(0, '\x7f'), 0, 'never goes negative');
  assert.equal(computePendingLen(5, '\r'), 0, 'Enter clears the line');
  assert.equal(computePendingLen(5, '\x03'), 0, 'Ctrl-C clears the line');
  assert.equal(computePendingLen(5, '\x15'), 0, 'Ctrl-U clears the line');
});

test('computePendingLen resets on word/line kill keys (the desync bug)', () => {
  assert.equal(computePendingLen(8, '\x17'), 0, 'Ctrl-W (delete word) must not leave count stuck');
  assert.equal(computePendingLen(8, '\x0b'), 0, 'Ctrl-K (kill to EOL) must not leave count stuck');
});

test('computePendingLen ignores cursor/escape sequences without desyncing', () => {
  assert.equal(computePendingLen(2, '\x1b[D'), 2, 'left-arrow does not change pending length');
  assert.equal(computePendingLen(2, '\x1b[3~'), 2, 'forward-delete escape does not inflate count');
});

// ── Fix #5: pick the right approval keystroke for the prompt variant ──
test('chooseApprovalKey sends Enter for the standard Claude numbered prompt', () => {
  const claudeBash = 'Doyouwanttoproceed?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
  assert.equal(chooseApprovalKey(claudeBash), '\r');
});

test('chooseApprovalKey sends "y" when the default is No (bare Enter would decline)', () => {
  assert.equal(chooseApprovalKey('Overwrite existing file? ' + YN_NO + ''), 'y\r');
});

test('chooseApprovalKey refuses to auto-press on a free-text input prompt', () => {
  assert.equal(chooseApprovalKey('What should I name it? ›'), null);
});

test('chooseApprovalKey falls back to Enter for generic yes/no confirmations', () => {
  assert.equal(chooseApprovalKey('Are you sure you want to continue?'), '\r');
});

// ── Der Zwischenfall: Prosa ist kein Prompt ─────────────────────────────────
//
// Eine KI im Terminal erklärte, wie Bestätigungs-Prompts funktionieren. Das
// Muster stand damit mitten in ihrer Antwort. chooseApprovalKey durchsuchte das
// ganze Fenster, fand es — und der Server tippte "y" + Enter in die laufende
// Sitzung, wo es als Nachricht abgeschickt wurde. Dutzende Male.
//
// Ein wartender Prompt steht immer auf der LETZTEN Zeile. Steht danach noch
// Text, wartet dort nichts, und es wird nichts gedrückt.

test('chooseApprovalKey presses NOTHING when an AI merely writes about a yes/no prompt', () => {
  const prosa =
    'Ich habe die Ursache gefunden.\n' +
    `Der Server sucht ${YN_NO} im ganzen Fenster.\n` +
    'Deshalb tippt er eine Bestätigung in die Sitzung.\n\n> ';
  assert.equal(chooseApprovalKey(prosa), null);
});

test('chooseApprovalKey presses NOTHING when the marker sits far above the cursor', () => {
  assert.equal(chooseApprovalKey(`${YN_NO} kam hier oben vor.\nDanach kam noch viel Ausgabe.\nUnd noch mehr.`), null);
});

test('chooseApprovalKey presses NOTHING on a blank trailing line (nothing is waiting)', () => {
  assert.equal(chooseApprovalKey('Fertig.\nAlles erledigt.\n\n'), null);
});
