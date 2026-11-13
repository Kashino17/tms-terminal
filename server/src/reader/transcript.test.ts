import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswers, MAX_ANSWERS, MAX_ANSWER_CHARS } from './transcript';

// Zeilenformen aus einem echten Verlauf (Claude Code 2.1.3xx, ~/.claude/projects/…/*.jsonl).
const user = (text: string, extra: object = {}) => JSON.stringify({ type: 'user', timestamp: '2026-11-11T03:00:00.000Z', message: { role: 'user', content: text }, ...extra });
const userBlocks = (text: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-11T03:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } });
const say = (text: string, stop: string, at = '2026-11-11T03:05:00.000Z', extra: object = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] }, ...extra });
const think = (stop: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'thinking', thinking: 'geheim' }] } });
const tool = () => JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const noise = () => JSON.stringify({ type: 'api-request-blob', data: 'x'.repeat(50) });

test('eine Runde: Anweisung, Zwischentexte, Werkzeuge — die Antwort ist der Schlusstext', () => {
  const r = parseAnswers([
    user('Bau den Bericht'), think('tool_use'), say('Ich sehe mir die Daten an.', 'tool_use'), tool(), toolResult(),
    noise(), think('end_turn'), say('## Fertig\n\nDer Bericht steht.', 'end_turn', '2026-11-11T03:07:00.000Z'),
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
  ].join('\n'));
  assert.equal(r.answers.length, 1);
  assert.deepEqual(r.answers[0], { prompt: 'Bau den Bericht', md: '## Fertig\n\nDer Bericht steht.', at: Date.parse('2026-11-11T03:07:00.000Z') });
  assert.equal(r.open, false);
});

test('mehrere Runden bleiben in Reihenfolge, die neueste zuletzt', () => {
  const r = parseAnswers([user('eins'), say('A', 'end_turn'), userBlocks('zwei'), tool(), toolResult(), say('B', 'end_turn')].join('\n'));
  assert.deepEqual(r.answers.map((a) => [a.prompt, a.md]), [['eins', 'A'], ['zwei', 'B']]);
});

test('läuft die letzte Runde noch, zählt sie nicht als Antwort', () => {
  const r = parseAnswers([user('eins'), say('A', 'end_turn'), user('zwei'), say('Ich fange an.', 'tool_use'), tool(), toolResult()].join('\n'));
  assert.deepEqual(r.answers.map((a) => a.md), ['A']);
  assert.equal(r.open, true, 'die App zeigt dann: letzte fertige Antwort, Claude arbeitet weiter');
});

test('was der Nutzer nicht getippt hat, ist keine Anweisung', () => {
  const r = parseAnswers([
    user('echte Frage'), say('A', 'end_turn'),
    user('<task-notification>\n<task-id>b1</task-id></task-notification>'), say('Der Hintergrundlauf ist fertig.', 'end_turn'),
    user('Another Claude session sent a message: …', { isMeta: true }), say('Eine andere Sitzung meldet sich.', 'end_turn'),
    user('<command-name>/model</command-name>'),
    user('<local-command-stdout>Set model</local-command-stdout>'),
  ].join('\n'));
  assert.deepEqual(r.answers.map((a) => [a.prompt, a.md]), [
    ['echte Frage', 'A'], ['', 'Der Hintergrundlauf ist fertig.'], ['', 'Eine andere Sitzung meldet sich.'],
  ]);
  assert.equal(r.open, false, 'ein Befehl wie /model öffnet keine Runde');
});

test('eingeschobene Hinweise des Systems gehören nicht zur Anweisung', () => {
  const r = parseAnswers([user('<system-reminder>intern</system-reminder>\nMach das bitte.\n<system-reminder>mehr</system-reminder>'), say('ok', 'end_turn')].join('\n'));
  assert.equal(r.answers[0].prompt, 'Mach das bitte.');
});

test('Unter-Agenten und Denkblöcke tauchen nicht auf', () => {
  const r = parseAnswers([user('frage'), say('vom Unter-Agenten', 'end_turn', undefined, { isSidechain: true }), think('end_turn'), say('Antwort', 'end_turn')].join('\n'));
  assert.deepEqual(r.answers.map((a) => a.md), ['Antwort']);
});

test('ein Schlusstext in mehreren Stücken wird zusammengesetzt', () => {
  const r = parseAnswers([user('frage'), say('Teil 1', 'end_turn'), say('Teil 2', 'end_turn')].join('\n'));
  assert.equal(r.answers[0].md, 'Teil 1\n\nTeil 2');
});

test('ohne Schlussmarke (abgebrochen, dann neue Anweisung) zählt der letzte Text der Runde', () => {
  const r = parseAnswers([user('eins'), say('Zwischenstand', 'tool_use'), tool(), toolResult(), user('zwei'), say('B', 'end_turn')].join('\n'));
  assert.deepEqual(r.answers.map((a) => [a.prompt, a.md]), [['eins', 'Zwischenstand'], ['zwei', 'B']]);
});

test('kaputte und abgeschnittene Zeilen werden übersprungen', () => {
  const r = parseAnswers(['":"assistant","message":{"content":[{"type":"text","text":"abgeschnitten', user('frage'), '{kaputt', say('Antwort', 'end_turn')].join('\n'));
  assert.deepEqual(r.answers.map((a) => a.md), ['Antwort']);
});

test('Grenzen: höchstens die letzten Antworten, überlange Texte werden gekürzt', () => {
  const lines: string[] = [];
  for (let i = 0; i < MAX_ANSWERS + 5; i++) lines.push(user('f' + i), say('a' + i, 'end_turn'));
  lines.push(user('lang'), say('y'.repeat(MAX_ANSWER_CHARS + 500), 'end_turn'));
  const r = parseAnswers(lines.join('\n'));
  assert.equal(r.answers.length, MAX_ANSWERS);
  assert.equal(r.answers[0].prompt, 'f6', 'die ältesten fallen weg');
  const last = r.answers[r.answers.length - 1];
  assert.ok(last.md.length <= MAX_ANSWER_CHARS + 80 && last.md.endsWith('gekürzt)'), 'gekürzt und so gekennzeichnet');
});

test('leerer Verlauf', () => {
  assert.deepEqual(parseAnswers(''), { answers: [], open: false });
});
