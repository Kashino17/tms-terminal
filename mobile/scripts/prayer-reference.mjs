// Gemeinsam für Kalibrierung und Test: Referenzstädte (eine je Landesmethode)
// und die Rechnung mit adhan-js nach unserer Tabelle.
import * as adhan from 'adhan';
import { paramsFor } from '../src/services/prayerMethods.core.mjs';

export const DATES = ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'];
export const CITIES = [
  { name: 'Berlin', country: 'DE', aladhan: 3, lat: 52.52, lon: 13.405, tz: 'Europe/Berlin' },
  { name: 'New York', country: 'US', aladhan: 2, lat: 40.7128, lon: -74.006, tz: 'America/New_York' },
  { name: 'Kairo', country: 'EG', aladhan: 5, lat: 30.0444, lon: 31.2357, tz: 'Africa/Cairo' },
  { name: 'Mekka', country: 'SA', aladhan: 4, lat: 21.3891, lon: 39.8579, tz: 'Asia/Riyadh' },
  { name: 'Karachi', country: 'PK', aladhan: 1, hanafi: true, lat: 24.8607, lon: 67.0011, tz: 'Asia/Karachi' },
  { name: 'Teheran', country: 'IR', aladhan: 7, lat: 35.6892, lon: 51.389, tz: 'Asia/Tehran' },
  { name: 'Maskat', country: 'OM', aladhan: 8, lat: 23.588, lon: 58.3829, tz: 'Asia/Muscat' },
  { name: 'Kuwait', country: 'KW', aladhan: 9, lat: 29.3759, lon: 47.9774, tz: 'Asia/Kuwait' },
  { name: 'Doha', country: 'QA', aladhan: 10, lat: 25.2854, lon: 51.531, tz: 'Asia/Qatar' },
  { name: 'Singapur', country: 'SG', aladhan: 11, lat: 1.3521, lon: 103.8198, tz: 'Asia/Singapore' },
  { name: 'Paris', country: 'FR', aladhan: 12, lat: 48.8566, lon: 2.3522, tz: 'Europe/Paris' },
  { name: 'Istanbul', country: 'TR', aladhan: 13, lat: 41.0082, lon: 28.9784, tz: 'Europe/Istanbul' },
  { name: 'Moskau', country: 'RU', aladhan: 14, lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  { name: 'Dubai', country: 'AE', aladhan: 16, lat: 25.2048, lon: 55.2708, tz: 'Asia/Dubai' },
  { name: 'Kuala Lumpur', country: 'MY', aladhan: 17, lat: 3.139, lon: 101.6869, tz: 'Asia/Kuala_Lumpur' },
  { name: 'Tunis', country: 'TN', aladhan: 18, lat: 36.8065, lon: 10.1815, tz: 'Africa/Tunis' },
  { name: 'Algier', country: 'DZ', aladhan: 19, lat: 36.7538, lon: 3.0588, tz: 'Africa/Algiers' },
  { name: 'Jakarta', country: 'ID', aladhan: 20, lat: -6.2088, lon: 106.8456, tz: 'Asia/Jakarta' },
  { name: 'Casablanca', country: 'MA', aladhan: 21, lat: 33.5731, lon: -7.5898, tz: 'Africa/Casablanca' },
  { name: 'Lissabon', country: 'PT', aladhan: 22, lat: 38.7223, lon: -9.1393, tz: 'Europe/Lisbon' },
  { name: 'Amman', country: 'JO', aladhan: 23, lat: 31.9539, lon: 35.9106, tz: 'Asia/Amman' },
];

const RULE = { twilightangle: adhan.HighLatitudeRule.TwilightAngle, middle: adhan.HighLatitudeRule.MiddleOfTheNight };

/** Zeiten eines Tages als 'HH:MM' in der Ortszeit der Stadt. */
export function computeDay(table, city, date) {
  const p = paramsFor(table, city.country);
  const cp = new adhan.CalculationParameters('Other', p.fajr, p.isha, p.ishaInterval);
  cp.madhab = p.hanafi ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
  cp.highLatitudeRule = RULE[p.highLatitude];
  cp.methodAdjustments = p.adjust;
  const [y, m, d] = date.split('-').map(Number);
  // adhan-js nimmt das Datum als Kalendertag (lokale Komponenten).
  const pt = new adhan.PrayerTimes(new adhan.Coordinates(city.lat, city.lon), new Date(y, m - 1, d), cp);
  const f = (dt) => new Intl.DateTimeFormat('en-GB', { timeZone: city.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(dt);
  return { fajr: f(pt.fajr), sunrise: f(pt.sunrise), dhuhr: f(pt.dhuhr), asr: f(pt.asr), maghrib: f(pt.maghrib), isha: f(pt.isha) };
}
