/**
 * Sparmodus der App: was sie dem Server über ihre Aufmerksamkeit meldet und
 * wie oft sie die Verbindung prüft. Hintergrund (Android-Akkustatistik, ein
 * Tag): 124 mAh Rechenzeit und 125 mAh Mobilfunk gingen drauf, WÄHREND die
 * App gar nicht zu sehen war — der Ausgabestrom lief einfach weiter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusOf, planAttention, pingPlan, nextPingDelay, pingMode } from '../src/season2/attention.core.mjs';

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

test('pingPlan: so oft wie nötig, so selten wie möglich', () => {
  const live = pingPlan('live'), calm = pingPlan('calm'), quiet = pingPlan('quiet');
  assert.deepEqual(live, { pingMs: 3000, watchdogMs: 30000, aligned: false }, 'Ping wird angezeigt: alle 3 s messen');
  // Niemand sieht einen Ping-Wert (Handy zugeklappt, Terminal offen): jeder Ping
  // weckt trotzdem das Funkmodul — beim bloßen Lesen blieb es so dauerhaft an.
  assert.ok(calm.pingMs >= 10000 && calm.pingMs <= 15000, 'sichtbar ohne Ping-Anzeige: nur die Leitung prüfen');
  assert.ok(quiet.pingMs >= 60000, 'unsichtbar: höchstens ein Ping pro Minute');
  for (const p of [live, calm, quiet]) assert.ok(p.watchdogMs >= p.pingMs * 2.5, 'ein verlorener Ping kostet die Verbindung nicht');
  assert.equal(calm.aligned && quiet.aligned, true, 'seltene Pings aller Geräte fallen zusammen (ein Aufwachen statt mehrerer)');
});

test('nextPingDelay: ausgerichtete Pings treffen dieselbe Sekunde', () => {
  assert.equal(nextPingDelay(12000, false, 5000), 12000, 'nicht ausgerichtet: einfach das Intervall');
  assert.equal(nextPingDelay(12000, true, 24000), 12000, 'genau auf der Marke: volle Runde');
  assert.equal(nextPingDelay(12000, true, 25000), 11000, 'sonst bis zur nächsten gemeinsamen Marke');
  assert.equal(nextPingDelay(60000, true, 60000 * 7 + 59000), 1000);
});

test('pingMode: unsichtbar ruhig, sichtbar je nachdem, ob ein Ping-Wert zu sehen ist', () => {
  assert.equal(pingMode(false, true), 'quiet');
  assert.equal(pingMode(false, false), 'quiet');
  assert.equal(pingMode(true, true), 'live');
  assert.equal(pingMode(true, false), 'calm');
});
