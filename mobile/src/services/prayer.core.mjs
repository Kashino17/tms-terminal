/**
 * Rechenlogik der Gebetszeiten — ohne React Native, ohne Expo, ohne Netz.
 *
 * Ausgelagert nach prayer.core.mjs, damit mobile/scripts/prayer.test.mjs sie
 * unter node:test pruefen kann. Die .ts re-exportiert sie unveraendert, es gibt
 * also genau EINE Quelle fuer diese Funktionen.
 *
 * Die API liefert die Zeiten als "HH:MM (Europe/Berlin)". Das Suffix wandert
 * ueber stripZone() weg, der Rest wird als LOKALE Uhr gelesen — bewusst, siehe
 * Spec 2026-10-01 Abschnitt B-6.
 */

/** "05:30 (Europe/Berlin)" -> "05:30" */
export function stripZone(timeStr) {
  return String(timeStr).replace(/\s*\(.*\)/, '').trim();
}

/** Reihenfolge, in der ein Tag durchlaeuft. */
export const PRAYER_ORDER = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** Die fuenf Gebete, fuer die ein Azan geplant wird (Sunrise ist keins). */
export const ADHAN_PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** HH:MM -> Minuten seit Mitternacht */
function toMinutes(timeStr) {
  const [h, m] = stripZone(timeStr).split(':').map(Number);
  return h * 60 + m;
}

/** HH:MM -> lokale Uhrzeit am gegeben Tag (oder morgen, wenn addDay) */
export function toLocalDate(timeStr, base, addDay = false) {
  const [h, m] = stripZone(timeStr).split(':').map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + (addDay ? 1 : 0), h, m, 0, 0);
}

/**
 * Das naechste Gebet ab `now`. Nach Isha kommt Fajr von morgen.
 * `at` und `tomorrow` sind additiv — Aufrufer, die nur `name`/`time` lesen,
 * sehen exakt das alte Verhalten.
 */
export function getNextPrayer(timings, now = new Date()) {
  for (const name of PRAYER_ORDER) {
    const raw = timings?.[name];
    if (!raw) continue;
    const at = toLocalDate(raw, now, false);
    const diff = at.getTime() - now.getTime();
    if (diff > 0) {
      return { name, time: stripZone(raw), at, remainingMs: diff, tomorrow: false };
    }
  }

  const raw = timings?.Fajr;
  if (!raw) return null;
  const at = toLocalDate(raw, now, true);
  return { name: 'Fajr', time: stripZone(raw), at, remainingMs: at.getTime() - now.getTime(), tomorrow: true };
}

/** Minuten bis `timeStr`, oder null wenn es heute schon vorbei war. */
export function minutesUntil(timeStr, now = new Date()) {
  const at = toLocalDate(timeStr, now, false);
  const diff = at.getTime() - now.getTime();
  return diff > 0 ? Math.round(diff / 1000) : null;
}

/** Format "Xh Ym" bzw. "Ym" */
export function formatRemaining(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Fortschritt zwischen dem vorigen und dem naechsten Gebet, 0..1 */
export function getPrayerProgress(timings, now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (let i = 0; i < PRAYER_ORDER.length; i++) {
    const raw = timings?.[PRAYER_ORDER[i]];
    if (!raw) continue;
    const nextMin = toMinutes(raw);
    if (nowMin < nextMin) {
      const prevRaw = i > 0 ? timings?.[PRAYER_ORDER[i - 1]] : null;
      const prevMin = prevRaw ? toMinutes(prevRaw) : 0;
      const total = nextMin - prevMin;
      if (total <= 0) return 0;
      return (nowMin - prevMin) / total;
    }
  }
  return 1;
}

/** Ist diese Uhrzeit heute schon vorbei? */
export function hasPassed(timeStr, now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= toMinutes(timeStr);
}

/** Anzeigename aus "HH:MM (Zone)" fuer Listen und Kopfzeilen */
export function formatTime(timeStr) {
  return stripZone(timeStr);
}