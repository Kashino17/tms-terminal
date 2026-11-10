import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyDictionary, whisperPrompt, DictionaryStore, DictEntry, DICTIONARY_SEED } from './dictionary';

let n = 0;
const entry = (term: string, heard: string[] = [], over: Partial<DictEntry> = {}): DictEntry =>
  ({ id: `e${++n}`, term, heard, source: 'manual', uses: 0, createdAt: n, ...over });
const fix = (text: string, entries: DictEntry[]) => applyDictionary(text, entries).text;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tms-dict-')), 'dictionary.json');

// ── Replacing ──────────────────────────────────────────────────────────
test('replaces a misheard phrase, whatever its capitalisation', () => {
  const e = [entry('Wispr Flow', ['Vispa Flow', 'Whisperflow'])];
  assert.strictEqual(fix('Wie bei vispa flow und bei WHISPERFLOW.', e), 'Wie bei Wispr Flow und bei Wispr Flow.');
});

// "Stock" for "Stopp" must not touch other words that merely contain it.
test('replaces whole words only', () => {
  const e = [entry('Stopp', ['Stock'])];
  assert.strictEqual(fix('Nach dem Stock im dritten Stockwerk am Wurzelstock.', e), 'Nach dem Stopp im dritten Stockwerk am Wurzelstock.');
});

test('keeps punctuation around the replaced words', () => {
  const e = [entry('Claude Code', ['Cloud Code'])];
  assert.strictEqual(fix('(Cloud Code), "Cloud Code"; Cloud Code!', e), '(Claude Code), "Claude Code"; Claude Code!');
});

test('the longest mishearing wins', () => {
  const e = [entry('Claude', ['Cloud']), entry('Claude Code', ['Cloud Code'])];
  assert.strictEqual(fix('Starte Cloud Code in der Cloud.', e), 'Starte Claude Code in der Claude.');
});

test('terms and mishearings with special characters are taken literally', () => {
  const e = [entry('C++', ['C plus plus']), entry('.env', ['Punkt env']), entry('a.b', ['a b c'])];
  assert.strictEqual(fix('In C plus plus die Punkt env lesen, axb bleibt.', e), 'In C++ die .env lesen, axb bleibt.');
});

test('umlauts count as letters at the word boundary', () => {
  const e = [entry('Tür', ['Tor'])];
  assert.strictEqual(fix('Das Tor, der Törn, das Törchen, Motor.', e), 'Das Tür, der Törn, das Törchen, Motor.');
});

test('counts the hits per entry and leaves text without mishearings alone', () => {
  const a = entry('Tailscale', ['Tail Scale']);
  const r = applyDictionary('Tail Scale und tail scale, Tailscale.', [a]);
  assert.deepStrictEqual(r.hits, { [a.id]: 2 });
  assert.strictEqual(applyDictionary('Nichts dabei.', [a]).text, 'Nichts dabei.');
  assert.deepStrictEqual(applyDictionary('Nichts dabei.', [a]).hits, {});
});

// ── What Whisper is told to listen for ─────────────────────────────────
test('whisperPrompt lists the terms, most used and newest first', () => {
  const e = [entry('Alt', [], { uses: 1, createdAt: 1 }), entry('Viel', [], { uses: 50, createdAt: 2 }), entry('Neu', [], { uses: 1, createdAt: 9 })];
  assert.strictEqual(whisperPrompt(e), 'Viel, Neu, Alt.');
});

// Whisper's prompt is short; an overlong one hurts recognition.
test('whisperPrompt stops at the limit instead of cutting a term in half', () => {
  const many = Array.from({ length: 200 }, (_, i) => entry(`Begriff${i}`, [], { uses: 200 - i }));
  const p = whisperPrompt(many, 600);
  assert.ok(p.length <= 600, `${p.length} chars`);
  assert.ok(p.startsWith('Begriff0, Begriff1,') && p.endsWith('.'));
  for (const t of p.slice(0, -1).split(', ')) assert.match(t, /^Begriff\d+$/);
});

test('whisperPrompt of an empty dictionary is empty', () => {
  assert.strictEqual(whisperPrompt([]), '');
});

// ── The store ──────────────────────────────────────────────────────────
test('a new store starts with the seed', () => {
  const st = new DictionaryStore(tmpFile(), [{ term: 'Claude Code', heard: ['Cloud Code'] }, { term: 'Tailscale' }]);
  assert.deepStrictEqual(st.list().map((e) => [e.term, e.heard, e.source]), [['Claude Code', ['Cloud Code'], 'seed'], ['Tailscale', [], 'seed']]);
});

test('the shipped seed carries today\'s fixed vocabulary', () => {
  const terms = DICTIONARY_SEED.map((s) => s.term);
  for (const t of ['Claude Code', 'Tailscale', 'WebView', 'ptyd', 'TMS Terminal']) assert.ok(terms.includes(t), t);
  assert.deepStrictEqual(DICTIONARY_SEED.find((s) => s.term === 'Claude Code')!.heard, ['Cloud Code']);
});

test('add trims, rejects empty and duplicate terms', () => {
  const st = new DictionaryStore(tmpFile(), []);
  assert.strictEqual(st.add('  Liquid   Deck \n')!.term, 'Liquid Deck');
  assert.strictEqual(st.add('liquid deck'), null);
  assert.strictEqual(st.add('   '), null);
  assert.strictEqual(st.list().length, 1);
  assert.strictEqual(st.list()[0].source, 'manual');
});

test('update changes the spelling and the mishearings', () => {
  const st = new DictionaryStore(tmpFile(), []);
  const e = st.add('Kashino')!;
  const u = st.update(e.id, { term: 'Kashino17', heard: [' Casino ', 'casino', ''] })!;
  assert.strictEqual(u.term, 'Kashino17');
  assert.deepStrictEqual(u.heard, ['Casino']);
  assert.strictEqual(st.update('nope', { term: 'x' }), null);
});

// A mishearing that is itself a term would ping-pong or eat a real word.
test('a mishearing that equals a term is rejected', () => {
  const st = new DictionaryStore(tmpFile(), []);
  st.add('Bridge');
  const e = st.add('Brücke')!;
  assert.deepStrictEqual(st.update(e.id, { heard: ['bridge', 'Brügge', 'Brücke'] })!.heard, ['Brügge']);
});

test('remove deletes an entry', () => {
  const st = new DictionaryStore(tmpFile(), []);
  const e = st.add('Weg')!;
  assert.strictEqual(st.remove(e.id), true);
  assert.strictEqual(st.remove(e.id), false);
  assert.strictEqual(st.list().length, 0);
});

test('fix replaces and counts the uses; prompt lists the terms', () => {
  const st = new DictionaryStore(tmpFile(), [{ term: 'Wispr Flow', heard: ['Vispa Flow'] }]);
  assert.strictEqual(st.fix('vispa flow, Vispa Flow.'), 'Wispr Flow, Wispr Flow.');
  assert.strictEqual(st.list()[0].uses, 2);
  assert.strictEqual(st.prompt(), 'Wispr Flow.');
});

test('survives a restart, including the uses', () => {
  const f = tmpFile();
  const a = new DictionaryStore(f, [{ term: 'Wispr Flow', heard: ['Vispa Flow'] }]);
  a.add('Neu');
  a.fix('Vispa Flow');
  const b = new DictionaryStore(f, [{ term: 'ANDERS' }]);          // the seed only applies to a missing file
  assert.deepStrictEqual(b.list().map((e) => [e.term, e.uses]).sort(), [['Neu', 0], ['Wispr Flow', 1]]);
});

test('a corrupt file is kept aside and dictation goes on with the seed', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"version":1,"entries":[{');
  const st = new DictionaryStore(f, [{ term: 'Tailscale' }]);
  assert.ok(fs.existsSync(f + '.bad'));
  assert.deepStrictEqual(st.list().map((e) => e.term), ['Tailscale']);
  assert.strictEqual(st.fix('alles gut'), 'alles gut');
});

test('overlong and control characters are cleaned', () => {
  const st = new DictionaryStore(tmpFile(), []);
  const e = st.add('a\u0000b' + 'x'.repeat(100))!;
  assert.strictEqual(e.term.length, 60);
  assert.ok(!e.term.includes('\u0000'));
});
