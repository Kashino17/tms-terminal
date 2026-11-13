/**
 * Doppelte Ablage fuer das, was nie verloren gehen darf (Server, Einstellungen,
 * Terminal-Reiter).
 *
 * Hintergrund: AsyncStorage loeschte auf Android seine GANZE Datenbank, sobald
 * das Oeffnen einmal scheiterte — ausgeloest beim Aufklappen des Fold. Danach
 * waren alle Verbindungen weg und die App stand wieder auf Version 1. Die
 * Dateikopie springt ein, wenn AsyncStorage leer oder kaputt zurueckkommt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { createDurableStorage } = await import('../src/services/durableStorage.core.mjs');

function memPrimary() {
  const m = new Map();
  return {
    m,
    failGet: false,
    failSet: false,
    async getItem(k) { if (this.failGet) throw new Error('db'); return m.has(k) ? m.get(k) : null; },
    async setItem(k, v) { if (this.failSet) throw new Error('db'); m.set(k, v); },
    async removeItem(k) { m.delete(k); },
  };
}

function memMirror() {
  const m = new Map();
  const log = [];
  return {
    m,
    log,
    fail: false,
    async read(k) { return m.has(k) ? m.get(k) : null; },
    active: 0,
    overlap: false,
    async write(k, v) {
      if (++this.active > 1) this.overlap = true;
      try {
        await new Promise((r) => setTimeout(r, 2));
        if (this.fail) throw new Error('disk');
        log.push(['w', k, v]);
        m.set(k, v);
      } finally { this.active--; }
    },
    async remove(k) {
      if (++this.active > 1) this.overlap = true;
      try { log.push(['r', k]); m.delete(k); } finally { this.active--; }
    },
  };
}

test('normaler Weg: Wert kommt aus AsyncStorage', async () => {
  const p = memPrimary(), f = memMirror();
  const s = createDurableStorage(p, f);
  await s.setItem('tms_servers', '[{"id":"a"}]');
  assert.equal(await s.getItem('tms_servers'), '[{"id":"a"}]');
  assert.equal(f.m.get('tms_servers'), '[{"id":"a"}]');
});

test('AsyncStorage geloescht (Fold-Bug): Kopie springt ein und heilt AsyncStorage', async () => {
  const p = memPrimary(), f = memMirror();
  const s = createDurableStorage(p, f);
  await s.setItem('tms-settings', '{"state":{"seasonTwoEnabled":true},"version":0}');
  p.m.clear(); // die Datenbank ist weg
  assert.equal(await s.getItem('tms-settings'), '{"state":{"seasonTwoEnabled":true},"version":0}');
  assert.equal(p.m.get('tms-settings'), '{"state":{"seasonTwoEnabled":true},"version":0}');
});

test('AsyncStorage wirft beim Lesen: Kopie springt ein', async () => {
  const p = memPrimary(), f = memMirror();
  const s = createDurableStorage(p, f);
  await s.setItem('k', 'v');
  p.failGet = true;
  assert.equal(await s.getItem('k'), 'v');
});

test('nichts gespeichert: null, auch ohne Kopie', async () => {
  const s = createDurableStorage(memPrimary(), memMirror());
  assert.equal(await s.getItem('k'), null);
});

test('Schreiben: ein Ausfall von AsyncStorage ist kein Fehler, solange die Kopie steht', async () => {
  const p = memPrimary(), f = memMirror();
  const s = createDurableStorage(p, f);
  p.failSet = true;
  await s.setItem('k', 'v');
  p.failSet = false;
  assert.equal(await s.getItem('k'), 'v');
});

test('Schreiben: beide fallen aus -> Fehler kommt beim Aufrufer an', async () => {
  const p = memPrimary(), f = memMirror();
  p.failSet = true; f.fail = true;
  await assert.rejects(createDurableStorage(p, f).setItem('k', 'v'));
});

test('Kopie defekt beim Schreiben: AsyncStorage traegt allein, kein Fehler', async () => {
  const p = memPrimary(), f = memMirror();
  f.fail = true;
  const s = createDurableStorage(p, f);
  await s.setItem('k', 'v');
  assert.equal(await s.getItem('k'), 'v');
});

test('Loeschen entfernt beide — kein Wiederauferstehen', async () => {
  const p = memPrimary(), f = memMirror();
  const s = createDurableStorage(p, f);
  await s.setItem('k', 'v');
  await s.removeItem('k');
  assert.equal(await s.getItem('k'), null);
  assert.equal(f.m.has('k'), false);
});

test('schnelle Folge: die Kopie endet beim letzten Wert, Reihenfolge mit Loeschen bleibt', async () => {
  const p = memPrimary(), f = memMirror();
  const s = createDurableStorage(p, f);
  const all = [];
  for (let i = 0; i < 20; i++) all.push(s.setItem('k', String(i)));
  all.push(s.removeItem('k'));
  all.push(s.setItem('k', 'final'));
  await Promise.all(all);
  assert.equal(f.m.get('k'), 'final');
  // Zusammengefasst: nicht jede Zwischenstufe landet auf der Platte.
  assert.ok(f.log.length < 22, `zu viele Plattenzugriffe: ${f.log.length}`);
  // Nie zwei Schreibzugriffe gleichzeitig auf dieselbe Datei.
  assert.equal(f.overlap, false);
  p.m.clear();
  assert.equal(await s.getItem('k'), 'final');
});


test('Bestand von vor dem Update: erstes Lesen legt die Kopie an', async () => {
  const p = memPrimary(), f = memMirror();
  p.m.set('tms_servers', '[{"id":"alt"}]'); // nur AsyncStorage, noch keine Kopie
  const s = createDurableStorage(p, f);
  assert.equal(await s.getItem('tms_servers'), '[{"id":"alt"}]');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.m.get('tms_servers'), '[{"id":"alt"}]');
  p.m.clear();
  assert.equal(await s.getItem('tms_servers'), '[{"id":"alt"}]');
});

test('Kopie anlegen beim Lesen ueberschreibt keinen neueren Schreibwert', async () => {
  const p = memPrimary(), f = memMirror();
  p.m.set('k', 'alt');
  const s = createDurableStorage(p, f);
  const read = s.getItem('k');
  await s.setItem('k', 'neu');
  await read;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.m.get('k'), 'neu');
});
