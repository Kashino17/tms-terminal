import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DictionaryStore } from './dictionary';
import { DictationStatsStore } from './dictation.stats';
import { handleDictionaryMessage } from './dictionary.connection';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-dictconn-'));
  const store = new DictionaryStore(path.join(dir, 'dictionary.json'), [{ term: 'Tailscale', heard: ['Tail Scale'] }]);
  const stats = new DictationStatsStore(path.join(dir, 'stats.json'));
  const replies: any[] = []; const casts: any[] = [];
  const handle = (msg: unknown) => handleDictionaryMessage(store, stats, msg as any, (m) => replies.push(m), (m) => casts.push(m));
  return { store, stats, replies, casts, handle };
}

test('dict:get answers the asker only, with entries and speed', () => {
  const t = setup();
  t.stats.record({ at: 1, audioSecs: 30, waitMs: 400, restSecs: 3, specHit: false });
  assert.strictEqual(t.handle({ type: 'dict:get', payload: {} }), true);
  assert.strictEqual(t.casts.length, 0);
  assert.strictEqual(t.replies[0].type, 'dict:state');
  assert.deepStrictEqual(t.replies[0].payload.entries.map((e: any) => e.term), ['Tailscale']);
  assert.deepStrictEqual(t.replies[0].payload.speed, { count: 1, medianMs: 400, under700: 1, waits: [400] });
});

test('dict:add stores the term and tells everyone', () => {
  const t = setup();
  t.handle({ type: 'dict:add', payload: { term: ' Wispr Flow ' } });
  assert.deepStrictEqual(t.store.list().map((e) => e.term), ['Wispr Flow', 'Tailscale']);
  assert.strictEqual(t.casts.length, 1);
  assert.strictEqual(t.casts[0].payload.entries.length, 2);
});

test('dict:update changes spelling and mishearings', () => {
  const t = setup();
  const id = t.store.list()[0].id;
  t.handle({ type: 'dict:update', payload: { id, heard: ['Tail Scale', 'Tailskale'] } });
  assert.deepStrictEqual(t.store.list()[0].heard, ['Tail Scale', 'Tailskale']);
  assert.strictEqual(t.casts.length, 1);
});

test('dict:remove deletes and tells everyone', () => {
  const t = setup();
  t.handle({ type: 'dict:remove', payload: { id: t.store.list()[0].id } });
  assert.strictEqual(t.store.list().length, 0);
  assert.strictEqual(t.casts.length, 1);
});

// The page must get the real state back even when nothing changed (duplicate, unknown id).
test('a change that did nothing answers the asker with the current state', () => {
  const t = setup();
  t.handle({ type: 'dict:add', payload: { term: 'tailscale' } });
  t.handle({ type: 'dict:remove', payload: { id: 'nope' } });
  assert.strictEqual(t.casts.length, 0);
  assert.strictEqual(t.replies.length, 2);
});

test('broken payloads are ignored without throwing', () => {
  const t = setup();
  for (const payload of [undefined, null, 7, { term: 5 }, { id: {}, heard: 'x' }, { heard: [1, null] }]) {
    assert.strictEqual(t.handle({ type: 'dict:add', payload }), true);
    assert.strictEqual(t.handle({ type: 'dict:update', payload }), true);
    assert.strictEqual(t.handle({ type: 'dict:remove', payload }), true);
  }
  assert.deepStrictEqual(t.store.list().map((e) => e.term), ['Tailscale']);
});

test('other messages are not handled', () => {
  const t = setup();
  assert.strictEqual(t.handle({ type: 'dictation:start', payload: {} }), false);
  assert.strictEqual(t.handle({ type: 'dict', payload: {} }), false);
});
