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
  // 1. [y/N] — capital-N default means bare Enter declines; send 'y'.
  if (/\[y\/N\]/.test(window)) return 'y\r';

  // 2. Standard Claude Code numbered prompt — option 1 (Yes) is the default. The
  //    option words arrive ANSI-glued ("1.Yes" / "Esctocancel"), so match loosely.
  if (/1\.?\s*Yes/i.test(window) || /Esc\s*to\s*cancel/i.test(window)) return '\r';

  // 3. [Y/n] / explicit yes-default confirmations — Enter approves.
  if (/\[Y\/n\]/.test(window)) return '\r';

  // 4. Free-text input prompt ("Question? ›" / "? [" / "? (") with no yes-option
  //    above — do NOT auto-press; let the user answer.
  if (/\?\s*(›|\[|\()/.test(window)) return null;

  // 5. Generic yes/no confirmation — Enter is the conventional accept.
  return '\r';
}
