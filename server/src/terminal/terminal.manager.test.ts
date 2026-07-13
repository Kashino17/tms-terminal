/**
 * Regressionstest zu einem echten Fehlerbild:
 *
 * Der Nutzer schickt im Terminal einen Befehl ab — er läuft auch, aber die App
 * zeigt nichts davon. Erst ein Wechsel in die alte Ansicht (die beim Öffnen neu
 * anhängt) brachte den ganzen Rückstand auf einmal.
 *
 * Ursache: Nach einem Verbindungsabriss hängt der Server die Session ab und
 * puffert ihre Ausgabe. Die App merkte den stillen Socket-Tausch nicht und
 * hängte sich nie wieder an — konnte aber weiter tippen, denn Eingabe geht auch
 * in eine abgehängte Session. Ergebnis: Befehl wirkt, Ausgabe unsichtbar.
 *
 * Der Server weiß jetzt, ob eine Session abgehängt ist (isDetached), und der
 * WS-Handler hängt sie beim ersten Tastendruck von selbst wieder an.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from './terminal.manager';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('eine Session gilt als abgehängt, sobald ihre Ausgabe niemanden mehr erreicht', async () => {
  const mgr = new TerminalManager();
  const seen: string[] = [];

  const session = mgr.createSession({ cols: 80, rows: 24 }, (_id, data) => seen.push(data), () => {});
  assert.ok(session, 'Session wurde angelegt');
  const id = session!.id;

  assert.equal(mgr.isDetached(id), false, 'frisch erzeugt: hängt am Client');

  mgr.detachSession(id);
  assert.equal(mgr.isDetached(id), true, 'nach dem Abhängen: die Ausgabe läuft in den Puffer');

  // Genau der Zustand des Nutzers: die Eingabe wirkt weiter …
  const vorher = seen.length;
  mgr.write(id, 'echo abgehaengt\r');
  await sleep(700);
  assert.equal(seen.length, vorher, '… aber KEIN Byte erreicht den Client');

  // … bis wieder angehängt wird — dann kommt der Rückstand.
  mgr.reattachSession(id, (_i, data) => seen.push(data), () => {});
  assert.equal(mgr.isDetached(id), false, 'wieder angehängt');
  await sleep(300);
  assert.ok(seen.join('').includes('abgehaengt'), 'der gepufferte Rückstand wird nachgeliefert');

  mgr.closeSession(id);
});

test('eine geschlossene Session gilt nicht als abgehängt (sie ist einfach weg)', async () => {
  const mgr = new TerminalManager();
  const session = mgr.createSession({ cols: 80, rows: 24 }, () => {}, () => {});
  const id = session!.id;
  mgr.closeSession(id);
  await sleep(200);
  assert.equal(mgr.isDetached(id), false, 'kein Wiederanhängen für etwas, das es nicht mehr gibt');
});
