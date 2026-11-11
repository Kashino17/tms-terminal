/**
 * Datei-Explorer: Favoriten-Ordner (Leiste oben). Reine Logik aus
 * mockups/season2/liquid-deck/fav-dirs.js — dieselbe Datei, die in die Seite
 * eingebaut wird.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const deck = join(here, '../../mockups/season2/liquid-deck');
const F = createRequire(import.meta.url)(join(deck, 'fav-dirs.js'));

const MAC = 'srv-mac', WIN = 'srv-win';
const paths = (m, d) => F.listFor(m, d).map((f) => f.path);

test('merken: Name ist der letzte Teil des Pfads, Reihenfolge = Reihenfolge des Merkens', () => {
  let m = F.add({}, MAC, '/Users/a/Desktop');
  m = F.add(m, MAC, '/Users/a/Developer/tms-terminal/');
  assert.deepEqual(F.listFor(m, MAC), [
    { path: '/Users/a/Desktop', label: 'Desktop' },
    { path: '/Users/a/Developer/tms-terminal', label: 'tms-terminal' },
  ]);
});

test('derselbe Ordner zweimal (auch mit Schrägstrich am Ende) bleibt EIN Favorit', () => {
  let m = F.add({}, MAC, '/Users/a/Desktop');
  m = F.add(m, MAC, '/Users/a/Desktop/');
  assert.equal(F.listFor(m, MAC).length, 1);
  assert.equal(F.isFav(m, MAC, '/Users/a/Desktop/'), true);
});

test('Favoriten gehören zum Gerät: der Mac-Pfad taucht am Windows-PC nicht auf', () => {
  let m = F.add({}, MAC, '/Users/a/Desktop');
  m = F.add(m, WIN, 'C:\\Users\\a\\Desktop');
  assert.deepEqual(paths(m, MAC), ['/Users/a/Desktop']);
  assert.deepEqual(paths(m, WIN), ['C:\\Users\\a\\Desktop']);
  assert.equal(F.isFav(m, WIN, '/Users/a/Desktop'), false);
});

test('Windows: Laufwerk und Unterordner', () => {
  assert.equal(F.norm('C:\\'), 'C:\\');
  assert.equal(F.norm('C:'), 'C:\\');
  assert.equal(F.norm('C:\\Users\\a\\'), 'C:\\Users\\a');
  assert.equal(F.nameOf('C:\\Users\\a\\Projects'), 'Projects');
  assert.equal(F.nameOf('C:\\'), 'C:');
});

test('Wurzel und Home', () => {
  assert.equal(F.norm('/'), '/');
  assert.equal(F.nameOf('~'), 'Home');
  assert.equal(F.nameOf('/Users/a/Mein Ordner'), 'Mein Ordner');
});

test('umschalten: einmal merkt, nochmal entfernt', () => {
  let m = F.toggle({}, MAC, '/a/b');
  assert.equal(F.isFav(m, MAC, '/a/b'), true);
  m = F.toggle(m, MAC, '/a/b');
  assert.equal(F.isFav(m, MAC, '/a/b'), false);
  assert.deepEqual(m, {}, 'leeres Gerät verschwindet aus der Karte');
});

test('umbenennen ändert nur den Namen auf dem Chip, nicht den Pfad', () => {
  let m = F.add({}, MAC, '/Users/a/Developer/tms-terminal');
  m = F.rename(m, MAC, '/Users/a/Developer/tms-terminal', '  TMS  ');
  assert.deepEqual(F.listFor(m, MAC), [{ path: '/Users/a/Developer/tms-terminal', label: 'TMS' }]);
  assert.equal(F.rename(m, MAC, '/Users/a/Developer/tms-terminal', '   '), m, 'leerer Name ändert nichts');
});

test('verschieben: nach links/rechts, am Rand bleibt er stehen', () => {
  let m = {};
  for (const p of ['/a', '/b', '/c']) m = F.add(m, MAC, p);
  m = F.move(m, MAC, '/c', -1);
  assert.deepEqual(paths(m, MAC), ['/a', '/c', '/b']);
  m = F.move(m, MAC, '/a', 1);
  assert.deepEqual(paths(m, MAC), ['/c', '/a', '/b']);
  assert.deepEqual(paths(F.move(m, MAC, '/c', -1), MAC), ['/c', '/a', '/b']);
  assert.deepEqual(paths(F.move(m, MAC, '/b', 1), MAC), ['/c', '/a', '/b']);
});

test('nichts wird am Original verändert', () => {
  const m = F.add({}, MAC, '/a');
  const snapshot = JSON.stringify(m);
  F.add(m, MAC, '/b'); F.remove(m, MAC, '/a'); F.rename(m, MAC, '/a', 'x'); F.move(m, MAC, '/a', 1);
  assert.equal(JSON.stringify(m), snapshot);
});

test('höchstens 30 pro Gerät', () => {
  let m = {};
  for (let i = 0; i < 40; i++) m = F.add(m, MAC, '/d' + i);
  assert.equal(F.listFor(m, MAC).length, 30);
});

test('aus dem Speicher: Kaputtes fliegt raus, Gültiges bleibt', () => {
  assert.deepEqual(F.sanitize(null), {});
  assert.deepEqual(F.sanitize('quatsch'), {});
  assert.deepEqual(F.sanitize([1, 2]), {});
  const m = F.sanitize({ [MAC]: [{ path: '/a/', label: 'A' }, { path: 5 }, null, { path: '/a' }, { path: '/b' }], [WIN]: 'x', leer: [] });
  assert.deepEqual(m, { [MAC]: [{ path: '/a', label: 'A' }, { path: '/b', label: 'b' }] });
});

test('zusammenführen: was schon da ist, gewinnt; Neues kommt dahinter', () => {
  const page = F.add({}, MAC, '/neu');
  const stored = { [MAC]: [{ path: '/alt', label: 'Alt' }, { path: '/neu', label: 'anders' }], [WIN]: [{ path: 'C:\\x', label: 'x' }] };
  const m = F.merge(page, stored);
  assert.deepEqual(F.listFor(m, MAC), [{ path: '/neu', label: 'neu' }, { path: '/alt', label: 'Alt' }]);
  assert.deepEqual(paths(m, WIN), ['C:\\x']);
});

// ── Einbau: Seite und Build kennen die Datei ───────────────────────────────
test('index.html lädt fav-dirs.js VOR bund.js, der Build bettet es ein', () => {
  const html = readFileSync(join(deck, 'index.html'), 'utf8');
  const a = html.indexOf('<script src="fav-dirs.js"></script>'), b = html.indexOf('<script src="bund.js"></script>');
  assert.ok(a > 0 && a < b, 'fav-dirs.js muss vor bund.js stehen');
  const build = readFileSync(join(here, 'build-season2-html.js'), 'utf8');
  assert.match(build, /<script src="fav-dirs\.js"><\/script>/);
});

test('App speichert die Favoriten dauerhaft und schickt sie beim Start', () => {
  const rn = readFileSync(join(here, '../src/season2/web/useFileExplorer.ts'), 'utf8');
  assert.match(rn, /case 'files:favsSave'/);
  assert.match(rn, /case 'files:favsLoad'/);
  assert.match(rn, /durableStorage/);
  const bridge = readFileSync(join(here, '../src/season2/web/bridge.js'), 'utf8');
  assert.match(bridge, /TMSBridge\.setFileFavs/);
});
