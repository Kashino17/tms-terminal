// Einmalig/bei Tabellenänderung: holt Referenzzeiten (Aladhan, offizielle
// Methoden) und schreibt scripts/fixtures/prayer-reference.json. Danach zeigt es,
// wie weit unsere Tabelle (adhan-js) davon abweicht. Der Test liest nur die Datei.
//   node scripts/prayer-calibrate.mjs [--fetch]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDay, CITIES, DATES } from './prayer-reference.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures/prayer-reference.json');
const table = JSON.parse(readFileSync(join(here, '../android/app/src/main/assets/prayer_methods.json'), 'utf8'));

if (process.argv.includes('--fetch') || !existsSync(FIX)) {
  const out = [];
  for (const c of CITIES) {
    for (const d of DATES) {
      const [y, m, dd] = d.split('-');
      const url = `https://api.aladhan.com/v1/timings/${dd}-${m}-${y}?latitude=${c.lat}&longitude=${c.lon}&method=${c.aladhan}&school=${c.hanafi ? 1 : 0}&latitudeAdjustmentMethod=3&timezonestring=${encodeURIComponent(c.tz)}`;
      const j = await (await fetch(url)).json();
      const t = j.data.timings;
      out.push({ city: c.name, date: d, times: { fajr: t.Fajr, sunrise: t.Sunrise, dhuhr: t.Dhuhr, asr: t.Asr, maghrib: t.Maghrib, isha: t.Isha } });
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  writeFileSync(FIX, JSON.stringify(out, null, 1) + '\n');
  console.log('Referenz gespeichert:', out.length, 'Tage');
}

const ref = JSON.parse(readFileSync(FIX, 'utf8'));
const mins = (s) => { const [h, m] = s.slice(0, 5).split(':').map(Number); return h * 60 + m; };
const byMethod = {};
for (const r of ref) {
  const c = CITIES.find((x) => x.name === r.city);
  const ours = computeDay(table, c, r.date);
  for (const k of Object.keys(r.times)) {
    const diff = mins(ours[k]) - mins(r.times[k]);
    ((byMethod[c.country] ||= {})[k] ||= []).push(diff);
  }
}
for (const [country, ks] of Object.entries(byMethod)) {
  console.log(country.padEnd(3), Object.entries(ks).map(([k, v]) => `${k}:${v.join('/')}`).join('  '));
}
