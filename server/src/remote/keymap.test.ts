import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMacKeyCode, toWinVirtualKey } from './keymap';

test('Buchstaben liegen auf den richtigen macOS-Codes', () => {
  assert.equal(toMacKeyCode('KeyA'), 0);
  assert.equal(toMacKeyCode('KeyZ'), 6, 'auf ANSI-Tastaturen liegt Z nicht bei Y');
  assert.equal(toMacKeyCode('KeyQ'), 12);
});

test('Sondertasten und Pfeile stimmen auf macOS', () => {
  assert.equal(toMacKeyCode('Enter'), 36);
  assert.equal(toMacKeyCode('Backspace'), 51);
  assert.equal(toMacKeyCode('Tab'), 48);
  assert.equal(toMacKeyCode('Escape'), 53);
  assert.equal(toMacKeyCode('Space'), 49);
  assert.equal(toMacKeyCode('ArrowLeft'), 123);
  assert.equal(toMacKeyCode('ArrowUp'), 126);
});

test('Windows bekommt seine virtuellen Tastencodes', () => {
  assert.equal(toWinVirtualKey('KeyA'), 0x41);
  assert.equal(toWinVirtualKey('Digit7'), 0x37);
  assert.equal(toWinVirtualKey('Enter'), 0x0d);
  assert.equal(toWinVirtualKey('ArrowDown'), 0x28);
  assert.equal(toWinVirtualKey('F5'), 0x74);
});

test('unbekannte Tasten liefern null statt einer falschen Taste', () => {
  assert.equal(toMacKeyCode('Kaugummi'), null);
  assert.equal(toWinVirtualKey(''), null);
});
