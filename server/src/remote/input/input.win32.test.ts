import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWinLine } from './input.win32';

const mods = { s: false, c: false, a: false, m: false };

test('absolute Bewegung wird auf den Windows-Bereich 0..65535 gespreizt', () => {
  assert.equal(toWinLine({ t: 'm', x: 0.5, y: 0.5 }), 'abs 32768 32768');
  assert.equal(toWinLine({ t: 'm', x: 0, y: 1 }), 'abs 0 65535');
});

test('relative Bewegung geht in Pixeln durch — Windows kennt keine Punkte', () => {
  assert.equal(toWinLine({ t: 'd', dx: 12, dy: -4 }), 'rel 12 -4');
});

test('Maustasten und Rad', () => {
  assert.equal(toWinLine({ t: 'b', b: 'l', d: true }), 'btn l 1');
  assert.equal(toWinLine({ t: 'b', b: 'm', d: false }), 'btn m 0');
  assert.equal(toWinLine({ t: 's', dx: 0, dy: -3 }), 'scroll 0 -3');
});

test('Tasten kommen als virtueller Tastencode', () => {
  assert.equal(toWinLine({ t: 'k', c: 'KeyA', d: true, mods }), 'key 65 1');
  assert.equal(toWinLine({ t: 'k', c: 'F5', d: false, mods }), 'key 116 0');
  assert.equal(toWinLine({ t: 'k', c: 'Kaugummi', d: true, mods }), null);
});

test('Sondertasten reisen als eigene Ereignisse, nicht als Flags', () => {
  assert.equal(toWinLine({ t: 'k', c: 'ShiftLeft', d: true, mods }), 'key 16 1',
    'SendInput kennt keine Zustandsflags — die App schickt Druecken und Loslassen selbst');
});

test('Text wird zeilensicher gesendet', () => {
  assert.equal(toWinLine({ t: 'x', s: 'Hallo' }), 'text Hallo');
  assert.equal(toWinLine({ t: 'x', s: 'a\nb' }), 'text a\\nb');
});
