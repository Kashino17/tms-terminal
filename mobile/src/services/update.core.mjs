// Reine Regeln für den In-App-Updater (ohne React Native, testbar).

/** Regelmäßig nachsehen, solange die App läuft — kein Neustart nötig. */
export const CHECK_EVERY_MS = 15 * 60_000;
/** Beim Zurückholen der App höchstens so oft (GitHub erlaubt 60 Abfragen/h). */
export const RESUME_GAP_MS = 10 * 60_000;

export function shouldCheck(now, lastCheck, minGapMs) {
  return !lastCheck || now - lastCheck >= minGapMs;
}

/** Fortschritt an die Seite: höchstens ~5×/s, das Ende immer. */
export function shouldReport(now, lastSent, received, total) {
  return (total > 0 && received >= total) || now - lastSent >= 200;
}

export function apkFileName(version) {
  const v = String(version).replace(/^v/, '').replace(/[^0-9A-Za-z.-]/g, '').replace(/\.\.+/g, '.').replace(/^\.+/, '');
  return `TMS-Terminal-${v}.apk`;
}
