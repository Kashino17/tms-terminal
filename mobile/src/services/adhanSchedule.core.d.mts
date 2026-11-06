import type { PrayerTimes } from './prayer.service';

/**
 * Typen fuer adhanSchedule.core.mjs. Die Datei selbst ist JavaScript, damit
 * mobile/scripts/adhan-scheduler.test.mjs sie direkt unter node:test ausfuehren
 * kann (node --test fuehrt kein TypeScript).
 */
export interface PlannedAdhan {
  /** Anzeigename, z. B. "Fajr" */
  name: string;
  arabic: string;
  /** "HH:MM", ohne Zeitzonensuffix */
  time: string;
  /** Spielt der Ton automatisch? Nur beim Fajr-Wecker. */
  wecker: boolean;
}

export declare const ADHAN_PRAYERS: (keyof PrayerTimes)[];

export declare function planAdhans(
  timings: Partial<PrayerTimes>,
  names?: Partial<Record<keyof PrayerTimes, { de: string; ar: string; emoji: string }>>,
  now?: Date,
  weckerFajr?: boolean,
): PlannedAdhan[];