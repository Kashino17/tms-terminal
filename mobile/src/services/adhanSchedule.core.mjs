/**
 * Reine Planungslogik fuer den Adhan: aus den Tageszeiten wird die Liste der
 * Alarme, die jetzt zu stellen sind.
 *
 * Ausgelagert nach adhanSchedule.core.mjs, damit
 * mobile/scripts/adhan-scheduler.test.mjs sie ohne React Native, ohne AsyncStorage
 * und ohne AlarmManager pruefen kann. adhanScheduler.ts reicht sie durch.
 *
 * Die Namen kommen von aussen herein (PRAYER_NAMES aus prayer.service.ts) — hier
 * steht KEINE zweite Tabelle arabischer Namen, die auseinanderlaufen koennte.
 */

/* Geplante Alarme:
 *   { name, arabic, time, wecker } — time ist "HH:MM" ohne Suffix,
 *   wecker ist nur beim Fajr-Wecker true.
 * Die Typen stehen in adhanSchedule.core.d.mts.
 */

/** Die fuenf Gebete, fuer die ueberhaupt ein Azan geplant wird. Sunrise ist keins. */
export const ADHAN_PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** "05:30 (Europe/Berlin)" -> "05:30" */
function stripZone(timeStr) {
  return String(timeStr).replace(/\s*\(.*\)/, '').trim();
}

/**
 * Welche Alarme sind fuer `timings` zu stellen?
 *
 * Vergangene Gebete fallen raus. Nach Isha bleibt damit nichts uebrig — Fajr
 * kommt erst morgen wieder dran und wird dann neu geplant. Das ist Absicht: jetzt
 * schon den Wecker fuer morgen zu stellen, haette bei Prozess-Kill und
 * Zeitzonenwechsel eine veraltete Uhrzeit in den Wecker gebacken. Der Dienst plant
 * bei jedem Start und bei jedem Zurueckkehren in die App neu.
 *
 * @param timings      Tageszeiten in der Form der Aladhan-API
 * @param names        PRAYER_NAMES aus prayer.service.ts
 * @param now         injizierbare Uhr — die Tests haengen sonst an der Tageszeit
 * @param weckerFajr   Fajr-Wecker an? Dann laeuft der Ton bei Fajr von selbst
 */
export function planAdhans(timings, names = {}, now = new Date(), weckerFajr = false) {
  const plan = [];
  if (!timings) return plan;

  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (const key of ADHAN_PRAYERS) {
    const raw = timings[key];
    if (!raw) continue;

    const time = stripZone(raw);
    const [h, m] = time.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    if (h * 60 + m <= nowMin) continue; // schon vorbei

    const info = names[key];
    plan.push({
      name: info?.de ?? key,
      arabic: info?.ar ?? '',
      time,
      wecker: key === 'Fajr' ? weckerFajr : false,
    });
  }
  return plan;
}