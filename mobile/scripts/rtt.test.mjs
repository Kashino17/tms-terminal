// Ehrlicher Ping: Median der letzten 5 Messungen statt stark geglätteter EMA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RttWindow } from '../src/services/rtt.core.mjs';

test('leeres Fenster → undefined', () => {
  assert.equal(new RttWindow().median(), undefined);
});

test('ein Ausreißer verschiebt den Median nicht', () => {
  const w = new RttWindow();
  for (const v of [10, 12, 400, 11, 13]) w.push(v);
  assert.equal(w.median(), 12);
});

test('dauerhaft hoher Ping (Relais) zeigt sich nach 5 Messungen voll', () => {
  const w = new RttWindow();
  for (const v of [10, 12, 11, 13, 12]) w.push(v);
  for (const v of [300, 320, 310, 305, 330]) w.push(v);
  assert.ok(w.median() >= 300);
});
