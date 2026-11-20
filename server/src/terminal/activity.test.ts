import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActivityTitle, sameActivity } from './activity';

// Formen aus dem echten Server-Log (über 200 000 Titel-Meldungen ausgewertet).
test('arbeitet: drehendes Zeichen vor dem Thema', () => {
  assert.deepEqual(parseActivityTitle('◐ Screenshot-Sync zwischen MacBook und Windows'), { task: 'Screenshot-Sync zwischen MacBook und Windows', state: 'working' });
  assert.deepEqual(parseActivityTitle('◑ Screenshot-Sync zwischen MacBook und Windows'), { task: 'Screenshot-Sync zwischen MacBook und Windows', state: 'working' });
  assert.deepEqual(parseActivityTitle('⠧ Hikari'), { task: 'Hikari', state: 'working' });
  assert.deepEqual(parseActivityTitle('⠸ ⠸ | Hikari'), { task: 'Hikari', state: 'working' }, 'doppeltes Zeichen und Trenner gehören nicht zum Thema');
});

test('fertig: ✳ vor dem Thema', () => {
  assert.deepEqual(parseActivityTitle('✳ TMS Terminal Sprechblase'), { task: 'TMS Terminal Sprechblase', state: 'done' });
});

test('wartet auf den Nutzer: „Action Required"', () => {
  assert.deepEqual(parseActivityTitle('[ ! ] Action Required | Prüfe Hikari-Backend-Startfehler | Hikari'),
    { task: 'Prüfe Hikari-Backend-Startfehler', state: 'waiting' });
  assert.deepEqual(parseActivityTitle('[!] Action Required | Freigabe nötig'), { task: 'Freigabe nötig', state: 'waiting' });
});

test('nichtssagende Titel zeigen kein Thema, der Zustand bleibt', () => {
  assert.deepEqual(parseActivityTitle('✳ Claude Code'), { task: '', state: 'done' });
  assert.deepEqual(parseActivityTitle('◐ Claude Code'), { task: '', state: 'working' });
});

test('ein normaler Shell-Titel ist keine Aufgabe', () => {
  assert.equal(parseActivityTitle('ayysir@MacBook-Pro-3:~/Developer'), null);
  assert.equal(parseActivityTitle('zsh'), null);
  assert.equal(parseActivityTitle(''), null);
  assert.equal(parseActivityTitle('~/Developer/tms-terminal'), null, 'ein Pfad beginnt mit einem Zeichen, ist aber kein Thema');
  assert.equal(parseActivityTitle('-zsh'), null);
});

test('überlange Titel werden gekürzt, Steuerzeichen entfernt', () => {
  const a = parseActivityTitle('◐ ' + 'x'.repeat(400) + '\u0007');
  assert.equal(a!.task.length, 160);
});

test('sameActivity: das wechselnde Drehzeichen ist kein Wechsel', () => {
  const a = parseActivityTitle('◐ Thema'), b = parseActivityTitle('◑ Thema');
  assert.equal(sameActivity(a, b), true);
  assert.equal(sameActivity(a, parseActivityTitle('✳ Thema')), false);
  assert.equal(sameActivity(null, null), true);
  assert.equal(sameActivity(a, null), false);
});
