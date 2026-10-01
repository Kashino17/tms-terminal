import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRestartDelay, RESTART_DELAYS_MS } from './restart';

test('die Wartezeiten stehen so in der Spezifikation', () => {
  assert.deepEqual([...RESTART_DELAYS_MS], [500, 1000, 2000]);
});

test('nextRestartDelay geht die Stufen durch und gibt dann auf', () => {
  assert.equal(nextRestartDelay(0), 500);
  assert.equal(nextRestartDelay(1), 1000);
  assert.equal(nextRestartDelay(2), 2000);
  assert.equal(nextRestartDelay(3), null, 'nach dem dritten Versuch ist Schluss');
  assert.equal(nextRestartDelay(99), null);
});

test('unsinnige Zaehler ergeben keinen Versuch', () => {
  assert.equal(nextRestartDelay(-1), null);
});
