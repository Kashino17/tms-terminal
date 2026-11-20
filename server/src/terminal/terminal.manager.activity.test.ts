/**
 * „Woran wird gearbeitet": der Manager liest den Titel, den das KI-Werkzeug
 * seinem Terminal gibt, und meldet NUR echte Wechsel. Am Mac gemessen kommen
 * pro arbeitender Sitzung ~60 Titel pro Minute (das Drehzeichen ◐/◑) — die
 * dürfen nie zu Nachrichten an die App werden.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from './terminal.manager';
import type { PtyLike } from './terminal.types';
import type { Activity } from './activity';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fakePty(): PtyLike & { emit(data: string): void } {
  const listeners: Array<(d: string) => void> = [];
  const exits: Array<(e: { exitCode: number }) => void> = [];
  return {
    pid: 4242,
    onData(l) { listeners.push(l); return { dispose() {} }; },
    onExit(l) { exits.push(l as (e: { exitCode: number }) => void); return { dispose() {} }; },
    write() {}, resize() {},
    kill() { for (const l of exits) l({ exitCode: 0 }); },
    emit(d) { for (const l of listeners) l(d); },
  };
}
const title = (t: string) => `\x1b]0;${t}\x07`;

test('Titel des Werkzeugs wird zur Aufgabe; das Drehzeichen allein meldet nichts', async () => {
  const m = new TerminalManager();
  const pty = fakePty();
  m.adoptSession('s1', pty, 80, 24);
  const seen: Array<[string, Activity | null]> = [];
  const off = m.onActivity((id, a) => seen.push([id, a]));

  pty.emit(title('◐ Kampagnen-Bericht bauen'));
  for (let i = 0; i < 30; i++) pty.emit(title(i % 2 ? '◐ Kampagnen-Bericht bauen' : '◑ Kampagnen-Bericht bauen'));
  await sleep(30);
  assert.deepEqual(seen, [['s1', { task: 'Kampagnen-Bericht bauen', state: 'working' }]], '31 Titel, EINE Meldung');
  assert.deepEqual(m.getActivities(), { s1: { task: 'Kampagnen-Bericht bauen', state: 'working' } });

  pty.emit(title('✳ Kampagnen-Bericht bauen'));
  await sleep(30);
  assert.deepEqual(seen[1], ['s1', { task: 'Kampagnen-Bericht bauen', state: 'done' }]);

  // Die Shell übernimmt wieder (Claude beendet, Titel der Shell): keine Aufgabe mehr.
  pty.emit(title('ayysir@MacBook:~/Developer'));
  await sleep(30);
  assert.deepEqual(seen[2], ['s1', null]);
  assert.deepEqual(m.getActivities(), {});

  off();
  pty.emit(title('◐ Neues Thema'));
  await sleep(30);
  assert.equal(seen.length, 3, 'abgemeldet: keine Meldung mehr');
  m.releaseAllSessions();
});

test('die Aufgabe überlebt den Server-Neustart (der Titel steckt nicht im Bildschirm-Abbild)', async () => {
  const alt = new TerminalManager();
  const pty1 = fakePty();
  alt.adoptSession('s1', pty1, 80, 24);
  pty1.emit('Hallo\r\n' + title('✳ Tiefenanalyse Energie'));
  await sleep(30);
  const states = await alt.exportMirrorStates();
  assert.equal(states.s1.title, '✳ Tiefenanalyse Energie');
  alt.releaseAllSessions();

  const neu = new TerminalManager();
  neu.adoptSession('s1', fakePty(), 80, 24, states.s1);
  assert.equal((await neu.exportMirrorStates()).s1.title, '✳ Tiefenanalyse Energie', 'und er geht beim ÜBERNÄCHSTEN Neustart nicht verloren');
  assert.deepEqual(neu.getActivities(), { s1: { task: 'Tiefenanalyse Energie', state: 'done' } },
    'eine ruhende Sitzung setzt ihren Titel nicht noch einmal — ohne Sicherung wäre die Zeile leer');
  // Auch wenn die Größe nicht passt (Abbild verworfen): der Titel gilt trotzdem.
  const neu2 = new TerminalManager();
  neu2.adoptSession('s1', fakePty(), 100, 30, states.s1);
  assert.deepEqual(neu2.getActivities(), { s1: { task: 'Tiefenanalyse Energie', state: 'done' } });
  neu.releaseAllSessions(); neu2.releaseAllSessions();
});

test('ein geschlossenes Terminal hat keine Aufgabe mehr', async () => {
  const m = new TerminalManager();
  const pty = fakePty();
  m.adoptSession('s1', pty, 80, 24);
  pty.emit(title('◐ Thema'));
  await sleep(30);
  m.closeSession('s1');
  assert.deepEqual(m.getActivities(), {});
});
