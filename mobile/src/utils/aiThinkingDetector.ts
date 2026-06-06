/**
 * Detects whether a Claude/Codex/Gemini CLI is actively waiting for the model
 * (the "thinking" / "Contemplating… (1m 31s)" state). Stateful per session
 * because we need an idle timer — Claude may stop printing thinking output
 * without printing a fresh prompt back, so a timer is the safety net.
 */
import { stripAnsi } from './stripAnsi';

// Three independent signals — ANY match flips the detector to "thinking".
// The verb list approach proved fragile: Claude rotates many verbs
// (Caramelizing, Sautéing, Mustering, …) and even reprints them only
// occasionally during a tick, so we shifted to format-based heuristics
// that key on the elapsed-time component (which IS reprinted every tick).

// (1) Strong universal signal — every CLI prints this while waiting.
const ESC_INTERRUPT = /esc to interrupt/i;

// (2) Parenthesized elapsed time, e.g. "(45s)", "(7m 14s)",
// "(7m 14s · ↓ 154 tokens · thinking)". Claude's footer format.
const ELAPSED_PAREN = /\(\s*(?:\d+m\s+)?\d+s\b/i;

// (3) "for Nm Ns" / "for Ns" — Claude's verb-prefixed format like
// "Sautéed for 6m 4s" or "Working for 12s". Any verb in front works.
const FOR_ELAPSED = /\bfor\s+(?:\d+m\s+)?\d+s\b/i;

export interface ThinkingDetector {
  /** Feed an output chunk (raw, ANSI included). Updates internal state. */
  feed(data: string): void;
  /** Current state. */
  isThinking(): boolean;
  /** Subscribe to state flips. Returns an unsubscribe function. */
  onChange(cb: (thinking: boolean) => void): () => void;
  /** Stop timers, clear listeners. */
  dispose(): void;
}

export function createThinkingDetector(opts?: {
  idleTimeoutMs?: number;
}): ThinkingDetector {
  const idleMs = opts?.idleTimeoutMs ?? 2000;
  let thinking = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(t: boolean) => void>();

  function emit(next: boolean) {
    if (next === thinking) return;
    thinking = next;
    // Diagnostic — remove once the glow is verified working in the wild.
    // eslint-disable-next-line no-console
    console.log('[GLOW] detector emit', next);
    listeners.forEach((cb) => {
      try { cb(next); } catch { /* listener errors must not break the detector */ }
    });
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      emit(false);
    }, idleMs);
  }

  return {
    feed(data) {
      const clean = stripAnsi(data);
      const match =
        ESC_INTERRUPT.test(clean) ||
        ELAPSED_PAREN.test(clean) ||
        FOR_ELAPSED.test(clean);
      if (match) {
        emit(true);
        armIdleTimer();
      }
      // No match → leave thinking as-is; the idle timer will flip it false.
    },
    isThinking() {
      return thinking;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      clearIdleTimer();
      listeners.clear();
    },
  };
}
