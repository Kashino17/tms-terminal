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

// Review: a hyphen is not a word boundary for a single word — "Stock-Foto" is one word.
test('a single-word mishearing does not match inside a hyphenated compound', () => {
  const e = [entry('Stopp', ['Stock']), entry('Mehl', ['Mail']), entry('Claude', ['Cloud'])];
  assert.strictEqual(fix('Ein Stock-Foto per E-Mail an die Cloud-Konten, der Stock bleibt.', e), 'Ein Stock-Foto per E-Mail an die Cloud-Konten, der Stopp bleibt.');
});

test('a multi-word mishearing is still replaced in front of a hyphen', () => {
  const e = [entry('Claude Code', ['Cloud Code'])];
  assert.strictEqual(fix('Die Cloud Code-Sitzung.', e), 'Die Claude Code-Sitzung.');
});

test('a term with replacement patterns is inserted literally', () => {
  const e = [entry('$& $1 $$', ['Dollar Zeichen'])];
  assert.strictEqual(fix('Das Dollar Zeichen.', e), 'Das $& $1 $$.');
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
// Review: "uses" only counts replacements, so ranking by it pushed the core
// vocabulary out first. The user's own terms lead, the shipped ones keep their order.
test('whisperPrompt: the user\'s terms first (newest first), then the shipped ones in their order', () => {
  const e = [entry('TMS Terminal', [], { source: 'seed', createdAt: 1 }), entry('Claude Code', [], { source: 'seed', createdAt: 2 }),
    entry('Alt', [], { createdAt: 5 }), entry('Neu', [], { createdAt: 9, uses: 0 }), entry('Gelernt', [], { source: 'learned', createdAt: 7 })];
  assert.strictEqual(whisperPrompt(e), 'Neu, Gelernt, Alt, TMS Terminal, Claude Code.');
});

// Whisper's prompt is short (about 220 tokens); an overlong one loses its beginning.
test('whisperPrompt stops at the limit: the last shipped terms go first, no term is cut in half', () => {
  const seed = Array.from({ length: 100 }, (_, i) => entry(`Mitgeliefert${i}`, [], { source: 'seed', createdAt: i }));
  const mine = [entry('Meins', [], { createdAt: 500 })];
  const p = whisperPrompt([...seed, ...mine]);
  assert.ok(p.length <= 480, `${p.length} chars`);
  assert.ok(p.startsWith('Meins, Mitgeliefert0, Mitgeliefert1,') && p.endsWith('.'), p.slice(0, 50));
  for (const t of p.slice(0, -1).split(', ')) assert.match(t, /^(Meins|Mitgeliefert\d+)$/);
  assert.ok(!p.includes('Mitgeliefert99'));
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

// Review: only a missing file may start from the seed. Any other read problem
// (permissions, I/O) must leave the user's dictionary on disk untouched.
test('an unreadable file is neither replaced nor overwritten', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ version: 1, entries: [{ id: 'u1', term: 'Meins', heard: [], source: 'manual', uses: 0, createdAt: 1 }] }));
  fs.chmodSync(f, 0o000);
  const problems: string[] = [];
  try {
    const st = new DictionaryStore(f, [{ term: 'Tailscale' }], (m) => problems.push(m));
    st.add('Neu');
    assert.strictEqual(st.fix('alles gut'), 'alles gut');
  } finally { fs.chmodSync(f, 0o600); }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).entries.map((e: any) => e.term), ['Meins']);
  assert.ok(!fs.existsSync(f + '.bad'));
  assert.strictEqual(problems.length, 1);
});

test('an emptied dictionary stays empty after a restart', () => {
  const f = tmpFile();
  const a = new DictionaryStore(f, [{ term: 'Tailscale' }]);
  a.remove(a.list()[0].id);
  assert.strictEqual(new DictionaryStore(f, [{ term: 'Tailscale' }]).list().length, 0);
});

test('mishearings without a letter or digit are rejected', () => {
  const st = new DictionaryStore(tmpFile(), []);
  const e = st.add('Punkt')!;
  assert.deepStrictEqual(st.update(e.id, { heard: ['.', ' - ', '...', 'Pumkt'] })!.heard, ['Pumkt']);
});

test('the dictionary cannot grow without bound', () => {
  const st = new DictionaryStore(tmpFile(), []);
  for (let i = 0; i < 520; i++) st.add(`Begriff ${i}`);
  assert.strictEqual(st.list().length, 500);
  const e = st.list()[0];
  assert.strictEqual(st.update(e.id, { heard: Array.from({ length: 50 }, (_, i) => `falsch ${i}`) })!.heard.length, 20);
});

test('list() says which terms fit into what Whisper is told', () => {
  const st = new DictionaryStore(tmpFile(), Array.from({ length: 100 }, (_, i) => ({ term: `Mitgeliefert${i}` })));
  const l = st.list();
  assert.strictEqual(l[0].inPrompt, true);
  assert.strictEqual(l[99].inPrompt, false);
  assert.strictEqual(st.prompt().split(', ').length, l.filter((e) => e.inPrompt).length);
});

test('overlong and control characters are cleaned', () => {
  const st = new DictionaryStore(tmpFile(), []);
  const e = st.add('a\u0000b' + 'x'.repeat(100))!;
  assert.strictEqual(e.term.length, 60);
  assert.ok(!e.term.includes('\u0000'));
});
