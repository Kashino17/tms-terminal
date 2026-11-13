/**
 * Gebetszeiten — Rechenlogik.
 *
 * Die Funktionen liegen in src/services/prayer.core.mjs, ohne React Native und
 * ohne Netz, damit sie hier unter node:test laufen koennen. Der Zeitpunkt wird
 * uebergeben statt aus new Date() gelesen, sonst waeren die Tests von der
 * Tageszeit abhaengig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TZ = 'Europe/Berlin';
const {
  getNextPrayer, getPrayerProgress, hasPassed, formatRemaining,
  minutesUntil, stripZone, ADHAN_PRAYERS,
} = await import('../src/services/prayer.core.mjs');

/** So kommt die Aladhan-API: mit Zeitzone im Suffix. */
const T = () => ({
  Fajr: '05:30 (Europe/Berlin)', Sunrise: '07:05 (Europe/Berlin)', Dhuhr: '12:44 (Europe/Berlin)',
  Asr: '15:31 (Europe/Berlin)', Maghrib: '18:22 (Europe/Berlin)', Isha: '19:44 (Europe/Berlin)',
});
const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00`);

test('das Zonensuffix verschwindet aus der Anzeige', () => {
  assert.equal(stripZone('05:30 (Europe/Berlin)'), '05:30');
});

test('das naechste Gebet ist das erste nach jetzt', () => {
  // 07:00 liegt zwischen Sunrise (07:05) und Dhuhr (12:44) — Sunrise zuerst
  assert.equal(getNextPrayer(T(), at('07:00')).name, 'Sunrise');
  const np = getNextPrayer(T(), at('07:30'));
  assert.equal(np.name, 'Dhuhr');
  assert.equal(np.time, '12:44');
  assert.equal(np.tomorrow, false);
});

test('Sunrise zaehlt als Gebet, ist aber kein Azan', () => {
  assert.equal(getNextPrayer(T(), at('05:45')).name, 'Sunrise');
  assert.ok(!ADHAN_PRAYERS.includes('Sunrise'), 'Sunrise darf keinen Wecker bekommen');
});

test('nach Isha kommt Fajr von morgen', () => {
  const np = getNextPrayer(T(), at('21:00'));
  assert.equal(np.name, 'Fajr');
  assert.equal(np.tomorrow, true);
  assert.equal(np.at.getDate(), 2);
});

test('ein vergangenes Gebet ist nicht das naechste', () => {
  assert.equal(hasPassed('12:44 (Europe/Berlin)', at('13:00')), true);
  assert.equal(hasPassed('15:31 (Europe/Berlin)', at('13:00')), false);
});

test('der Fortschritt laeuft von 0 nach 1 zwischen zwei Gebeten', () => {
  // 07:05 -> 12:44 sind 339 Minuten, 09:14 liegt 129 Minuten danach
  const p = getPrayerProgress(T(), at('09:14'));
  assert.ok(Math.abs(p - 129 / 339) < 0.02, `erwartet ~0.38, war ${p}`);
});

test('die Restzeit liest sich als Stunden und Minuten', () => {
  assert.equal(formatRemaining(2 * 3600e3 + 14 * 60e3), '2h 14m');
  assert.equal(formatRemaining(14 * 60e3), '14m');
});

test('ein vergangenes Gebet wird nie nachgeplant, ein kommendes immer', () => {
  assert.equal(minutesUntil('12:44 (Europe/Berlin)', at('13:00')), null);
  assert.equal(minutesUntil('15:31 (Europe/Berlin)', at('13:00')), 151 * 60);
});

test('um Mitternacht ist Fajr morgen das naechste', () => {
  const np = getNextPrayer(T(), at('23:50'));
  assert.equal(np.name, 'Fajr');
  assert.equal(np.tomorrow, true);
});