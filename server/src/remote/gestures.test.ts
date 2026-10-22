import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAC_GESTURE_HOTKEY, WIN_GESTURE_KEYS, isRemoteGesture } from './gestures';
import { toHelperLine } from './input/input.darwin';
import { toWinLine } from './input/input.win32';

test('Mac: Wischen wie am echten Trackpad — Finger nach links holt den Space rechts', () => {
  assert.equal(toHelperLine({ t: 'g', g: 'swipe-left' }), 'hotkey 81');
  assert.equal(toHelperLine({ t: 'g', g: 'swipe-right' }), 'hotkey 79');
  assert.equal(toHelperLine({ t: 'g', g: 'swipe-up' }), 'hotkey 32', 'Mission Control');
  assert.equal(toHelperLine({ t: 'g', g: 'swipe-down' }), 'hotkey 33', 'App-Fenster');
  assert.equal(toHelperLine({ t: 'g', g: 'pinch-in' }), 'hotkey 64', 'Spotlight');
  assert.equal(toHelperLine({ t: 'g', g: 'pinch-out' }), 'hotkey 36', 'Schreibtisch');
});

test('Windows: Akkord drücken in Reihenfolge, loslassen rückwärts', () => {
  // Strg (0x11) + Win (0x5b) + Pfeil rechts (0x27) → nächster virtueller Desktop
  assert.equal(toWinLine({ t: 'g', g: 'swipe-left' }),
    'key 17 1\nkey 91 1\nkey 39 1\nkey 39 0\nkey 91 0\nkey 17 0');
  assert.equal(toWinLine({ t: 'g', g: 'swipe-up' }), 'key 91 1\nkey 9 1\nkey 9 0\nkey 91 0', 'Win+Tab');
});

test('unbekannte Gesten erzeugen keine Helferzeile', () => {
  assert.equal(toHelperLine({ t: 'g', g: 'wobble' as any }), null);
  assert.equal(toWinLine({ t: 'g', g: '__proto__' as any }), null);
  assert.equal(isRemoteGesture('toString'), false);
});

test('beide Plattformen kennen dieselben Gesten', () => {
  assert.deepEqual(Object.keys(WIN_GESTURE_KEYS).sort(), Object.keys(MAC_GESTURE_HOTKEY).sort());
});
