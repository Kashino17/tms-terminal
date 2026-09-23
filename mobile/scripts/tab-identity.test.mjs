/**
 * Reiter-Identitaet: ein Terminal-Reiter wird ueber die Sitzungs-ID des
 * Servers gefuehrt — nie ueber die Karten-Nummer der Seite (t1, t2, ...), die
 * bei jedem App-Start wieder bei t1 anfaengt.
 *
 * Node fuehrt die .ts-Datei direkt aus (reine Typannotationen werden entfernt).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTab, repairTabs } from '../src/store/tabIdentity.ts';

const tab = (id, sessionId, title, extra = {}) => ({ id, sessionId, title, serverId: 'srv', active: false, ...extra });

// So entstand der Fehler: nach einem Neustart vergab die Seite "t2" neu, im
// Speicher stand aber schon ein anderer Reiter "t2". addTab haengte einfach an.
test('ein zweiter Reiter mit derselben ID ersetzt, statt sich daneben zu legen', () => {
  const list = [tab('s-a', 's-a', 'Surfschule')];
  const out = upsertTab(list, tab('s-a', 's-a', 'Surfschule neu'));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Surfschule neu');
});

test('dieselbe Sitzung unter anderer ID ersetzt ebenfalls (keine Dubletten pro Sitzung)', () => {
  const list = [tab('t2', 's-a', 'Surfschule')];
  const out = upsertTab(list, tab('s-a', 's-a', 'Surfschule'));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 's-a');
});

test('verschiedene Sitzungen bleiben getrennt', () => {
  const out = upsertTab([tab('s-a', 's-a', 'A')], tab('s-b', 's-b', 'B'));
  assert.deepEqual(out.map((t) => t.title), ['A', 'B']);
});

// Die einmalige Reparatur des schon gespeicherten Zustands.
test('Reparatur: jeder Reiter bekommt seine Sitzungs-ID als ID, Kollisionen verschwinden', () => {
  const stored = [tab('t2', 's-a', 'Surfschule'), tab('t2', 's-b', 'Kai SEO'), tab('t3', 's-c', 'Clara')];
  const out = repairTabs(stored);
  assert.deepEqual(out.map((t) => [t.id, t.title]), [['s-a', 'Surfschule'], ['s-b', 'Kai SEO'], ['s-c', 'Clara']]);
  assert.equal(new Set(out.map((t) => t.id)).size, out.length, 'IDs eindeutig');
});

test('Reparatur: doppelte Eintraege derselben Sitzung — der selbst benannte gewinnt', () => {
  const stored = [tab('t1', 's-a', 'Terminal 1'), tab('t4', 's-a', 'Surfschule', { customTitle: true })];
  const out = repairTabs(stored);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Surfschule');
});

test('Reparatur: Reiter ohne Sitzung (noch im Aufbau) bleiben, bekommen aber eindeutige IDs', () => {
  const stored = [tab('t1', undefined, 'neu'), tab('t1', undefined, 'auch neu'), tab('t1', 's-a', 'A')];
  const out = repairTabs(stored);
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((t) => t.id)).size, 3);
  assert.ok(out.some((t) => t.id === 's-a'));
});

test('Reparatur ist ohne Wirkung, wenn schon alles stimmt', () => {
  const stored = [tab('s-a', 's-a', 'A'), tab('s-b', 's-b', 'B')];
  assert.deepEqual(repairTabs(stored), stored);
});
