/**
 * Output pacing per client connection — the phone pays per message.
 *
 * Measured on the phone (Android battery stats, one day): terminal output of
 * working AI sessions arrives as ~13 small messages per second, around the
 * clock — also for terminals that are covered by another one, and also while
 * the app is not on screen at all. That stream kept the cellular radio awake
 * (269 mAh mobile radio, 125 of it with the app in the background) and woke
 * the app's JS and WebView for every spinner frame nobody saw.
 *
 * The pacer changes WHEN bytes are sent, never WHICH bytes or their order:
 *
 *   live  the terminal in front (or the client said nothing): send at once
 *   slow  a covered terminal: one bundle per second
 *   hold  the app is not visible: one bundle per 30 s, everything at once the
 *         moment the app comes back
 *
 * Detectors (prompt, idle, auto-approve) are fed BEFORE the pacer, so their
 * timing is untouched. What is still unsent when a connection ends is handed
 * back through take() so the reattach logic counts it as missed output.
 */

export type Pace = 'live' | 'slow' | 'hold';

export const SLOW_MS = 1000;
export const HOLD_MS = 30_000;
/** A covered terminal producing lots of output (a build log) is not held back for long. */
export const SLOW_MAX_BYTES = 32 * 1024;
/** Upper bound of what one held session may queue before it is sent anyway. */
export const HOLD_MAX_BYTES = 256 * 1024;
/** After a keystroke the terminal answers immediately, whatever the client reported. */
export const INPUT_LIVE_MS = 3000;

/**
 * focus: null = the client reported nothing or shows several terminals → all live;
 *        ''   = no terminal on screen → all slow;
 *        id   = that session is in front.
 */
export function paceFor(foreground: boolean, focus: string | null, sessionId: string): Pace {
  if (!foreground) return 'hold';
  if (focus === null) return 'live';
  return focus === sessionId ? 'live' : 'slow';
}

export interface PacerClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const REAL_CLOCK: PacerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface OutputPacer {
  push(sessionId: string, data: string): void;
  setAttention(foreground: boolean, focus: string | null): void;
  noteInput(sessionId: string): void;
  /** Remove and return what is queued for a session (connection ends / session detaches). */
  take(sessionId: string): string;
  dispose(): void;
}

export function createOutputPacer(
  deliver: (sessionId: string, data: string) => void,
  clock: PacerClock = REAL_CLOCK,
): OutputPacer {
  let foreground = true;
  let focus: string | null = null;
  const queued = new Map<string, { data: string; timer: unknown }>();
  const lastInput = new Map<string, number>();

  const flush = (sessionId: string): void => {
    const q = queued.get(sessionId);
    if (!q) return;
    clock.clearTimer(q.timer);
    queued.delete(sessionId);
    if (q.data) deliver(sessionId, q.data);
  };

  const paceOf = (sessionId: string): Pace => {
    const typed = lastInput.get(sessionId);
    if (typed !== undefined && clock.now() - typed < INPUT_LIVE_MS && foreground) return 'live';
    return paceFor(foreground, focus, sessionId);
  };

  return {
    push(sessionId, data) {
      const pace = paceOf(sessionId);
      if (pace === 'live') {
        flush(sessionId); // older bytes first — order must never flip
        deliver(sessionId, data);
        return;
      }
      const q = queued.get(sessionId);
      if (q) {
        q.data += data;
      } else {
        const timer = clock.setTimer(() => flush(sessionId), pace === 'hold' ? HOLD_MS : SLOW_MS);
        queued.set(sessionId, { data, timer });
      }
      const size = queued.get(sessionId)!.data.length;
      if (size >= (pace === 'hold' ? HOLD_MAX_BYTES : SLOW_MAX_BYTES)) flush(sessionId);
    },

    setAttention(nextForeground, nextFocus) {
      if (nextForeground === foreground && nextFocus === focus) return;
      foreground = nextForeground;
      focus = nextFocus;
      // Whatever the change was (came back, went away, other terminal in
      // front): start from a clean slate. Changes happen at human pace.
      for (const sessionId of [...queued.keys()]) flush(sessionId);
    },

    noteInput(sessionId) {
      lastInput.set(sessionId, clock.now());
      flush(sessionId);
    },

    take(sessionId) {
      const q = queued.get(sessionId);
      lastInput.delete(sessionId);
      if (!q) return '';
      clock.clearTimer(q.timer);
      queued.delete(sessionId);
      return q.data;
    },

    dispose() {
      for (const q of queued.values()) clock.clearTimer(q.timer);
      queued.clear();
      lastInput.clear();
    },
  };
}
