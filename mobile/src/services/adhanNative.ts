/**
 * Gebetsruf auf dem Handy (AdhanModule.kt): rechnet die Zeiten selbst (ohne
 * Netz, Methode nach Land aus der Zeitzone) und stellt die Alarme selbst —
 * auch wenn die App tagelang zu ist, nach Neustart oder Zeitzonenwechsel.
 * Die App liefert nur Einstellungen und Standort.
 */
import { NativeModules, Platform } from 'react-native';

export interface AdhanPerms {
  exact: boolean;
  overlay: boolean;
  fullscreen: boolean;
  notifications: boolean;
  battery: boolean;
  location: boolean;
  backgroundLocation: boolean;
}
export interface AdhanStatus {
  enabled: boolean;
  nextName: string;
  nextAt: number;
  nextExact: boolean;
  location: string;
  locationAt: number;
  hasLocation: boolean;
  country: string | null;
  method: string;
  perms: AdhanPerms;
}
export interface AdhanConfig {
  enabled?: boolean;
  wecker?: boolean;
  reciter?: string;
  lat?: number;
  lon?: number;
  label?: string;
  manual?: boolean;
}
export interface DayTimes {
  timings: { Fajr: string; Sunrise: string; Dhuhr: string; Asr: string; Maghrib: string; Isha: string };
  method: string;
  methodId: string;
  country: string | null;
}

const mod = Platform.OS === 'android' ? NativeModules.AdhanModule : undefined;

/** Neue App mit Rechenkern auf dem Handy? (Ältere Builds haben nur scheduleAlarm.) */
export const adhanNativeAvailable = !!(mod && typeof mod.configure === 'function');

export async function configureAdhan(cfg: AdhanConfig): Promise<AdhanStatus | null> {
  if (!adhanNativeAvailable) return null;
  return mod.configure(cfg);
}

export async function adhanTimesFor(lat: number, lon: number): Promise<DayTimes | null> {
  if (!adhanNativeAvailable) return null;
  return mod.timesFor(lat, lon);
}

export async function adhanStatus(): Promise<AdhanStatus | null> {
  if (!adhanNativeAvailable) return null;
  return mod.getStatus();
}

/** exact | overlay | fullscreen | battery | notifications | location */
export async function openAdhanPermission(which: string): Promise<void> {
  if (!adhanNativeAvailable) return;
  await mod.openPermission(which);
}

/** Erlaubnisse so, wie die Einstellungsseite sie liest. */
export function adhanPermsForPage(st: AdhanStatus) {
  const p = st.perms;
  return {
    notifications: p.notifications, exactAlarms: p.exact, overlay: p.overlay, fullscreen: p.fullscreen,
    battery: p.battery, location: p.location, backgroundLocation: p.backgroundLocation,
  };
}
