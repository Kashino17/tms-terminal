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
 * Wie oft die Verbindung geprüft wird. Sichtbar: alle 3 s (ehrliche
 * Ping-Anzeige). Unsichtbar zeigt niemand einen Ping an — dann reicht es, die
 * Leitung zu halten; jeder Ping weckt sonst das Funkmodul.
 */
export function pingPlan(quiet) {
  return quiet ? { pingMs: 30000, watchdogMs: 90000 } : { pingMs: 3000, watchdogMs: 30000 };
}
