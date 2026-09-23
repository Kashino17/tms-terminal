import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TitleStore, cleanTitle } from './titles.store';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'titles-')), 'titles.json');

test('Titel ueberleben einen Neustart des Servers (neue Instanz liest die Datei)', async () => {
  const f = tmpFile();
  const a = new TitleStore(f, 0);
  a.set('s-a', 'Surfschule Bali');
  a.set('s-b', 'Kai SEO');
  await a.flush();
  const b = new TitleStore(f, 0);
  assert.deepEqual(b.all(), { 's-a': 'Surfschule Bali', 's-b': 'Kai SEO' });
});

test('set meldet nur echte Aenderungen (sonst kein Rundruf an alle Geraete)', () => {
  const s = new TitleStore(tmpFile(), 0);
  assert.equal(s.set('s-a', 'A'), true);
  assert.equal(s.set('s-a', 'A'), false);
  assert.equal(s.set('s-a', 'B'), true);
});

test('Entfernen und Aufraeumen: nur Titel lebender Terminals bleiben', async () => {
  const f = tmpFile();
  const s = new TitleStore(f, 0);
  s.set('s-a', 'A'); s.set('s-b', 'B'); s.set('s-c', 'C');
  s.remove('s-a');
  s.prune(new Set(['s-b']));
  await s.flush();
  assert.deepEqual(new TitleStore(f, 0).all(), { 's-b': 'B' });
});

test('cleanTitle: Leerraum und Steuerzeichen raus, Laenge begrenzt, leer = ungueltig', () => {
  assert.equal(cleanTitle('  Surfschule\u0007 Bali \n'), 'Surfschule Bali');
  assert.equal(cleanTitle('x'.repeat(200))!.length, 80);
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle(42 as unknown as string), null);
});

test('eine kaputte Datei legt den Server nicht lahm', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{kaputt');
  assert.deepEqual(new TitleStore(f, 0).all(), {});
});
