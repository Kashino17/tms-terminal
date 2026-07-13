import { test } from 'node:test';
import assert from 'node:assert';
import { parseRange } from './range.util';

test('kein Header -> null (volle Antwort)', () => {
  assert.strictEqual(parseRange(undefined, 100), null);
});

test('normale Range', () => {
  assert.deepStrictEqual(parseRange('bytes=0-49', 100), { start: 0, end: 49 });
});

test('offene Range bis Dateiende', () => {
  assert.deepStrictEqual(parseRange('bytes=50-', 100), { start: 50, end: 99 });
});

test('Suffix-Range (letzte N Bytes)', () => {
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
});

test('Suffix groesser als Datei wird gekappt', () => {
  assert.deepStrictEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
});

test('Ende ueber Dateiende wird gekappt', () => {
  assert.deepStrictEqual(parseRange('bytes=10-9999', 100), { start: 10, end: 99 });
});

test('Start hinter Dateiende -> unsatisfiable (416)', () => {
  assert.strictEqual(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=200-300', 100), 'unsatisfiable');
});

test('Multi-Range wird ignoriert -> null (RFC: MAY ignore)', () => {
  assert.strictEqual(parseRange('bytes=0-1,5-6', 100), null);
});

test('kaputte Syntax wird ignoriert -> null', () => {
  assert.strictEqual(parseRange('bytes=abc', 100), null);
  assert.strictEqual(parseRange('items=0-5', 100), null);
  assert.strictEqual(parseRange('bytes=-', 100), null);
});

test('leere Datei: jede Range unsatisfiable', () => {
  assert.strictEqual(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=-5', 0), 'unsatisfiable');
});
