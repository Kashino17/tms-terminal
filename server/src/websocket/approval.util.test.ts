import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePendingLen, chooseApprovalKey } from './approval.util';

// ── Fix #4: pending-input length must self-heal on line-clearing edit keys ──
test('computePendingLen counts printable input and clears on submit/cancel', () => {
  assert.equal(computePendingLen(0, 'abc'), 3, 'printable chars increment');
  assert.equal(computePendingLen(3, '\x7f'), 2, 'backspace decrements');
  assert.equal(computePendingLen(0, '\x7f'), 0, 'never goes negative');
  assert.equal(computePendingLen(5, '\r'), 0, 'Enter clears the line');
  assert.equal(computePendingLen(5, '\x03'), 0, 'Ctrl-C clears the line');
  assert.equal(computePendingLen(5, '\x15'), 0, 'Ctrl-U clears the line');
});

test('computePendingLen resets on word/line kill keys (the desync bug)', () => {
  assert.equal(computePendingLen(8, '\x17'), 0, 'Ctrl-W (delete word) must not leave count stuck');
  assert.equal(computePendingLen(8, '\x0b'), 0, 'Ctrl-K (kill to EOL) must not leave count stuck');
});

test('computePendingLen ignores cursor/escape sequences without desyncing', () => {
  assert.equal(computePendingLen(2, '\x1b[D'), 2, 'left-arrow does not change pending length');
  assert.equal(computePendingLen(2, '\x1b[3~'), 2, 'forward-delete escape does not inflate count');
});

// ── Fix #5: pick the right approval keystroke for the prompt variant ──
test('chooseApprovalKey sends Enter for the standard Claude numbered prompt', () => {
  const claudeBash = 'Doyouwanttoproceed?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
  assert.equal(chooseApprovalKey(claudeBash), '\r');
});

test('chooseApprovalKey sends "y" for a [y/N] default-No prompt (bare Enter would decline)', () => {
  assert.equal(chooseApprovalKey('Overwrite existing file? [y/N]'), 'y\r');
});

test('chooseApprovalKey refuses to auto-press on a free-text input prompt', () => {
  assert.equal(chooseApprovalKey('What should I name it? ›'), null);
});

test('chooseApprovalKey falls back to Enter for generic yes/no confirmations', () => {
  assert.equal(chooseApprovalKey('Are you sure you want to continue?'), '\r');
});
