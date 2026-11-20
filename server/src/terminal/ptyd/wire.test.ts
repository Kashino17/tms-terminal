import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, createDecoder } from './wire';

test('eine Nachricht pro Zeile, Terminal-Bytes ueberleben JSON unveraendert', () => {
  const data = 'a\r\nb\x1b[31mrot\x1b[0m\u0000ü✓';
  const got: unknown[] = [];
  const dec = createDecoder((m) => got.push(m));
  dec.push(encode({ t: 'out', id: 'x', d: data }));
  assert.deepEqual(got, [{ t: 'out', id: 'x', d: data }]);
});

test('Nachrichten kommen in beliebig zerschnittenen Stuecken an', () => {
  const wire = encode({ t: 'in', id: '1', d: 'hallo' }) + encode({ t: 'rs', id: '1', c: 80, r: 24 });
  const got: unknown[] = [];
  const dec = createDecoder((m) => got.push(m));
  for (const ch of wire) dec.push(ch);                 // Byte fuer Byte
  assert.deepEqual(got, [{ t: 'in', id: '1', d: 'hallo' }, { t: 'rs', id: '1', c: 80, r: 24 }]);
});

test('kaputte Zeilen werden uebersprungen, der Strom laeuft weiter', () => {
  const got: unknown[] = [];
  const dec = createDecoder((m) => got.push(m));
  dec.push('{kaputt\n' + encode({ t: 'list' }));
  assert.deepEqual(got, [{ t: 'list' }]);
});
