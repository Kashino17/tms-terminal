/**
 * Adhan-Planung: aus den Tageszeiten wird die Liste der Alarme, die jetzt zu
 * stellen sind.
 *
 * Die Logik liegt in src/services/adhanSchedule.core.mjs — ohne React Native,
 * ohne AsyncStorage, ohne AlarmManager. Die Uhr wird uebergeben, sonst waeren die
 * Tests von der Tageszeit abhaengig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TZ = 'Europe/Berlin';
const { planAdhans, ADHAN_PRAYERS } = await import('../src/services/adhanSchedule.core.mjs');

const NAMES = {
  Fajr: { de: 'Fajr', ar: 'الفجر', emoji: '🌙' },
  Dhuhr: { de: 'Dhuhr', ar: 'الظهر', emoji: '☀️' },
  Asr: { de: 'Asr', ar: 'العصر', emoji: '🌤️' },
  Maghrib: { de: 'Maghrib', ar: 'المغرب', emoji: '🌇' },
  Isha: { de: 'Isha', ar: 'العشاء', emoji: '🌙' },
};
const T = () => ({
  Fajr: '05:30 (Europe/Berlin)', Sunrise: '07:05 (Europe/Berlin)', Dhuhr: '12:44 (Europe/Berlin)',
  Asr: '15:31 (Europe/Berlin)', Maghrib: '18:22 (Europe/Berlin)', Isha: '19:44 (Europe/Berlin)',
});
const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00`);
const names = (plan) => plan.map((p) => p.name);

test('nur die kommenden Gebete werden geplant', () => {
  // 07:00: Fajr (05:30) ist vorbei, der Rest steht noch an
  assert.deepEqual(names(planAdhans(T(), NAMES, at('07:00'))), ['Dhuhr', 'Asr', 'Maghrib', 'Isha']);
});

test('Sunrise bekommt keinen Wecker', () => {
  assert.ok(!ADHAN_PRAYERS.includes('Sunrise'), 'Sunrise darf keinen Azan bekommen');
  assert.ok(!names(planAdhans(T(), NAMES, at('04:00'))).includes('Sunrise'));
});

test('um 21 Uhr bleibt nichts uebrig — Fajr kommt morgen', () => {
  assert.deepEqual(planAdhans(T(), NAMES, at('21:00')), []);
});

test('vor Sonnenaufgang ist Fajr als erstes dran', () => {
  assert.deepEqual(names(planAdhans(T(), NAMES, at('04:00'))), ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
});

test('das Zeitzonensuffix wandert aus der geplanten Uhrzeit', () => {
  const plan = planAdhans(T(), NAMES, at('04:00'));
  assert.deepEqual(plan.map((p) => p.time), ['05:30', '12:44', '15:31', '18:22', '19:44']);
});

test('der Fajr-Wecker gilt nur fuer Fajr', () => {
  const plan = planAdhans(T(), NAMES, at('04:00'), true);
  assert.equal(plan.find((p) => p.name === 'Fajr').wecker, true);
  assert.ok(plan.filter((p) => p.name !== 'Fajr').every((p) => !p.wecker));
});

test('ohne Wecker laeuft niemand von selbst an', () => {
  assert.ok(planAdhans(T(), NAMES, at('04:00'), false).every((p) => !p.wecker));
});

test('eine fehlende Uhrzeit macht den ganzen Plan nicht kaputt', () => {
  const partial = { ...T(), Asr: undefined };
  assert.deepEqual(names(planAdhans(partial, NAMES, at('04:00'))), ['Fajr', 'Dhuhr', 'Maghrib', 'Isha']);
});

test('ohne Zeiten wird nichts geplant statt geworfen', () => {
  assert.deepEqual(planAdhans(null, NAMES, at('07:00')), []);
  assert.deepEqual(planAdhans({}, NAMES, at('07:00')), []);
});

test('eine kaputte Uhrzeit wird uebersprungen', () => {
  const broken = { ...T(), Dhuhr: 'keine Uhrzeit' };
  assert.ok(!names(planAdhans(broken, NAMES, at('04:00'))).includes('Dhuhr'));
});