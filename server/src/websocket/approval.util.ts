// Pure helpers for server-side auto-approve. Kept dependency-free and side-effect
// free so they can be unit-tested without standing up a WebSocket/PTY.

/**
 * Recompute the user's pending (unsent) input length after a chunk of raw
 * terminal input. Used to pause auto-approve while the user has text on the line.
 *
 * Crucially this must SELF-HEAL: word/line-kill keys reset to 0 so a single
 * Ctrl-W / Ctrl-K can't pin the count above zero forever and silently block
 * every future auto-approve for the session.
 */
export function computePendingLen(prev: number, data: string): number {
  let len = prev;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x0d || c === 0x0a) {          // Enter — line submitted
      len = 0;
    } else if (c === 0x03 || c === 0x15) {   // Ctrl-C / Ctrl-U — line cancelled/cleared
      len = 0;
    } else if (c === 0x17 || c === 0x0b) {   // Ctrl-W / Ctrl-K — delete word / kill to EOL
      len = 0;                               // conservatively clear (can't track word bounds)
    } else if (c === 0x7f || c === 0x08) {   // Backspace / BS
      len = Math.max(0, len - 1);
    } else if (c === 0x1b) {                  // Escape sequence (arrows, Del, etc.) — skip, no count change
      if (i + 1 < data.length) {
        const next = data.charCodeAt(i + 1);
        if (next === 0x5b || next === 0x4f) { // CSI [ or SS3 O
          i += 2;
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x3f) i++;
        } else {
          i++; // Alt+key
        }
      }
    } else if (c >= 0x20) {                    // Printable character
      len++;
    }
  }
  return len;
}

/**
 * Decide which keystroke approves a detected prompt, given the cleaned text the
 * match was found in. Returns the bytes to write, or `null` when we must NOT
 * blindly auto-press (a free-text input where Enter would submit garbage).
 *
 * Verified against Claude Code v2.1.193: the standard numbered prompt
 * pre-highlights "1. Yes", so a bare Enter approves. A `[y/N]` prompt defaults
 * to No, so Enter would DECLINE — we send "y" there instead.
 */
export function chooseApprovalKey(window: string): string | null {
  // SICHERHEIT — die Lehre aus einem echten Zwischenfall: Ein WARTENDER Prompt
  // steht immer in der ALLERLETZTEN Zeile, dort blinkt der Cursor. Erwähnt eine
  // KI dagegen nur im Fließtext ein "[y/N]" (oder ein Log-/Commit-Text tut es),
  // steht das mitten im Fenster, und die letzte Zeile ist die Eingabebox der KI.
  // Vorher wurde das GANZE Fenster durchsucht: die App tippte daraufhin "y" +
  // Enter in die laufende KI-Sitzung und verschickte es als Nachricht.
  const lastLine = window.slice(window.lastIndexOf('\n') + 1).trim();

  // Cursor auf einer frischen, leeren Zeile: da wartet nichts.
  if (!lastLine) return null;

  // 1. [y/N] — capital-N default means bare Enter declines; send 'y'.
  if (/\[y\/N\]/.test(lastLine)) return 'y\r';

  // 2. Standard Claude Code numbered prompt — option 1 (Yes) is the default. The
  //    option words arrive ANSI-glued ("1.Yes" / "Esctocancel"), so match loosely.
  if (/1\.?\s*Yes/i.test(lastLine) || /Esc\s*to\s*cancel/i.test(lastLine)) return '\r';

  // 3. [Y/n] / explicit yes-default confirmations — Enter approves.
  if (/\[Y\/n\]/.test(lastLine)) return '\r';

  // 4. Free-text input prompt ("Question? ›" / "? [" / "? (") with no yes-option
  //    above — do NOT auto-press; let the user answer.
  if (/\?\s*(›|\[|\()/.test(lastLine)) return null;

  // 5. Generische Ja/Nein-Bestätigung: Enter. Aber NUR, wenn die letzte Zeile
  //    auch wirklich nach einer Frage aussieht — sonst lieber gar nichts drücken
  //    und den Nutzer fragen, als blind in eine KI-Sitzung zu tippen.
  if (/\?|\by\/n\b|proceed|continue|are you sure|confirm/i.test(lastLine)) return '\r';
  return null;
}

// ── Approval gate ─────────────────────────────────────────────────────
// The full go/no-go decision as a pure function, so the handler can simply
// re-run it on a retry. History: "user typing" used to swallow an approval
// FOREVER (the detector's dedup hash never changes while a prompt just sits
// there waiting), which is exactly how auto-approve felt unreliable.

export const TYPING_PAUSE_MS = 2000;   // pause while the user typed <2s ago
export const PENDING_STALE_MS = 15_000; // unsent-text counter expires after 15s

export interface ApprovalGateInput {
  window: string;       // cleaned tail window the prompt was detected in
  pendingLen: number;   // tracked unsent input length for the session
  sinceInputMs: number; // ms since the user's last keystroke
}

export type ApprovalGateResult =
  | { gate: 'send'; key: string }
  | { gate: 'blocked-pending' }   // retry later — user has text on the line
  | { gate: 'paused-typing' }     // retry later — user typed just now
  | { gate: 'notify-only' };      // free-text prompt — never auto-press

export function evaluateApprovalGate(inp: ApprovalGateInput): ApprovalGateResult {
  if (inp.pendingLen > 0 && inp.sinceInputMs < PENDING_STALE_MS) return { gate: 'blocked-pending' };
  if (inp.sinceInputMs < TYPING_PAUSE_MS) return { gate: 'paused-typing' };
  const key = chooseApprovalKey(inp.window);
  return key === null ? { gate: 'notify-only' } : { gate: 'send', key };
}

