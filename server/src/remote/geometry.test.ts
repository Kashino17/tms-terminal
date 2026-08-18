import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp01, toLogicalPoint, toWindowsAbsolute } from './geometry';

test('clamp01 haelt Werte im gueltigen Bereich', () => {
  assert.equal(clamp01(-0.4), 0);
  assert.equal(clamp01(1.7), 1);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01(Number.NaN), 0, 'kaputte Eingaben landen links oben, nicht irgendwo');
});

test('toLogicalPoint rechnet Retina-Pixel in Punkte um', () => {
  const retina = { width: 3024, height: 1964, scale: 2 };
  assert.deepEqual(toLogicalPoint(0, 0, retina), { x: 0, y: 0 });
  assert.deepEqual(toLogicalPoint(1, 1, retina), { x: 1512, y: 982 });
  assert.deepEqual(toLogicalPoint(0.5, 0.5, retina), { x: 756, y: 491 });
});

test('toLogicalPoint laesst Bildschirme ohne Skalierung unveraendert', () => {
  assert.deepEqual(toLogicalPoint(0.5, 0.25, { width: 1920, height: 1080, scale: 1 }),
                   { x: 960, y: 270 });
});

test('toLogicalPoint faengt Werte ausserhalb ab', () => {
  const g = { width: 1920, height: 1080, scale: 1 };
  assert.deepEqual(toLogicalPoint(-1, 2, g), { x: 0, y: 1080 });
});

test('toWindowsAbsolute spannt auf 0..65535 auf', () => {
  assert.deepEqual(toWindowsAbsolute(0, 0), { x: 0, y: 0 });
  assert.deepEqual(toWindowsAbsolute(1, 1), { x: 65535, y: 65535 });
  assert.deepEqual(toWindowsAbsolute(0.5, 0.5), { x: 32768, y: 32768 });
});

test('toLogicalPoint faellt bei unbrauchbarem Skalierungsfaktor auf 1 zurueck', () => {
  const basis = { width: 1920, height: 1080 };
  assert.deepEqual(toLogicalPoint(0.5, 0.5, { ...basis, scale: 0 }), { x: 960, y: 540 },
                    'scale 0 verhaelt sich wie scale 1');
  assert.deepEqual(toLogicalPoint(0.5, 0.5, { ...basis, scale: -2 }), { x: 960, y: 540 },
                    'negatives scale verhaelt sich wie scale 1');
  assert.deepEqual(toLogicalPoint(0.5, 0.5, { ...basis, scale: Number.NaN }), { x: 960, y: 540 },
                    'NaN scale verhaelt sich wie scale 1');
});

test('clamp01 faengt unendliche Werte ab', () => {
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
});
