/**
 * Typen fuer prayer.core.mjs. Die Datei selbst ist JavaScript, damit
 * mobile/scripts/prayer.test.mjs sie direkt unter node:test ausfuehren kann
 * (node --test fuehrt kein TypeScript). Diese Deklaration haelt den
 * Aufrufern in TypeScript die Typen — insbesondere `name` als
 * `keyof PrayerTimes`, ohne das PRAYER_NAMES[next.name] nicht mehr pruefbar ist.
 */
import type { PrayerTimes } from './prayer.service';

export type PrayerName = keyof PrayerTimes;

export declare const PRAYER_ORDER: PrayerName[];
export declare const ADHAN_PRAYERS: PrayerName[];

export declare function stripZone(timeStr: string): string;
export declare function toLocalDate(timeStr: string, base: Date, addDay?: boolean): Date;
export declare function formatTime(timeStr: string): string;

/** `at` und `tomorrow` sind additiv — wer nur name/time/remainingMs liest, sieht das alte Verhalten. */
export interface NextPrayer {
  name: PrayerName;
  time: string;
  at: Date;
  remainingMs: number;
  tomorrow: boolean;
}

export declare function getNextPrayer(timings: PrayerTimes, now?: Date): NextPrayer | null;
export declare function minutesUntil(timeStr: string, now?: Date): number | null;
export declare function formatRemaining(ms: number): string;
export declare function getPrayerProgress(timings: PrayerTimes, now?: Date): number;
export declare function hasPassed(timeStr: string, now?: Date): boolean;