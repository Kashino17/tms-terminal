/**
 * Aufmerksamkeit der App — reine Logik, ohne React Native (testbar mit node).
 *
 * Der Server taktet die Terminal-Ausgabe danach, was die App gerade zeigt
 * (server/src/websocket/output.pacer.ts): das Terminal vorne sofort, verdeckte
 * gebündelt, bei unsichtbarer App fast nichts. Dafür meldet die App zwei Dinge:
 * ist sie sichtbar (foreground) und welches Terminal ist zu sehen (focus).
 */

/**
 * Welches Terminal ist wirklich zu sehen?
 *   Sitzungs-ID  genau dieses (Stapel, kompakt, Desk)
 *   null         mehrere gleichzeitig (Liste, Übersicht) → der Server bremst keins
 *   ''           keins (anderer Bildschirm, Fernzugriff, Sperre)
 */
export function focusOf({ terminalsVisible, remote, overview, listView, compact, activeSession }) {
  if (!terminalsVisible || remote) return '';
  if (overview || (listView && !compact)) return null;
  return activeSession || '';
}

const signature = (foreground, focus) => `${foreground ? 1 : 0}|${focus === null ? '*' : focus}`;

/**
 * An welche Verbindungen muss der aktuelle Stand (noch) gemeldet werden?
 * `sent` merkt je Gerät, was zuletzt gemeldet wurde. Eine getrennte Verbindung
 * verliert ihren Merker: der Server beginnt nach jedem Neuaufbau bei „alles
 * live", also muss danach neu gemeldet werden.
 */
export function planAttention(devices, sent, foreground, focus) {
  const sig = signature(foreground, focus);
  const next = {};
  const send = [];
  for (const d of devices) {
    if (!d.connected) continue;
    if (sent[d.id] !== sig) send.push(d.id);
    next[d.id] = sig;
  }
  return { send, sent: next };
}

/**
 * Wie oft die Verbindung geprüft wird — jeder Ping weckt das Funkmodul.
 *   live   ein Ping-Wert ist zu sehen (Seitenleiste, Bund, Fernzugriff): alle 3 s
 *   calm   App sichtbar, aber nirgends ein Ping-Wert: nur die Leitung prüfen
 *   quiet  App unsichtbar: die Leitung halten, mehr nicht
 * `aligned`: seltene Pings aller Geräte fallen auf dieselbe Uhr-Marke — ein
 * Aufwachen des Funkmoduls statt eines pro Gerät.
 */
export function pingPlan(mode) {
  if (mode === 'quiet') return { pingMs: 60000, watchdogMs: 150000, aligned: true };
  if (mode === 'calm') return { pingMs: 12000, watchdogMs: 40000, aligned: true };
  return { pingMs: 3000, watchdogMs: 30000, aligned: false };
}

/** Zeit bis zum nächsten Ping; ausgerichtet = bis zur nächsten Uhr-Marke des Intervalls. */
export function nextPingDelay(pingMs, aligned, now) {
  if (!aligned) return pingMs;
  return pingMs - (now % pingMs);
}

export function pingMode(appVisible, latencyVisible) {
  if (!appVisible) return 'quiet';
  return latencyVisible ? 'live' : 'calm';
}
