// Zwischenablage auf dem Handy: Dedupe, Limit 200, Angeheftete bleiben.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addClip, togglePin, removeClip, clearUnpinned, CLIP_LIMIT } from '../src/season2/bund/clipboard.core.mjs';

test('neuer Eintrag steht oben', () => {
  let l = addClip([], { text: 'a', src: 'phone', at: 1 });
  l = addClip(l, { text: 'b', src: 'srv-mac', at: 2 });
  assert.deepEqual(l.map((c) => c.text), ['b', 'a']);
  assert.equal(l[0].src, 'srv-mac');
  assert.ok(l[0].id);
});

test('gleicher Text von zwei Geräten → ein Eintrag, nach oben gerückt, neue Quelle', () => {
  let l = addClip([], { text: 'npm test', src: 'srv-mac', at: 1 });
  l = addClip(l, { text: 'x', src: 'phone', at: 2 });
  l = addClip(l, { text: 'npm test', src: 'srv-win', at: 3 });
  assert.equal(l.length, 2);
  assert.equal(l[0].text, 'npm test');
  assert.equal(l[0].src, 'srv-win');
  assert.equal(l[0].at, 3);
});

test('Dedupe behält das Anheften', () => {
  let l = addClip([], { text: 'p', src: 'phone', at: 1 });
  l = togglePin(l, l[0].id);
  l = addClip(l, { text: 'p', src: 'srv-mac', at: 2 });
  assert.equal(l[0].pinned, true);
});

test('leerer/nur-Leerraum-Text wird ignoriert', () => {
  assert.equal(addClip([], { text: '   ', src: 'phone', at: 1 }).length, 0);
});

test(`Limit ${200}: Angeheftete zählen nicht und bleiben`, () => {
  assert.equal(CLIP_LIMIT, 200);
  let l = [];
  l = addClip(l, { text: 'pin-me', src: 'phone', at: 0 });
  l = togglePin(l, l[0].id);
  for (let i = 1; i <= 205; i++) l = addClip(l, { text: 't' + i, src: 'phone', at: i });
  assert.equal(l.filter((c) => !c.pinned).length, 200);
  assert.ok(l.some((c) => c.text === 'pin-me' && c.pinned));
  assert.ok(!l.some((c) => c.text === 't1'));
});

test('clearUnpinned behält Angeheftete; removeClip löscht gezielt', () => {
  let l = addClip([], { text: 'a', src: 'phone', at: 1 });
  l = addClip(l, { text: 'b', src: 'phone', at: 2 });
  l = togglePin(l, l.find((c) => c.text === 'a').id);
  assert.deepEqual(clearUnpinned(l).map((c) => c.text), ['a']);
  assert.deepEqual(removeClip(l, l[0].id).map((c) => c.text), ['a']);
});
