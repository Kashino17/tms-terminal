/**
 * Terminal-Historie über einen App-Neustart hinweg.
 *
 * Der Server schickt beim Reattach nur, was seit dem Trennen dazukam — die
 * zuvor gesehene Ausgabe kennt nur der Client. Das klassische Terminal hält sie
 * im Speicher (TerminalView.viewBuffers); die überlebt das Umschalten der
 * Oberfläche, aber keinen Kaltstart. Hier liegt sie zusätzlich auf der Platte,
 * damit die Terminals auch nach dem Beenden der App wieder gefüllt sind.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'tms:s2:scrollback';
/** Pro Session gesichert. Genug für einen Bildschirm Historie, klein genug für die Platte. */
const PER_SESSION_MAX = 40_000;
const MAX_SESSIONS = 12;
const SAVE_DEBOUNCE_MS = 2_000;

let cache: Record<string, string> = {};
let hydrated = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export async function hydrateScrollback(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
}

export function getScrollback(sessionId: string): string | undefined {
  return cache[sessionId];
}

export function appendScrollback(sessionId: string, data: string): void {
  const combined = (cache[sessionId] ?? '') + data;
  // An einer Zeilengrenze abschneiden: eine halbe ANSI-Sequenz würde die
  // Darstellung beim Zurückspielen zerlegen.
  if (combined.length > PER_SESSION_MAX) {
    const sliced = combined.slice(combined.length - PER_SESSION_MAX);
    const nl = sliced.indexOf('\n');
    cache[sessionId] = nl >= 0 ? sliced.slice(nl + 1) : sliced;
  } else {
    cache[sessionId] = combined;
  }

  const ids = Object.keys(cache);
  if (ids.length > MAX_SESSIONS) delete cache[ids[0]];

  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

/** Eine geschlossene Session braucht keine Historie mehr. */
export function dropScrollback(sessionId: string): void {
  if (!(sessionId in cache)) return;
  delete cache[sessionId];
  AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => {});
}
