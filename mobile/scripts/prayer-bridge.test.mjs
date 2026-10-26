/**
 * Was die Seite von den Gebetszeiten bekommt — der Vertrag zwischen App und
 * WebView.
 *
 * Rein, ohne Fenster: die Normalisierung liegt als eigene Funktion in bridge.js
 * und wird hier direkt aufgerufen. Wichtig ist die Zusage "ohne meta sieht die
 * Seite genau wie vorher" — ein Aufruf aus einem alten Pfad darf den Screen
 * nicht leer machen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { normalizePrayerPayload } = await import('../src/season2/web/prayerBridge.js');

test('ohne meta bleibt es bei Liste und Countdown', () => {
  const out = normalizePrayerPayload([
    { name: 'Fajr', time: '05:30' },
    { name: 'Dhuhr', time: '12:44' },
  ]);
  assert.equal(out.meta, null, 'ohne meta darf die Seite nicht auf Zusatzangaben warten');
  assert.equal(out.times.length, 2);
  assert.equal(out.times[0].name, 'Fajr');
  assert.equal(out.times[0].time, '05:30');
});

test('das Zeonensuffix verschwindet, die restlichen Felder bleiben', () => {
  const out = normalizePrayerPayload([
    { name: 'Fajr', de: 'Fajr', ar: 'الفجر', time: '05:30 (Europe/Berlin)' },
  ]);
  assert.equal(out.times[0].time, '05:30');
  assert.equal(out.times[0].ar, 'الفجر');
});

test('Sunrise kommt mit an — V1 zeigt ihn, V2 bisher nicht', () => {
  const out = normalizePrayerPayload([
    { name: 'Fajr', time: '05:30' },
    { name: 'Sunrise', time: '07:05' },
  ]);
  assert.equal(out.times.length, 2);
  assert.equal(out.times[1].name, 'Sunrise');
});

test('Ort, Datum, Methode und Adhan wandern mit durch', () => {
  const out = normalizePrayerPayload(
    [{ name: 'Fajr', time: '05:30' }],
    {
      location: { label: 'München', lat: 48.1, lon: 11.5 },
      date: { readable: '1 Oktober 2026', hijri: '19 Rabi al-Awwal' },
      method: { id: 3, name: 'MWL' },
      adhan: { enabled: true, wecker: false, selected: 'nafees' },
      perms: { notifications: true, exactAlarms: false },
    },
  );
  assert.equal(out.meta.location.label, 'München');
  assert.equal(out.meta.date.hijri, '19 Rabi al-Awwal');
  assert.equal(out.meta.method.name, 'MWL');
  assert.equal(out.meta.adhan.selected, 'nafees');
  // exactAlarms false heisst: ungenauer Wecker. Genau das muss die Seite zeigen.
  assert.equal(out.meta.perms.exactAlarms, false);
});

test('ein halbes meta gilt als kein meta — die Seite soll nicht halb informiert sein', () => {
  const out = normalizePrayerPayload([{ name: 'Fajr', time: '05:30' }], { location: null });
  assert.equal(out.meta, null);
});

test('kaputte Eintraege fliegen raus, statt die Liste zu sprengen', () => {
  const out = normalizePrayerPayload([
    { name: 'Fajr', time: '05:30' },
    null,
    { name: 'Dhuhr' },
    { time: '12:44' },
  ]);
  assert.deepEqual(out.times.map((t) => t.name), ['Fajr']);
});

test('ohne Zeiten bleibt die Liste leer statt zu werfen', () => {
  assert.deepEqual(normalizePrayerPayload(null).times, []);
  assert.deepEqual(normalizePrayerPayload([]).times, []);
});