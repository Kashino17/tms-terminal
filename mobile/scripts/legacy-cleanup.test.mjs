// Einmaliges Aufraeumen der Daten der entfernten klassischen Oberflaeche.
// Loeschen ist endgueltig — der wichtigste Test hier ist der, der alles
// schuetzt, was die App heute noch benutzt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DONE_KEY, LEGACY_KEYS, LEGACY_PREFIXES, isLegacyKey, isLegacyCacheFile, legacySecureKeys, runLegacyCleanup,
} from '../src/services/legacyCleanup.core.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Everything the app's own code names as a storage key today. */
function keysInUse() {
  const found = new Set();
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs)$/.test(name) || /liquidDeckHtml|xtermBundle|legacyCleanup/.test(name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/['"`](tms[-_:][A-Za-z0-9:_.-]*|supabase-token-[A-Za-z0-9:_.-]*)/g)) found.add(m[1]);
    }
  })(SRC);
  return [...found];
}

function fakeDeps(store, { servers = [], secure = new Set(), cache = [], failSecure = false } = {}) {
  return {
    store, secure, cache,
    getItem: async (k) => (store.has(k) ? store.get(k) : null),
    setItem: async (k, v) => { store.set(k, v); },
    getAllKeys: async () => [...store.keys()],
    multiRemove: async (keys) => { for (const k of keys) store.delete(k); },
    deleteSecure: async (k) => { if (failSecure) throw new Error('keystore busy'); secure.delete(k); },
    serverIds: async () => servers,
    cacheFiles: async () => [...cache],
    deleteCacheFile: async (name) => { cache.splice(cache.indexOf(name), 1); },
  };
}

test('kein Schluessel, den die App heute benutzt, gilt als Altlast', () => {
  const used = keysInUse();
  assert.ok(used.includes('tms-settings') && used.includes('tms_servers'), 'die Suche findet die bekannten Schluessel');
  for (const key of used) {
    assert.equal(isLegacyKey(key), false, `${key} wird noch benutzt`);
    // Auch als Anfang eines laengeren Schluessels (z. B. tms_token_<id>) darf nichts treffen.
    assert.equal(isLegacyKey(key + 'abc123'), false, `${key}… wird noch benutzt`);
    for (const p of LEGACY_PREFIXES) assert.equal(key.startsWith(p), false, `${key} liegt unter ${p}`);
  }
});

test('Altlasten werden entfernt, alles andere bleibt', async () => {
  const store = new Map([
    ['tms_servers', '[{"id":"srv1"}]'],
    ['tms-settings', '{"state":{}}'],
    ['tms-terminal-tabs', '{}'],
    ['tms:notes', '[]'],
    ['tms:s2:scrollback:abc', 'x'],
    ['tms-hydra', '{"state":{"glasses":3}}'],
    ['tms-orb-layout', '{}'],
    ['tms:snippets', '[]'],
    ['tms:snippets:defaults_v1', '1'],
    ['tms:browser-tabs:srv1', '{}'],
    ['tms:browser-cookies:srv1:t1', '{}'],
    ['tms:credentials:old9', '[]'],
    ['tms:supabase_v1', '{"connections":[{"id":"sb1"}],"assignments":{}}'],
    ['supabase-token-sb2', 'tok'],
  ]);
  const secure = new Set(['tms_credentials_srv1', 'tms_credentials_old9', 'supabase-token-sb1', 'supabase-token-sb2', 'tms_token_srv1']);
  const cache = ['tts_1700000000000.wav', 'tms-voice-r1-0.mp3', 'TMS-Terminal-v1.151.0.apk'];
  const deps = fakeDeps(store, { servers: ['srv1'], secure, cache });

  const result = await runLegacyCleanup(deps);

  assert.deepEqual([...store.keys()].sort(), [DONE_KEY, 'tms-settings', 'tms-terminal-tabs', 'tms:notes', 'tms:s2:scrollback:abc', 'tms_servers'].sort());
  assert.deepEqual([...secure], ['tms_token_srv1'], 'die Server-Anmeldung bleibt, gespeicherte Logins sind weg');
  assert.deepEqual(cache, ['tms-voice-r1-0.mp3', 'TMS-Terminal-v1.151.0.apk']);
  assert.equal(result.keys.length, 9);
});

test('laeuft nur einmal', async () => {
  const store = new Map([[DONE_KEY, '1'], ['tms-hydra', '{}']]);
  assert.equal(await runLegacyCleanup(fakeDeps(store)), null);
  assert.ok(store.has('tms-hydra'), 'nach dem ersten Lauf wird nichts mehr angefasst');
});

test('schlaegt ein Schritt fehl, versucht es der naechste Start erneut', async () => {
  const store = new Map([['tms-hydra', '{}'], ['tms:credentials:srv1', '[]']]);
  await assert.rejects(runLegacyCleanup(fakeDeps(store, { failSecure: true })));
  assert.equal(store.has(DONE_KEY), false);
  await runLegacyCleanup(fakeDeps(store));
  assert.deepEqual([...store.keys()], [DONE_KEY]);
});

test('Schluessel-Namen im Tresor: wie die alte Ansicht sie gebildet hat', () => {
  assert.deepEqual(legacySecureKeys(['a b/c', 'x1', 'x1'], ['s1']), ['tms_credentials_a_b_c', 'tms_credentials_x1', 'supabase-token-s1']);
});

test('Cache: nur die alten Sprachdateien', () => {
  assert.equal(isLegacyCacheFile('tts_1700000000000.wav'), true);
  for (const name of ['tms-voice-r1-0.mp3', 'pv-1-file.png', 'share-a.txt', 'tts_notes.wav', 'TMS-Terminal-v1.151.0.apk']) {
    assert.equal(isLegacyCacheFile(name), false, name);
  }
  assert.equal(LEGACY_KEYS.includes(DONE_KEY), false);
});
