/**
 * Terminal-Historie über einen App-Neustart hinweg.
 *
 * Der Server schickt beim Reattach nur, was seit dem Trennen dazukam — die
 * zuvor gesehene Ausgabe kennt nur der Client. Das klassische Terminal hält sie
 * im Speicher (TerminalView.viewBuffers); die überlebt das Umschalten der
 * Oberfläche, aber keinen Kaltstart. Hier liegt sie zusätzlich auf der Platte,
 * damit die Terminals auch nach dem Beenden der App wieder gefüllt sind.
 *
 * WÄRME: Diese Datei lief früher heiß mit. Zwei Gründe, beide behoben:
 *
 *  1. Jedes Häppchen machte `cache[id] = alt + neu` — eine Kopie von bis zu 40 KB
 *     pro Nachricht. Jetzt sammeln wir Häppchen in einem Array und fügen sie erst
 *     zusammen, wenn wirklich jemand den Text will (Speichern, Wiederherstellen).
 *  2. Gespeichert wurde 2 s nach dem letzten Häppchen — bei Dauerausgabe also
 *     ALLE 2 s, jedes Mal die komplette Historie aller Sitzungen als JSON (bis zu
 *     ~480 KB) auf die Platte. Über einen 10-Minuten-Lauf sind das hunderte
 *     Megabyte Schreiblast. Jetzt: gespeichert wird, wenn der Strom zur Ruhe kommt
 *     (SAVE_IDLE_MS) — und während er läuft höchstens alle SAVE_MAX_WAIT_MS, damit
 *     ein Absturz mitten im Lauf nicht die ganze Historie kostet.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'tms:s2:scrollback';
/** Pro Session gesichert. Genug für einen Bildschirm Historie, klein genug für die Platte. */
const PER_SESSION_MAX = 40_000;
const MAX_SESSIONS = 12;
/** So lange muss der Strom still sein, damit gespeichert wird. */
const SAVE_IDLE_MS = 3_000;
/** …und so lange darf ein Dauerstrom das Speichern höchstens hinauszögern. */
const SAVE_MAX_WAIT_MS = 30_000;

/** Häppchen pro Session, noch nicht zusammengefügt. */
let cache: Record<string, string[]> = {};
/** Zeichenlänge pro Session — damit das Kürzen nicht jedes Mal joinen muss. */
let lens: Record<string, number> = {};
let hydrated = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

export async function hydrateScrollback(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const stored: Record<string, string> = JSON.parse(raw);
      for (const [id, text] of Object.entries(stored)) {
        cache[id] = [text];
        lens[id] = text.length;
      }
    }
  } catch {
    cache = {};
    lens = {};
  }
}

/** Häppchen zusammenfügen — nur hier entsteht der große String. */
function textOf(sessionId: string): string {
  const parts = cache[sessionId];
  if (!parts) return '';
  if (parts.length > 1) {
    const joined = parts.join('');
    cache[sessionId] = [joined];
    lens[sessionId] = joined.length;
    return joined;
  }
  return parts[0] ?? '';
}

export function getScrollback(sessionId: string): string | undefined {
  if (!cache[sessionId]) return undefined;
  return textOf(sessionId);
}

export function appendScrollback(sessionId: string, data: string): void {
  const parts = cache[sessionId] ?? (cache[sessionId] = []);
  parts.push(data);
  lens[sessionId] = (lens[sessionId] ?? 0) + data.length;

  // Erst kürzen, wenn spürbar zu viel angefallen ist — sonst würde jedes Häppchen
  // den Puffer erneut zusammenfügen und genau die Kopiererei zurückholen.
  if (lens[sessionId] > PER_SESSION_MAX * 1.5) {
    const full = textOf(sessionId);
    const sliced = full.slice(full.length - PER_SESSION_MAX);
    // An einer Zeilengrenze abschneiden: eine halbe ANSI-Sequenz würde die
    // Darstellung beim Zurückspielen zerlegen.
    const nl = sliced.indexOf('\n');
    const trimmed = nl >= 0 ? sliced.slice(nl + 1) : sliced;
    cache[sessionId] = [trimmed];
    lens[sessionId] = trimmed.length;
  }

  const ids = Object.keys(cache);
  if (ids.length > MAX_SESSIONS) {
    delete cache[ids[0]];
    delete lens[ids[0]];
  }

  scheduleSave();
}

function scheduleSave(): void {
  // Ruhe-Fenster: jedes neue Häppchen schiebt das Speichern nach hinten …
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(save, SAVE_IDLE_MS);
  // … aber ein Dauerstrom darf es nicht ewig verhindern.
  if (!maxWaitTimer) maxWaitTimer = setTimeout(save, SAVE_MAX_WAIT_MS);
}

function save(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
  const flat: Record<string, string> = {};
  for (const id of Object.keys(cache)) flat[id] = textOf(id);
  AsyncStorage.setItem(KEY, JSON.stringify(flat)).catch(() => {});
}

/** Eine geschlossene Session braucht keine Historie mehr. */
export function dropScrollback(sessionId: string): void {
  if (!(sessionId in cache)) return;
  delete cache[sessionId];
  delete lens[sessionId];
  save();
}

/** Beim Verlassen der App nichts verlieren, was noch im Ruhe-Fenster hängt. */
export function flushScrollback(): void {
  if (idleTimer || maxWaitTimer) save();
}
