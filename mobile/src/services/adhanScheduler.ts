/**
 * Adhan-Planung fuer den ganzen Tag.
 *
 * Der Dienst haengt in App.tsx — nicht an einem Bildschirm — und plant bei:
 *   - App-Start
 *   - AppState -> active (die App war davor im Hintergrund oder zu)
 *
 * Die Einstellungen liest er selbst aus dem AsyncStorage. Er darf sie nicht von
 * einem Bildschirm bekommen: derselbe Bildschirm, der die Daten laedt, ist nicht
 * in jedem Layout vorhanden.
 *
 * Die Reihenfolge der Alarme steht in adhanSchedule.core.mjs und ist dort
 * getestet; hier laeuft nur noch der Abruf der Daten.
 */
import { AppState, type AppStateStatus } from 'react-native';
import {
  getCurrentLocation, getChosenLocation, fetchPrayerTimes, PRAYER_NAMES, type PrayerTimes,
} from './prayer.service';
import {
  getAdhanEnabled, getFajrWecker, getSelectedAdhan, scheduleTestAdhan, cancelAllAdhanNotifications,
} from './adhan.service';
import { adhanNativeAvailable, configureAdhan } from './adhanNative';
import { usePrayerStore } from '../store/prayerStore';
import { planAdhans } from './adhanSchedule.core.mjs';

/** Was der Dienst zum Planen braucht. Ueber __setSchedulerDeps austauschbar fuer Tests. */
export interface SchedulerDeps {
  /** Standort + Zeiten in einem Rutsch — sonst holt er den Standort doppelt. */
  fetchTimes(): Promise<PrayerTimes | null>;
  isEnabled(): Promise<boolean>;
  fajrWecker(): Promise<boolean>;
  /** Ein Alarm. Der Aufrufer entscheidet selbst, ob er in der Vergangenheit liegt. */
  schedule(name: string, time: string, arabic: string, delaySec: number, wecker: boolean): Promise<unknown>;
  cancel(): Promise<void>;
  now(): Date;
}

const realDeps: SchedulerDeps = {
  async fetchTimes() {
    const loc = await getCurrentLocation();
    if (!loc) return null;
    const method = usePrayerStore.getState().method;
    const data = await fetchPrayerTimes(loc.latitude, loc.longitude, method);
    return data ? data.timings : null;
  },
  isEnabled: getAdhanEnabled,
  fajrWecker: getFajrWecker,
  schedule: scheduleTestAdhan,
  cancel: cancelAllAdhanNotifications,
  now: () => new Date(),
};

let deps: SchedulerDeps = realDeps;
let started = false;
let inFlight: Promise<void> | null = null;

/** Nur fuer Tests. */
export function __setSchedulerDeps(next: Partial<SchedulerDeps>): void {
  deps = { ...deps, ...next };
}

/** Nur fuer Tests: zurueck auf die echten Dienste. */
export function __resetSchedulerDeps(): void {
  deps = realDeps;
  started = false;
  inFlight = null;
}

/**
 * Alarme fuer die restlichen Gebete des Tages neu planen.
 *
 * Zweimal hintereinander aufrufen ist unschaedlich: der zweite Aufruf wartet auf
 * den ersten. AppState -> active und ein spaeterer Aufruf aus dem Layout-Wechsel
 * koennen im selben Tick feuern, und ohne diesen Schutz entstuenden doppelte
 * Alarme.
 *
 * Wirft nie. Planen darf nicht den Aufrufer mitnehmen: sonst faellt bei einem
 * Netzfehler die ganze App aus.
 */
export async function refreshAdhanSchedule(reason: string): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // Neuer Weg: das Handy rechnet und plant selbst (auch ohne laufende App,
      // nach Neustart, beim Reisen). Hier nur Einstellungen + Standort abgeben.
      if (adhanNativeAvailable && deps === realDeps) { await syncNative(); return; }
      const timings = await deps.fetchTimes();
      // Ohne Standort oder ohne Netz die bestehenden Alarme stehen lassen. Der
      // Nutzer soll nicht durch ein leeres WLAN seine Wecker verlieren.
      if (!timings) return;

      // Immer erst abbrechen, dann neu stellen. Sonst stuenden die Alarme des
      // letzten Plans noch und kaemen zu denselben Zeiten ein zweites Mal.
      await deps.cancel();

      if (!(await deps.isEnabled())) return;

      const weckerFajr = await deps.fajrWecker();
      const plan = planAdhans(timings, PRAYER_NAMES, deps.now(), weckerFajr);
      for (const item of plan) {
        const target = new Date(deps.now());
        const [h, m] = item.time.split(':').map(Number);
        target.setHours(h, m, 0, 0);
        const delaySec = Math.round((target.getTime() - deps.now().getTime()) / 1000);
        if (delaySec <= 0) continue; // zwischen Plan und Schleife gerade vorbei
        await deps.schedule(item.name, item.time, item.arabic, delaySec, item.wecker);
      }
    } catch (err) {
      console.warn('[adhan] scheduling failed', reason, err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function syncNative(): Promise<void> {
  const chosen = await getChosenLocation();
  const loc = chosen
    ? { latitude: chosen.latitude, longitude: chosen.longitude, city: chosen.label, country: undefined as string | undefined }
    : await getCurrentLocation().catch(() => null);
  const label = chosen ? chosen.label : [loc?.city, loc?.country].filter(Boolean).join(', ');
  await configureAdhan({
    enabled: await getAdhanEnabled(),
    wecker: await getFajrWecker(),
    reciter: await getSelectedAdhan(),
    // Ohne frischen Standort behält das Handy seinen letzten (oder holt ihn selbst).
    ...(loc ? { lat: loc.latitude, lon: loc.longitude, label, manual: !!chosen } : {}),
  });
}

/** Idempotent. Mehrfaches Aufrufen richtet keinen zweiten Listener ein. */
export function startAdhanScheduler(): void {
  if (started) return;
  started = true;

  void refreshAdhanSchedule('start');

  AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') void refreshAdhanSchedule('resume');
  });
}