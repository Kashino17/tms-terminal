process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Outbox } from '../outbox/outbox';
import {
  parseOffsets, handleAgendaTool, handleEntriesTool, buildOverview, handleNotifyUser,
} from './stufe1.handlers';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-tools-'));
}

function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test('parseOffsets reads the comma-separated form the model produces', () => {
  assert.deepEqual(parseOffsets('2880,1440,60'), [2880, 1440, 60]);
  assert.deepEqual(parseOffsets(' 60 , 0 '), [60, 0]);
  assert.deepEqual(parseOffsets(''), [0], 'empty means "remind me at the appointment"');
  assert.deepEqual(parseOffsets(undefined), [0]);
  assert.deepEqual(parseOffsets('abc,60'), [60], 'junk entries are dropped, not fatal');
});

test('agenda add creates the appointment and confirms it in German', () => {
  const dir = tmpDir();
  const out = handleAgendaTool({
    action: 'add', title: 'Zahnarzt', at: '2026-08-04T14:00', reminder_offsets: '2880,1440,60',
  }, at(2026, 7, 28), dir);

  assert.match(out, /Zahnarzt/);
  assert.match(out, /04\.08\.2026/);
  assert.match(out, /3 Erinnerung/);

  const list = handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir);
  assert.match(list, /Zahnarzt/);
});

test('agenda add rejects a malformed date instead of storing nonsense', () => {
  const dir = tmpDir();
  const out = handleAgendaTool({ action: 'add', title: 'X', at: 'nächste Woche' }, at(2026, 7, 28), dir);
  assert.match(out, /Fehler/);
  assert.match(out, /YYYY-MM-DDTHH:MM/);
  assert.match(handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir), /Keine Termine/);
});

test('a yearly birthday is listed for the coming year', () => {
  const dir = tmpDir();
  handleAgendaTool({
    action: 'add', title: 'Geburtstag Mama', at: '2026-07-30T00:00',
    all_day: 'true', repeat: 'yearly', reminder_offsets: '1440',
  }, at(2026, 7, 28), dir);
  const list = handleAgendaTool({ action: 'list', days: '7' }, at(2026, 7, 28), dir);
  assert.match(list, /Geburtstag Mama/);
  assert.match(list, /jährlich/i);
});

test('agenda delete removes the appointment', () => {
  const dir = tmpDir();
  handleAgendaTool({ action: 'add', title: 'Weg damit', at: '2026-08-04T14:00' }, at(2026, 7, 28), dir);
  const list = handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir);
  const id = /ID: ([0-9a-f-]{36})/.exec(list)![1];
  assert.match(handleAgendaTool({ action: 'delete', id }, at(2026, 7, 28), dir), /gelöscht/i);
  assert.match(handleAgendaTool({ action: 'list' }, at(2026, 7, 28), dir), /Keine Termine/);
});

test('agenda rejects an unknown action', () => {
  const dir = tmpDir();
  assert.match(handleAgendaTool({ action: 'frobnicate' }, at(2026, 7, 28), dir), /Unbekannte Aktion/);
});

test('entries add defaults to a note and can be made checkable', () => {
  const dir = tmpDir();
  assert.match(handleEntriesTool({ action: 'add', text: 'Idee X' }, dir), /Notiz/);
  assert.match(handleEntriesTool({ action: 'add', text: 'Y bauen', checkable: 'true' }, dir), /To-do/);
});

test('entries list only_open hides notes and finished items', () => {
  const dir = tmpDir();
  handleEntriesTool({ action: 'add', text: 'Nur eine Notiz' }, dir);
  handleEntriesTool({ action: 'add', text: 'Offenes Ding', checkable: 'true' }, dir);
  const open = handleEntriesTool({ action: 'list', only_open: 'true' }, dir);
  assert.match(open, /Offenes Ding/);
  assert.doesNotMatch(open, /Nur eine Notiz/);
});

test('entries complete ticks the item off', () => {
  const dir = tmpDir();
  handleEntriesTool({ action: 'add', text: 'Abhaken', checkable: 'true' }, dir);
  const list = handleEntriesTool({ action: 'list' }, dir);
  const id = /ID: ([0-9a-f-]{36})/.exec(list)![1];
  assert.match(handleEntriesTool({ action: 'complete', id }, dir), /erledigt/i);
  assert.equal(/Abhaken/.test(handleEntriesTool({ action: 'list', only_open: 'true' }, dir)), false);
});

test('entries reports a helpful error for a missing id', () => {
  const dir = tmpDir();
  assert.match(handleEntriesTool({ action: 'complete', id: 'gibtsnicht' }, dir), /nicht gefunden/i);
});

test('the overview names terminals, open entries and upcoming appointments', () => {
  const dir = tmpDir();
  handleAgendaTool({ action: 'add', title: 'Zahnarzt', at: '2026-07-29T14:00' }, at(2026, 7, 28), dir);
  handleEntriesTool({ action: 'add', text: 'Server bauen', checkable: 'true' }, dir);

  const out = buildOverview({
    nowMs: at(2026, 7, 28, 10, 0),
    terminals: [{ label: 'Shell 1', status: 'Idle', cwd: '/Users/ayysir/Desktop/TMS Terminal' }],
  }, dir);

  assert.match(out, /Shell 1/);
  assert.match(out, /Server bauen/);
  assert.match(out, /Zahnarzt/);
  assert.match(out, /28\.07\.2026/, 'the overview states today so the model can do date maths');
});

test('the overview stays readable with nothing in it', () => {
  const dir = tmpDir();
  const out = buildOverview({ nowMs: at(2026, 7, 28, 10, 0), terminals: [] }, dir);
  assert.match(out, /Keine Terminals/);
  assert.match(out, /Keine offenen/);
});

test('notify_user writes to the outbox and reports back', () => {
  const dir = tmpDir();
  const outbox = new Outbox(() => at(2026, 7, 28, 10, 0), dir);
  const out = handleNotifyUser(
    { text: 'Du hängst seit zwei Stunden am selben Fehler — schon X probiert?', kind: 'stuck', topic_key: 'stuck:abc' },
    outbox,
  );
  assert.match(out, /gesendet/i);
  assert.equal(outbox.unreadCount(), 1);
});

test('notify_user tells the model plainly when the dosage refused the message', () => {
  const dir = tmpDir();
  const outbox = new Outbox(() => at(2026, 7, 28, 10, 0), dir);
  handleNotifyUser({ text: 'Erster', kind: 'suggestion', topic_key: 'k' }, outbox);
  const second = handleNotifyUser({ text: 'Zweiter', kind: 'suggestion', topic_key: 'k' }, outbox);
  assert.match(second, /nicht gesendet/i);
  assert.equal(outbox.unreadCount(), 1);
});
