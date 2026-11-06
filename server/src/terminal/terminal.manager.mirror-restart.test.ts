/**
 * Regressionstest zu einem echten Fehlerbild (2026-11-05):
 *
 * Nach einem Server-Neustart (Update) laufen die Terminals im Wächter weiter —
 * aber der neue Server legte für jedes übernommene Terminal einen LEEREN
 * Spiegel an. Beim nächsten Wiederanhängen mit verpasster Ausgabe schickte er
 * Clear + diesen fast leeren Spiegel: die App verlor ihren ganzen Verlauf und
 * zeigte nur noch Claudes unteren Bereich — Hochscrollen unmöglich.
 *
 * Fix: Beim Herunterfahren wandert jeder Spiegel (Bildschirm + Historie) auf
 * die Platte, der neue Server lädt ihn beim Übernehmen wieder. Und ein Spiegel
 * OHNE gesicherte Vergangenheit überschreibt nie den Verlauf eines Clients,
 * der noch Inhalt hat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from './terminal.manager';
import type { PtyLike } from './terminal.types';
import { CLEAR_SEQUENCE } from './reattach.policy';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakePty(): PtyLike & { emit(data: string): void } {
  const listeners: Array<(d: string) => void> = [];
  return {
    pid: 4242,
    onData(l) { listeners.push(l); return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write() {},
    resize() {},
    kill() {},
    emit(d) { for (const l of listeners) l(d); },
  };
}

const history = Array.from({ length: 120 }, (_, i) => `Verlaufszeile ${i + 1}`).join('\r\n') + '\r\n';

test('Verlauf überlebt den Server-Neustart: der neue Spiegel startet mit der alten Historie', async () => {
  // ── Alter Server: Terminal läuft, hat Verlauf.
  const alt = new TerminalManager();
  const pty1 = fakePty();
  // Dieser Server kannte das Terminal vollständig (Zustand vom Server davor).
  alt.adoptSession('sess-1', pty1, 50, 20, { cols: 50, rows: 20, data: 'Sitzungsbeginn\r\n' });
  pty1.emit(history);
  const states = await alt.exportMirrorStates();
  assert.ok(states['sess-1'], 'Spiegelzustand wurde exportiert');
  alt.releaseAllSessions();

  // ── Neuer Server: übernimmt dasselbe Terminal MIT gesichertem Zustand.
  const neu = new TerminalManager();
  const pty2 = fakePty();
  neu.adoptSession('sess-1', pty2, 50, 20, states['sess-1']);
  pty2.emit('x'); // verpasste Ausgabe → Snapshot-Weg
  await sleep(250); // Batcher legt sie in den Detach-Puffer

  const out: string[] = [];
  neu.reattachSession('sess-1', (_id, d) => out.push(d), () => {}, 50, 20, false);
  await sleep(300);
  const all = out.join('');
  assert.ok(all.includes('Verlaufszeile 3'), 'die alte Historie ist im Snapshot enthalten');
  assert.ok(all.includes('Verlaufszeile 120'), 'auch das Ende der Historie');
  assert.ok(all.includes('Sitzungsbeginn'), 'sogar der Verlauf von VOR dem vorigen Neustart');
  neu.releaseAllSessions();
});

test('ein unvollständiger Spiegel bleibt über den Neustart als unvollständig markiert', async () => {
  const alt = new TerminalManager();
  const pty1 = fakePty();
  alt.adoptSession('sess-p', pty1, 50, 20); // ohne Zustand → unvollständig
  pty1.emit('nur der Rest\r\n');
  const states = await alt.exportMirrorStates();
  assert.equal(states['sess-p']?.partial, true);
  alt.releaseAllSessions();

  const neu = new TerminalManager();
  const pty2 = fakePty();
  neu.adoptSession('sess-p', pty2, 50, 20, states['sess-p']);
  pty2.emit('y');
  await sleep(250);
  const out: string[] = [];
  neu.reattachSession('sess-p', (_id, d) => out.push(d), () => {}, 50, 20, false);
  await sleep(300);
  assert.ok(!out.join('').includes(CLEAR_SEQUENCE), 'kein Clear für einen Client mit Inhalt');
  neu.releaseAllSessions();
});

test('Spiegel ohne gesicherte Vergangenheit löscht den Verlauf eines Clients mit Inhalt NICHT', async () => {
  const neu = new TerminalManager();
  const pty = fakePty();
  neu.adoptSession('sess-2', pty, 50, 20); // kein Zustand (z. B. nach Absturz)
  pty.emit('neue Ausgabe\r\n');

  const out: string[] = [];
  neu.reattachSession('sess-2', (_id, d) => out.push(d), () => {}, 50, 20, false);
  await sleep(300);
  const all = out.join('');
  assert.ok(!all.includes(CLEAR_SEQUENCE), 'kein Clear — der Client behält seinen Verlauf');
  assert.ok(all.includes('neue Ausgabe'), 'die verpasste Ausgabe kommt trotzdem an');
  neu.releaseAllSessions();
});

test('… ein LEERER Client (App-Kaltstart) bekommt dort aber weiterhin das Vollbild', async () => {
  const neu = new TerminalManager();
  const pty = fakePty();
  neu.adoptSession('sess-3', pty, 50, 20);
  pty.emit('sichtbar\r\n');

  const out: string[] = [];
  neu.reattachSession('sess-3', (_id, d) => out.push(d), () => {}, 50, 20, true);
  await sleep(300);
  const all = out.join('');
  assert.ok(all.startsWith(CLEAR_SEQUENCE), 'Vollbild-Weg');
  assert.ok(all.includes('sichtbar'));
  neu.releaseAllSessions();
});
