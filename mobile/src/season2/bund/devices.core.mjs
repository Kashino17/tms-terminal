/**
 * Bund — alle Geräte gleichberechtigt. Es gibt keinen Hauptserver: Dateien,
 * Upload, Ports, Prozesse, Entsperren gehören zum Gerät des Terminals, das
 * vorne ist; Diktat zum ersten Gerät, das es kann.
 * JavaScript, damit scripts/bund-devices.test.mjs es unter node:test prüft.
 */
const PALETTE = ['#9b8cff', '#3bc9db', '#f59f00'];

export function deviceColor(index) {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** Gerät einer Sitzung, falls es im Bund bekannt ist. */
export function deviceForSession(sessionServer, sessionId, devices) {
  const id = sessionId ? sessionServer[sessionId] : undefined;
  return id && devices.some((d) => d.id === id) ? id : null;
}

/** Gerät des Terminals vorne; sonst das erste online-Gerät; sonst null. */
export function activeDeviceId(activeSessionId, sessionServer, devices) {
  const own = deviceForSession(sessionServer, activeSessionId, devices);
  if (own) return own;
  const first = devices.find((d) => d.online);
  return first ? first.id : null;
}

/** Erstes online-Gerät, das diktieren kann (caps.dictation); sonst null. */
export function dictationDeviceId(devices) {
  const d = devices.find((x) => x.online && (x.caps || []).includes('dictation'));
  return d ? d.id : null;
}

/** Erstes online-Gerät, das in der geklonten Stimme vorlesen kann (caps.speech); sonst null. */
export function speechDeviceId(devices) {
  const d = devices.find((x) => x.online && (x.caps || []).includes('speech'));
  return d ? d.id : null;
}
