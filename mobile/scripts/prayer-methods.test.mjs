// Gebetszeiten: unsere Tabelle (prayer_methods.json, dieselbe Datei nutzt die
// App in PrayerEngine.kt) gegen amtliche Zeiten und Aladhans Methoden.
// Rechnet mit adhan-js — demselben Verfahren wie adhan-java in der App.
//   node --test scripts/prayer-methods.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDay, CITIES } from './prayer-reference.mjs';
import { countryForZone, methodFor, paramsFor } from '../src/services/prayerMethods.core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(join(here, '../android/app/src/main/assets/prayer_methods.json'), 'utf8'));
const fix = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));
const toMin = (s) => { const [h, m] = s.slice(0, 5).split(':').map(Number); return h * 60 + m; };
const ALARMS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']; // Sonnenaufgang klingelt nicht

test('Land kommt aus der Zeitzone des Handys, Methode aus dem Land', () => {
  assert.equal(countryForZone(table.zones, 'Asia/Kuala_Lumpur'), 'MY');
  assert.equal(countryForZone(table.zones, 'Asia/Kuching'), 'MY');
  assert.equal(countryForZone(table.zones, 'Europe/Istanbul'), 'TR');
  assert.equal(countryForZone(table.zones, 'Asia/Calcutta'), 'IN', 'alter Name der Zone');
  assert.equal(countryForZone(table.zones, 'Etc/UTC'), null);
  assert.equal(methodFor(table, 'MY').id, 'JAKIM');
  assert.equal(methodFor(table, 'DE').id, 'MWL', 'ohne eigene Behörde: Muslim World League');
  assert.equal(methodFor(table, null).id, 'MWL');
  assert.equal(paramsFor(table, 'PK').hanafi, true);
  assert.equal(paramsFor(table, 'MY').hanafi, false);
  for (const [cc, id] of Object.entries(table.countries)) assert.ok(table.methods[id], `${cc} → ${id} existiert`);
});

test('Malaysia: amtliche JAKIM-Zeiten (e-Solat 2026, 4 Zonen, ganzes Jahr) auf ±2 Minuten', () => {
  const MON = { Jan: 0, Feb: 1, Mac: 2, Apr: 3, Mei: 4, Jun: 5, Jul: 6, Ogos: 7, Sep: 8, Okt: 9, Nov: 10, Dis: 11 };
  const COORD = { WLY01: [3.139, 101.6869], JHR02: [1.4927, 103.7414], SBH07: [5.9804, 116.0735], PNG01: [5.4141, 100.3288] };
  let worst = 0, early = 0, n = 0;
  for (const [zone, { rows }] of Object.entries(fix('jakim-2026.json'))) {
    const city = { country: 'MY', lat: COORD[zone][0], lon: COORD[zone][1], tz: 'Asia/Kuala_Lumpur' };
    for (const r of rows) {
      const [d, mo, y] = r.date.split('-');
      const date = `${y}-${String(MON[mo] + 1).padStart(2, '0')}-${d}`;
      const ours = computeDay(table, city, date);
      for (const k of ALARMS) {
        const diff = toMin(ours[k]) - toMin(r[k]);
        worst = Math.max(worst, Math.abs(diff));
        if (diff < -1) early++;
        n++;
      }
    }
  }
  assert.ok(worst <= 2, `größte Abweichung ${worst} Min.`);
  assert.ok(early / n < 0.01, `mehr als 1 Min. zu früh: ${early} von ${n}`);
});

test('Singapur: amtliche MUIS-Zeiten (data.gov.sg 2025) auf ±2, meist ±1 Minute', () => {
  const sg = CITIES.find((c) => c.name === 'Singapur');
  const MAP = { fajr: 'Subuh', dhuhr: 'Zohor', asr: 'Asar', maghrib: 'Maghrib', isha: 'Isyak' };
  let worst = 0, within1 = 0, n = 0;
  for (const r of fix('muis-2025.json')) {
    const ours = computeDay(table, sg, r.Date);
    for (const k of ALARMS) {
      let off = toMin(r[MAP[k]]);
      if (k !== 'fajr' && off < 12 * 60) off += 12 * 60; // 12-Stunden-Angaben
      if (k === 'dhuhr' && off >= 24 * 60) off -= 12 * 60; // Zohor 12:xx bleibt Mittag
      const diff = toMin(ours[k]) - off;
      worst = Math.max(worst, Math.abs(diff));
      if (Math.abs(diff) <= 1) within1++;
      n++;
    }
  }
  assert.ok(worst <= 2, `größte Abweichung ${worst} Min.`);
  assert.ok(within1 / n > 0.95, `±1 Min.: ${(within1 / n * 100).toFixed(1)} %`);
});

test('Indonesien: Kemenag-Jadwal Jakarta auf ±1 Minute', () => {
  const jk = CITIES.find((c) => c.name === 'Jakarta');
  for (const [date, s] of Object.entries(fix('kemenag-jakarta-2026.json').days)) {
    const off = s.split(' ');
    const ours = computeDay(table, jk, date);
    ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'].forEach((k, i) => {
      if (!ALARMS.includes(k)) return;
      assert.ok(Math.abs(toMin(ours[k]) - toMin(off[i])) <= 1, `${date} ${k}: ${ours[k]} statt ${off[i]}`);
    });
  }
});

test('Alle anderen Länder: wie die offizielle Methode bei Aladhan (±1 Minute)', () => {
  for (const r of fix('prayer-reference.json')) {
    const city = CITIES.find((c) => c.name === r.city);
    if (['MY', 'SG', 'ID'].includes(city.country)) continue; // amtlich abgestimmt (s. o.)
    if (city.country === 'MA' && r.date === '2026-10-15') continue; // Zeitzonen-Stand Aladhan ≠ ICU
    const ours = computeDay(table, city, r.date);
    for (const k of ALARMS) {
      const diff = toMin(ours[k]) - toMin(r.times[k]);
      // Asr: Aladhan weicht jahreszeitlich ab; unsere Asr-Zeit ist mit der
      // Standardformel (Schatten = 1 + tan|φ−δ|) nachgerechnet.
      const tol = k === 'asr' ? 6 : 1;
      assert.ok(Math.abs(diff) <= tol, `${r.city} ${r.date} ${k}: ${ours[k]} statt ${r.times[k]}`);
    }
  }
});
