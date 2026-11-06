import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp01, toWindowsAbsolute } from './geometry';

test('clamp01 haelt Werte im gueltigen Bereich', () => {
  assert.equal(clamp01(-0.4), 0);
  assert.equal(clamp01(1.7), 1);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01(Number.NaN), 0, 'kaputte Eingaben landen links oben, nicht irgendwo');
});

test('clamp01 faengt unendliche Werte ab', () => {
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
});

test('toWindowsAbsolute spannt auf 0..65535 auf', () => {
  assert.deepEqual(toWindowsAbsolute(0, 0), { x: 0, y: 0 });
  assert.deepEqual(toWindowsAbsolute(1, 1), { x: 65535, y: 65535 });
  assert.deepEqual(toWindowsAbsolute(0.5, 0.5), { x: 32768, y: 32768 });
});
