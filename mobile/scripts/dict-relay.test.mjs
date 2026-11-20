/**
 * Woerterbuch-Durchreiche zwischen Einstellungsseite und Diktat-Rechner.
 *
 * Begruendung (Review 2026-11-11): Eine nicht zugestellte Anfrage stand nach
 * 4 s als „Der Diktat-Rechner braucht ein Update“ auf der Seite — ueber einem
 * aktuellen Server, und ueber einer schon gezeigten Liste.
 *
 *   node --test scripts/dict-relay.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDictRelay } from '../src/season2/dictRelay.core.mjs';

function setup() {
  const shown = []; const timers = []; const sentMsgs = [];
  const relay = createDictRelay({ show: (d) => shown.push(d), later: (fn, ms) => timers.push({ fn, ms }) });
  const ok = (m) => { sentMsgs.push(m); return true; };
  const down = () => false;
  return { relay, shown, timers, sentMsgs, ok, down, fire: () => timers.splice(0).forEach((t) => t.fn()) };
}
const STATE = { entries: [], speed: { count: 0, medianMs: 0, under700: 0, waits: [] } };

test('ohne Diktat-Rechner: offline, nichts wird gesendet', () => {
  const t = setup();
  t.relay.ask('dict:get', {}, null, t.ok);
  assert.deepEqual(t.shown, [{ offline: true }]);
  assert.equal(t.sentMsgs.length, 0);
});

test('Anfrage geht an den Diktat-Rechner; seine Antwort kommt auf die Seite', () => {
  const t = setup();
  t.relay.ask('dict:add', { term: 'Neu' }, 'mac', t.ok);
  assert.deepEqual(t.sentMsgs, [{ type: 'dict:add', payload: { term: 'Neu' } }]);
  t.relay.state('mac', 'mac', STATE);
  assert.deepEqual(t.shown, [STATE]);
});

test('Antworten anderer Geraete werden ignoriert', () => {
  const t = setup();
  t.relay.state('win', 'mac', STATE);
  assert.deepEqual(t.shown, []);
});

test('antwortet ein Rechner nie, braucht er ein Update', () => {
  const t = setup();
  t.relay.ask('dict:get', {}, 'mac', t.ok);
  assert.equal(t.timers[0].ms, 4000);
  t.fire();
  assert.deepEqual(t.shown, [{ unsupported: true }]);
});

test('ein Rechner, der schon geantwortet hat, braucht nie „ein Update“', () => {
  const t = setup();
  t.relay.ask('dict:get', {}, 'mac', t.ok);
  t.relay.state('mac', 'mac', STATE);
  t.fire();
  t.relay.ask('dict:get', {}, 'mac', t.ok);          // spaetere Anfrage, langsame Leitung
  t.fire();
  assert.deepEqual(t.shown, [STATE]);
});

test('nicht zustellbar ist „nicht erreichbar“ — und wird nachgeholt, sobald die Verbindung steht', () => {
  const t = setup();
  t.relay.ask('dict:get', {}, 'mac', t.down);
  assert.deepEqual(t.shown, [{ offline: true }]);
  assert.equal(t.timers.length, 0, 'kein Update-Hinweis fuer eine Anfrage, die nie rausging');
  t.relay.connected('win', 'mac', t.ok);
  assert.equal(t.sentMsgs.length, 0);
  t.relay.connected('mac', 'mac', t.ok);
  assert.deepEqual(t.sentMsgs, [{ type: 'dict:get', payload: {} }]);
  t.relay.connected('mac', 'mac', t.ok);
  assert.equal(t.sentMsgs.length, 1, 'nur einmal nachholen');
});
