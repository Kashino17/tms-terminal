/**
 * Der Gebetszaehler der WebView-Seite.
 *
 * nextPrayer() entscheidet, was als "naechstes Gebet" ueber der Karte steht. Er
 * wird jetzt mit sechs Werten gefuettert (Sunrise kam beim Port dazu), vorher
 * mit fuenf. Beide Faelle stehen hier, weil die Liste gewachsen ist und die
 * Seite sonst unbemerkt auf den alten Stand zurueckfallen koennte.
 *
 * Reine Rechenlogik aus dem Mockup — der Test schneidet den
 * TMS-TEST-EXPORT-Block aus der HTML-Datei (das Muster aus term-text.test.mjs)
 * und wertet ihn aus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MOCKUP = '/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html';

function load(times) {
  const html = fs.readFileSync(MOCKUP, 'utf8');
  const m = /\/\/ ── TMS-TEST-EXPORT: nextPrayer ──([\s\S]*?)\/\/ ── \/TMS-TEST-EXPORT ──/.exec(html);
  assert.ok(m, 'Block nextPrayer fehlt im Mockup — die Rechenlogik ist dann nicht pruefbar');
  // Kein Fenster: die Seite liest die Zeiten aus TMS_DATA.
  return new Function(`
    var window;
    var TMS_DATA = { prayerTimes: ${JSON.stringify(times)} };
    ${m[1]}
    return nextPrayer;
  `)();
}

const FUENF = [
  { name: 'Fajr', time: '05:12' }, { name: 'Dhuhr', time: '13:18' }, { name: 'Asr', time: '16:52' },
  { name: 'Maghrib', time: '19:34' }, { name: 'Isha', time: '21:06' },
];
const SECHS = [
  { name: 'Fajr', time: '05:12' }, { name: 'Sunrise', time: '06:41' }, { name: 'Dhuhr', time: '13:18' },
  { name: 'Asr', time: '16:52' }, { name: 'Maghrib', time: '19:34' }, { name: 'Isha', time: '21:06' },
];
const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00`);

test('mit fuenf Zeiten zaehlt er die naechste Uhrzeit', () => {
  const next = load(FUENF)(at('07:00'));
  assert.equal(next.name, 'Dhuhr');
  assert.equal(next.countdown, '6:18h');
});

test('Sunrise gehoert dazu, wenn die App ihn schickt', () => {
  // 06:00 liegt zwischen Fajr (05:12) und Sunrise (06:41)
  assert.equal(load(FUENF)(at('06:00')).name, 'Dhuhr', 'ohne Sunrise waere hier schon Dhuhr');
  assert.equal(load(SECHS)(at('06:00')).name, 'Sunrise');
});

test('nach dem letzten Gebet kommt das erste von morgen', () => {
  const next = load(SECHS)(at('23:50'));
  assert.equal(next.name, 'Fajr');
  assert.equal(next.tomorrow, true);
});

test('ohne Zeiten liefert er null, statt zu werfen', () => {
  assert.equal(load([])(at('07:00')), null);
});

test('die Minutenzahl stimmt mit der Differenz ueberein', () => {
  const now = at('16:00');
  const next = load(SECHS)(now);
  assert.equal(next.name, 'Asr');
  assert.equal(Math.round(next.diffMin), 52);
  assert.equal(next.countdown, '0:52h');
});