import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeldState } from './held';

const mods = { s: false, c: false, a: false, m: false };
const cmdMods = { s: false, c: false, a: false, m: true };

test('ein gedrueckter Knopf/Taste taucht in held() auf, ein losgelassener nicht mehr', () => {
  const h = createHeldState();
  h.trackButton('left', true);
  h.trackKey('MetaLeft', true, cmdMods);
  assert.deepEqual(h.held(), {
    keys: [{ code: 'MetaLeft', mods: cmdMods }],
    buttons: ['left'],
  });

  h.trackButton('left', false);
  h.trackKey('MetaLeft', false, cmdMods);
  assert.deepEqual(h.held(), { keys: [], buttons: [] }, 'losgelassen heisst raus aus der Liste');
});

test('mehrere gehaltene Tasten/Knoepfe werden unabhaengig voneinander verfolgt', () => {
  const h = createHeldState();
  h.trackKey('MetaLeft', true, cmdMods);
  h.trackKey('KeyA', true, mods);
  h.trackButton('left', true);
  h.trackButton('right', true);

  const state = h.held();
  assert.equal(state.keys.length, 2);
  assert.deepEqual(new Set(state.buttons), new Set(['left', 'right']));

  h.trackKey('KeyA', false, mods);
  h.trackButton('left', false);
  const after = h.held();
  assert.deepEqual(after.keys, [{ code: 'MetaLeft', mods: cmdMods }], 'nur die losgelassene Taste verschwindet');
  assert.deepEqual(after.buttons, ['right'], 'nur der losgelassene Knopf verschwindet');
});

test('ein frisch angelegter Zustand haelt nichts', () => {
  assert.deepEqual(createHeldState().held(), { keys: [], buttons: [] });
});

test('erneutes Herunterdruecken derselben Taste ersetzt nur ihre Modifikatoren, verdoppelt sie nicht', () => {
  const h = createHeldState();
  h.trackKey('KeyA', true, mods);
  h.trackKey('KeyA', true, cmdMods); // z.B. Cmd wurde zwischenzeitlich festgestellt
  assert.deepEqual(h.held().keys, [{ code: 'KeyA', mods: cmdMods }]);
});

test('ein Loslassen ohne vorheriges Halten aendert nichts', () => {
  const h = createHeldState();
  h.trackKey('KeyA', false, mods);
  h.trackButton('middle', false);
  assert.deepEqual(h.held(), { keys: [], buttons: [] });
});
