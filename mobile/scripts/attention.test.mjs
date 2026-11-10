/**
 * Sparmodus der App: was sie dem Server über ihre Aufmerksamkeit meldet und
 * wie oft sie die Verbindung prüft. Hintergrund (Android-Akkustatistik, ein
 * Tag): 124 mAh Rechenzeit und 125 mAh Mobilfunk gingen drauf, WÄHREND die
 * App gar nicht zu sehen war — der Ausgabestrom lief einfach weiter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusOf, planAttention, pingPlan } from '../src/season2/attention.core.mjs';

test('focusOf: welches Terminal ist wirklich zu sehen?', () => {
  const base = { terminalsVisible: true, remote: false, overview: false, listView: false, compact: false, activeSession: 'S1' };
  assert.equal(focusOf(base), 'S1', 'Stapel: das Terminal vorne');
  assert.equal(focusOf({ ...base, terminalsVisible: false }), '', 'anderer Bildschirm (Bund, Cloud, Sperre): keins');
  assert.equal(focusOf({ ...base, remote: true }), '', 'Fernzugriff liegt drüber: keins');
  assert.equal(focusOf({ ...base, overview: true }), null, 'Übersicht: mehrere zu sehen → alle live');
  assert.equal(focusOf({ ...base, listView: true }), null, 'Liste: mehrere zu sehen → alle live');
  assert.equal(focusOf({ ...base, listView: true, compact: true }), 'S1', 'kompakt zeigt trotz Listen-Einstellung nur eins');
  assert.equal(focusOf({ ...base, activeSession: null }), '', 'Karte noch ohne Sitzung');
});

test('planAttention: jede verbundene Verbindung bekommt den Stand genau einmal', () => {
  const devs = [{ id: 'mac', connected: true }, { id: 'win', connected: true }];
  let r = planAttention(devs, {}, true, 'S1');
  assert.deepEqual(r.send, ['mac', 'win']);
  r = planAttention(devs, r.sent, true, 'S1');
  assert.deepEqual(r.send, [], 'nichts geändert → nichts senden');
  r = planAttention(devs, r.sent, true, 'S2');
  assert.deepEqual(r.send, ['mac', 'win'], 'anderes Terminal vorne');
  r = planAttention(devs, r.sent, false, 'S2');
  assert.deepEqual(r.send, ['mac', 'win'], 'App nicht mehr sichtbar');
});

test('planAttention: nach einem Verbindungsabriss wird neu gemeldet (der Server startet bei „alles live")', () => {
  let r = planAttention([{ id: 'mac', connected: true }], {}, true, 'S1');
  r = planAttention([{ id: 'mac', connected: false }], r.sent, true, 'S1');
  assert.deepEqual(r.send, [], 'getrennt: nichts zu senden …');
  assert.equal('mac' in r.sent, false, '… und der Merker ist weg');
  r = planAttention([{ id: 'mac', connected: true }], r.sent, true, 'S1');
  assert.deepEqual(r.send, ['mac'], 'wieder da → neu melden');
});

test('planAttention: null (alle live) und "" (keins) sind verschiedene Meldungen', () => {
  const devs = [{ id: 'mac', connected: true }];
  let r = planAttention(devs, {}, true, null);
  r = planAttention(devs, r.sent, true, '');
  assert.deepEqual(r.send, ['mac']);
});

test('pingPlan: sichtbar alle 3 s messen, unsichtbar nur noch die Leitung halten', () => {
  const on = pingPlan(false), off = pingPlan(true);
  assert.equal(on.pingMs, 3000);
  assert.equal(on.watchdogMs, 30000);
  assert.ok(off.pingMs >= 25000, 'im Hintergrund höchstens zwei Pings pro Minute');
  assert.ok(off.watchdogMs >= off.pingMs * 2.5, 'ein verlorener Ping darf die Verbindung nicht kosten');
});
