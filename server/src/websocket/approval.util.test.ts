import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePendingLen, chooseApprovalKey, evaluateApprovalGate,
  TYPING_PAUSE_MS, PENDING_STALE_MS,
} from './approval.util';

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

// ── Echter Vorfall (2026-07-13, 18:16 UTC, Log-bewiesen): Der Nutzer tippte
//    eine FRAGE in die Eingabezeile, machte 2s Pause — und die alte Regel
//    "letzte Zeile enthält ein Fragezeichen → Enter" schickte seinen halb
//    getippten Text ab. Dreimal. Ohne erkennbare Ja-Option wird ab jetzt
//    grundsätzlich NICHTS gedrückt — nur benachrichtigt. ──
test('chooseApprovalKey drückt NICHTS bei bloßen Fragezeichen/Confirm-Wörtern ohne Ja-Option', () => {
  assert.equal(chooseApprovalKey('Are you sure you want to continue?'), null);
  assert.equal(chooseApprovalKey('kannst du mir sagen wie das funktioniert?'), null);
  assert.equal(chooseApprovalKey('soll ich das deployment starten oder lieber warten?'), null);
});

// ── Multiple-Choice/Select ist KEIN Ja/Nein: gleiche Box-Optik, gleicher
//    "Esc to cancel"-Footer — aber Option 1 ist eine inhaltliche Antwort.
//    Auto-Approve würde blind die erste Auswahl treffen. Stattdessen: null,
//    die App zeigt ihren Rückfrage-Dialog. ──
test('chooseApprovalKey drückt NICHTS bei einer Auswahlfrage (Optionen ohne Ja)', () => {
  const select = 'WelcheChecks sollen laufen?\n❯1.Tests\n2.Lint\n3.Typecheck\nEsctocancel';
  assert.equal(chooseApprovalKey(select), null);
  const glued = 'Whichmodel?\n❯1.claude-sonnet\n2.claude-opus\nEsctocancel·Tabtoamend';
  assert.equal(chooseApprovalKey(glued), null);
});

test('chooseApprovalKey: "Esc to cancel" allein (ohne sichtbare Ja-Option) reicht NICHT für Enter', () => {
  assert.equal(chooseApprovalKey('irgendein Kontext\nEsctocancel·Tabtoamend'), null);
});

// ── Andere AI-CLIs: gleiche Semantik, leicht andere Wortwahl. Gemini CLI
//    nummeriert mit "Yes, allow once"; Codex fragt mit end-anchored [y/N]. ──
test('chooseApprovalKey erkennt Gemini-CLI-Stil (1. Yes, allow once)', () => {
  const gemini = 'Apply this change?\n❯ 1. Yes, allow once\n  2. Yes, allow always\n  3. No (esc)';
  assert.equal(chooseApprovalKey(gemini), '\r');
});

test('chooseApprovalKey: [y/N]/[Y/n] nur am Zeilenende, nicht mitten in Prosa', () => {
  assert.equal(chooseApprovalKey('Proceed with install? ' + YN_NO), 'y\r');
  assert.equal(chooseApprovalKey('Der Text erwähnt ' + YN_NO + ' nur beiläufig im Satz.'), null);
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

// ── Der Zuverlässigkeits-Bug (echter Vorfall, 2026-07-13): Der Fast-Path
//    erwischt den Prompt oft schon, BEVOR "Esc to cancel" nachgeladen ist —
//    die zuletzt eingetroffene Zeile ist dann noch eine leere Zeile NACH den
//    Optionen. Der alte Code las das als "frische leere Zeile, da wartet
//    nichts" und drückte 30+ Minuten lang nie Enter (Server-Log bewiesen). ──
test('chooseApprovalKey erkennt den Prompt auch wenn das Fenster auf einer Leerzeile endet', () => {
  assert.equal(chooseApprovalKey(NUMBERED + '\n'), '\r');
  assert.equal(chooseApprovalKey(NUMBERED + '\n\n'), '\r');
  assert.equal(chooseApprovalKey(NUMBERED + '\n   \n'), '\r');
});

test('chooseApprovalKey presses NOTHING when EVERY line is genuinely blank', () => {
  assert.equal(chooseApprovalKey('\n\n   \n'), null);
});

// ── Der Zuverlässigkeits-Bug: „Nutzer tippt" durfte eine Freigabe nur
//    VERSCHIEBEN, nie verschlucken. Die Gate-Funktion macht die Entscheidung
//    pur und wiederholbar — der Handler ruft sie beim Retry einfach nochmal. ──

const NUMBERED = 'Doyouwanttoproceed?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';

test('gate: frisches Tippen pausiert nur (retrybar), sendet nicht', () => {
  assert.equal(evaluateApprovalGate({ window: NUMBERED, pendingLen: 0, sinceInputMs: 500 }).gate, 'paused-typing');
});

test('gate: unversendeter Text auf der Zeile blockiert (retrybar)', () => {
  assert.equal(evaluateApprovalGate({ window: NUMBERED, pendingLen: 3, sinceInputMs: 5000 }).gate, 'blocked-pending');
});

test('gate: veralteter Pending-Zähler blockiert nicht mehr', () => {
  const r = evaluateApprovalGate({ window: NUMBERED, pendingLen: 3, sinceInputMs: PENDING_STALE_MS + 1 });
  assert.deepEqual(r, { gate: 'send', key: '\r' });
});

test('gate: ruhige Lage sendet Enter für den Standard-Prompt', () => {
  const r = evaluateApprovalGate({ window: NUMBERED, pendingLen: 0, sinceInputMs: TYPING_PAUSE_MS + 1 });
  assert.deepEqual(r, { gate: 'send', key: '\r' });
});

test('gate: Freitext-Rückfrage bleibt notify-only (kein Retry nötig)', () => {
  const r = evaluateApprovalGate({ window: 'Wie soll die Datei heißen? ›', pendingLen: 0, sinceInputMs: 99_999 });
  assert.equal(r.gate, 'notify-only');
});

test('chooseApprovalKey presses NOTHING on a blank trailing line (nothing is waiting)', () => {
  assert.equal(chooseApprovalKey('Fertig.\nAlles erledigt.\n\n'), null);
});

// ── Task-Liste unter der Box (Screenshot 2026-07-20 20:27): Claude Code
//    rendert seine Todo-Liste UNTER der Berechtigungsbox. Die Optionszeilen
//    rutschen damit aus dem 12-Zeilen-Tail — das Gate sagte notify-only,
//    obwohl eine glasklare Ja-Option vorausgewählt wartete. ──
const TODO_FOOTER =
  '\n15tasks(8done,2inprogress,5\n' +
  'open)\n' +
  '■SDDTask8:PhaseCVer…\n' +
  '■SDDTask10:AdsListVie…\n' +
  '□SDDTask11:PhaseAVe…\n' +
  '□SDDTask12:Shoporuor…\n' +
  '□SDDTask13:ad_product…\n' +
  '…+2pending,8completed\n';

test('chooseApprovalKey sendet Enter trotz Task-Liste unter der Box', () => {
  const win =
    'Doyouwanttoproceed?\n' +
    '❯1.Yes\n' +
    '2.Yes,allowreadingfromTMSSolvado/fromthisproject\n' +
    '3.No\n\n' +
    'Esctocancel·Tabtoamend·ctrl+e\n' +
    'toexplain\n' + TODO_FOOTER;
  assert.equal(chooseApprovalKey(win), '\r');
});

test('Auswahlfrage + Task-Liste bleibt null (kein blindes Enter)', () => {
  const sel = 'Whichmodel?\n❯1.claude-sonnet\n2.claude-opus\nEsctocancel' + TODO_FOOTER;
  assert.equal(chooseApprovalKey(sel), null);
});

// ── Prosa-Aufzählung ÜBER einer inhaltlichen Auswahlbox: die "1. Ja"-Zeile
//    aus dem Fließtext darf nicht als Option 1 der Box gelten — es zählt der
//    JÜNGSTE nummerierte Block (die wartende Box ist immer der letzte). ──
test('Prosa-Ja-Aufzählung über einer Auswahlbox erzwingt kein Enter', () => {
  const w =
    'Meine Empfehlung:\n' +
    '1.Yes,zuerst das Gate fixen\n' +
    '2.Dann der Rest\n\n' +
    'Whichcheck?\n❯1.Tests\n2.Lint\nEsctocancel';
  assert.equal(chooseApprovalKey(w), null);
});
