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

// ── Status-Footer unter der Prompt-Box ──────────────────────────────────────
// Claude Code rendert seine Task-Liste UNTER der Berechtigungsbox ("15 tasks
// (8 done, …)", ■/□-Zeilen, "… +2 pending"). Die Box ist dann nicht mehr das
// Letzte auf dem Schirm, und jede "der Prompt steht am Ende"-Heuristik verliert
// sie (Vorfall 2026-07-20: Auto-Approve stand, sobald Tasks liefen). Diese
// Zeilen sind eindeutig Status-Chrome — keine KI-Prosa schreibt sie —, also
// werden sie vor der Tail-Analyse abgeschnitten. Wird KEIN Footer erkannt,
// bleibt die Eingabe unverändert: die Prosa-Strenge von matchPrompt und
// chooseApprovalKey gilt dann exakt wie zuvor.
const FOOTER_LINE_PATTERNS = [
  /^[■□◻◼▪▫☐✓✔○●]/,      // Task-Bullet
  /\d+\s*tasks?\s*\(/i,    // "15 tasks (8 done, 2 in progress, …" — auch ANSI-verklebt
  /\+\s*\d+\s*pending/i,   // "… +2 pending, 8 completed"
  /^…/,                    // Summen-/Abschneidezeile
];
// Zeilen, die zur Box selbst gehören — hier endet das Abschneiden sofort.
const BOX_LINE_PATTERNS = [
  /❯/,
  /^\s*[1-9][.)]/,         // nummerierte Option
  /Esc\s*to\s*cancel/i,
];

/** Schneidet einen erkannten Status-Footer (Task-Liste) vom Zeilen-Ende ab.
 *  `grace` erlaubt einzelne umbrochene Fortsetzungszeilen ZWISCHEN erkannten
 *  Footer-Zeilen (schmale Terminals brechen "…, 5 open)" auf zwei Zeilen um). */
export function stripStatusFooter(lines: string[]): string[] {
  const out = [...lines];
  let sawFooter = false;
  let grace = 0;
  let budget = 20; // nie mehr als ~einen Screen abschneiden
  while (out.length > 0 && budget > 0) {
    const line = out[out.length - 1].trim();
    if (!line) { out.pop(); budget--; continue; }
    if (BOX_LINE_PATTERNS.some((p) => p.test(line))) break;
    if (FOOTER_LINE_PATTERNS.some((p) => p.test(line))) {
      out.pop(); budget--; sawFooter = true; grace = 2; continue;
    }
    if (sawFooter && grace > 0) { out.pop(); budget--; grace--; continue; }
    break;
  }
  return sawFooter ? out : lines;
}

/**
 * Decide which keystroke approves a detected prompt, given the cleaned text the
 * match was found in. Returns the bytes to write, or `null` when we must NOT
 * blindly auto-press.
 *
 * GRUNDSATZ (nach zwei echten Vorfällen, beide Server-Log-bewiesen): Enter
 * wird NUR gedrückt, wenn das Fenster POSITIV beweist, dass eine Ja-Antwort
 * zur Wahl steht — eine nummerierte Optionsliste, deren Option 1 mit
 * Yes/Ja/Allow/Approve beginnt (Claude Code, Gemini CLI, Codex nummerieren
 * alle so), oder ein end-anchored [y/N]/[Y/n]. Alles andere — Freitext,
 * Auswahlfragen (Multiple Choice/Select), generische Sätze mit Fragezeichen —
 * ist KEIN Ja/Nein und wird nur gemeldet, nie beantwortet:
 *  - Vorfall 1: "letzte Zeile enthält ?" schickte den halb getippten Text
 *    des Nutzers ab (sein Echo endete mit einem Fragezeichen).
 *  - Vorfall 2 (latent): "Esc to cancel gesehen → Enter" hätte bei jeder
 *    Auswahlfrage blind die erste Option gewählt — gleiche Box, gleicher
 *    Footer, aber inhaltliche Antworten statt Ja/Nein.
 */
export function chooseApprovalKey(window: string): string | null {
  // Leere Zeilen am Ende sind ein Rendering-Zwischenstand des Fast-Path
  // (Fenster endet oft, bevor "Esc to cancel" nachgeladen ist) — abschneiden,
  // sonst wird ein längst sichtbarer Prompt als "nichts wartet" verworfen.
  // Ebenso die Task-Liste, die Claude Code UNTER die Box rendert.
  const lines = stripStatusFooter(window.split('\n'));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const lastLine = (lines[lines.length - 1] ?? '').trim();
  if (!lastLine) return null;

  // 1. Klassisches [y/N]/[Y/n] — nur am ZEILENENDE (dort blinkt der Cursor);
  //    mitten im Satz ist es Prosa, kein wartender Prompt. Optional folgt dem
  //    Marker noch ein ":"/Leerzeichen ("Proceed? [y/N]: ").
  if (/\[y\/N\]\s*:?\s*$/.test(lastLine)) return 'y\r'; // Default No — Enter würde ablehnen
  if (/\[Y\/n\]\s*:?\s*$/.test(lastLine)) return '\r';  // Default Yes — Enter bestätigt

  // 2. Nummerierte Optionsliste im Schwanz des Fensters einsammeln. Nach dem
  //    ANSI-Strip kommen die Wörter oft ZUSAMMENGEKLEBT an ("❯1.Yes"), mit
  //    echten Leerzeichen ("❯ 1. Yes, allow once") oder mit Klammer ("1)").
  const tail = lines.slice(-12);
  const options: Array<{ n: number; text: string }> = [];
  for (const raw of tail) {
    const m = /^\s*(?:❯\s*)?([1-9])[.)]\s*(\S.*)$/.exec(raw.trim());
    if (m) options.push({ n: Number(m[1]), text: m[2].trim() });
  }

  if (options.length > 0) {
    // Prompt-Chrome muss sichtbar sein (Auswahl-Cursor ❯ oder der
    // Esc-Footer) — eine bloße nummerierte Aufzählung im Fließtext ist keine
    // wartende Box.
    const hasChrome = tail.some(l => /❯/.test(l) || /Esc\s*to\s*cancel/i.test(l));
    // Bei mehreren "1."-Zeilen im Tail (Prosa-Aufzählung ÜBER der Box) zählt
    // die LETZTE — die wartende Box ist immer der jüngste nummerierte Block.
    const firsts = options.filter(o => o.n === 1);
    const first = firsts.length > 0 ? firsts[firsts.length - 1] : undefined;
    // Ja-artige Option 1 = echter Berechtigungs-Prompt (Enter nimmt den
    // vorausgewählten Default). Alles andere ist eine inhaltliche
    // Auswahlfrage — die beantwortet der Nutzer im App-Dialog, nie wir.
    const yesish = !!first && /^(yes|ja|allow|approve|proceed|continue)\b/i.test(first.text)
      // ANSI-geklebt: "Yes,andalwaysallow…" hat kein Wortende nach "Yes" —
      // Komma/Großbuchstabe direkt nach dem Ja-Wort zählt auch.
      || (!!first && /^(yes|ja|allow|approve)[,A-Z]/i.test(first.text));
    return yesish && hasChrome ? '\r' : null;
  }

  // Keine Optionsliste, kein end-anchored y/N: kein Beweis für ein wartendes
  // Ja/Nein. Nur melden — nie drücken.
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

