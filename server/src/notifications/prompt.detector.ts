// Detects interactive prompts AND AI-tool-finished events in PTY output.
//
// Design goals:
// - Fast response: match on every feed, not just on silence (Claude Code spinners
//   reset a silence-only timer forever).
// - Robust against dup-fires: buffer-hash cooldown after each successful match.
// - Minimal false positives: strict patterns, AI detection requires strong signals.

import { stripStatusFooter } from '../websocket/approval.util';

const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

// ── Interactive Prompt Patterns ──────────────────────────────────────────────
const PROMPT_PATTERNS = [
  // Y/N confirmations
  /\[y\/n\]/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,
  /\(y\/n\)/i,
  /press enter to continue/i,
  /enter to continue/i,
  /hit enter/i,

  // Question phrases with clear intent
  /do you want (me )?to/i,
  /would you like to/i,
  /do you want to proceed/i,
  /are you sure/i,
  /type yes to continue/i,
  /is this ok\??/i,

  // Action confirmations (phrase + trailing ?)
  /continue\?\s*$/im,
  /proceed\?\s*$/im,
  /confirm\?\s*$/im,
  /approve\?\s*$/im,
  /overwrite\?\s*$/im,
  /replace\?\s*$/im,
  /install\?\s*$/im,

  // ── Claude Code ──
  /allow (this action|bash|command|running|tool|edit|execution)/i,
  /dangerous command/i,
  /apply (this )?edit\?/i,
  /Yes,?\s*allow/i,
  /Allow\s*once/i,

  // ── Codex (OpenAI) ──
  /apply (change|patch|diff)\?/i,
  /run (this )?command\?/i,

  // ── Gemini CLI ──
  /execute (this )?command/i,
  /allow execution of/i,
  /waiting for user confirmation/i,

  // ── npm / yarn / pnpm ──
  /ok to proceed/i,
  /install anyway\?/i,
  /need to install/i,

  // ── pip ──
  /would you like to install/i,

  // ── git ──
  /are you sure you want to/i,

  // ── docker ──
  /are you sure you want to remove/i,

  // inquirer-style: "Question? ›" or "Question? [choices]"
  /\?\s*(›|\[|\()/,
];

/**
 * Muster, die NUR eine echte, interaktive Prompt-Box zeichnet — Auswahlpfeil,
 * nummerierte Optionen, Abbruch-Hinweis, Pfeiltasten-Legende. Eine KI schreibt
 * so etwas nicht im Fließtext. Nur diese dürfen irgendwo im Ausgabe-Schwanz
 * stehen; die Box ist ja mehrzeilig und die Frage steht oben in ihr.
 *
 * (Die Optionswörter treffen ANSI-verklebt ein — "1.Yes", "Esctocancel" —
 *  deshalb überall \s* statt \s+.)
 */
const BOX_PATTERNS = [
  /❯\s*\d\.?\s*\w/,
  /\d\.?\s*Yes[\s,]/i,
  /Esc\s*to\s*cancel/i,
  /\(Use\s*arrow\s*keys\)/i,
  /↑↓[^\n]*(select|choose|wählen)/i,
  /\[Enter\]\s*(to\s*)?(confirm|accept|continue)/i,
  /allow\s*all\s*edits/i,
];

// ── AI Tool Detection ────────────────────────────────────────────────────────
const AI_ACTIVE_PATTERNS = [
  /╭──.*claude/i,
  /tool_use/i,
  /allow (this action|bash|command|running|tool|edit|execution)/i,
  /codex\s*>\s/i,
  /apply (change|patch|diff)\?/i,
  /waiting for user confirmation/i,
  /gemini\s*>\s/i,
  /Thinking\.\.\./,
];

// ── Shell Prompt Return ──────────────────────────────────────────────────────
const SHELL_PROMPT_PATTERNS = [
  /\w+@[\w.-]+[\s:~][^\n]*[%$#]\s*$/m,
  /PS [A-Z]:\\.*>\s*$/m,
  /[A-Z]:\\[^>\n]*>\s*$/m,
  /❯\s*$/m,
  /➜\s+\S/m,
  /^\$\s*$/m,
];

// ── Timing & Limits ──────────────────────────────────────────────────────────
const SILENCE_MS        = 1200;   // Fallback — immediate check runs on every feed
const IMMEDIATE_DEBOUNCE_MS = 50; // Coalesce back-to-back feeds into single check
const SCAN_TAIL         = 1200;   // Up from 600 — Claude Code boxes are often long
const BUFFER_MAX        = 3000;   // Up from 1200 — fits longer code-context boxes
const STARTUP_GRACE_MS  = 1500;   // Down from 5000 — don't miss the first prompt
const MIN_AI_OUTPUT     = 800;
const AI_EXPIRE_MS      = 10 * 60 * 1000;
const DEDUP_COOLDOWN_MS = 2000;   // After firing, same tail-hash is ignored for this long
// Refractory window after any fire. Prevents a double-fire while the just-approved
// box tears down (its residual text can momentarily still match with a drifting hash),
// AND lets a genuinely NEW prompt fire as soon as it elapses — even if the cleaned
// window never stopped matching in between (the back-to-back agent/workflow case).
const MIN_REFIRE_MS     = 400;
// Fast-path window: rolling buffer of POST-ANSI-STRIP text used by the
// per-chunk detector. Decoupled from BUFFER_MAX (which is raw bytes incl. ANSI)
// so that heavy TUI redraws can't push the original prompt question out before
// we get a chance to match it. Large boxes (multi-hunk Edit diffs, long Bash
// commands, MCP tool args) can exceed 1200 cleaned chars in one frame, so keep a
// generous window — and the per-chunk match below catches a box rendered in a
// single fat frame regardless of window size.
const FAST_WINDOW       = 4000;

/** Wie viele Zeilen am Ende der Ausgabe als "hier wartet etwas" gelten. Eine
 *  Claude-Berechtigungsbox ist mehrzeilig (Frage, Optionen, "Esc to cancel"),
 *  darum nicht nur die letzte Zeile — aber weit genug weg von Fließtext, der
 *  weiter oben zufällig ein Bestätigungsmuster erwähnt. */
const PROMPT_TAIL_LINES = 6;

function lastLines(s: string, n: number = PROMPT_TAIL_LINES): string {
  // Leerzeilen am Ende (der Cursor steht schon auf der nächsten Zeile) zählen
  // nicht mit — sonst schöbe eine einzige davon den Prompt aus dem Fenster.
  const lines = s.split('\n');
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).join('\n');
}

/**
 * Wartet am Ende dieser Ausgabe wirklich ein Prompt?
 *
 * Der Grund für die Strenge: Eine KI SCHREIBT über Prompts. Sie erklärt, dass
 * ein Befehl mit einem Ja/Nein-Muster nachfragt, oder ein Commit-Text enthält
 * es. Früher genügte das Muster IRGENDWO im Fenster — der Server hielt die
 * Antwort der KI für eine Rückfrage und tippte eine Bestätigung in die laufende
 * Sitzung. Deshalb:
 *
 *   • Box-Chrome (Auswahlpfeil, "Esc to cancel", …) darf im ganzen Schwanz
 *     stehen — eine Box ist mehrzeilig, und nur eine echte Box zeichnet das.
 *   • Alles andere (Phrasen, Ja/Nein-Klammern) muss auf der LETZTEN Zeile
 *     stehen. Dort blinkt der Cursor. Steht danach noch Text, wartet nichts.
 */
function matchPrompt(text: string): RegExp | undefined {
  if (!text) return undefined;
  // Claude Code rendert seine Task-Liste UNTER der Box — sie ist Status-Chrome,
  // kein Inhalt, und darf den Prompt nicht aus dem Zeilenfenster schieben.
  const stripped = stripStatusFooter(text.split('\n')).join('\n');
  const tail = lastLines(stripped);
  const box = BOX_PATTERNS.find((p) => p.test(tail));
  if (box) return box;
  const lastLine = lastLines(stripped, 1);
  return lastLine.trim() ? PROMPT_PATTERNS.find((p) => p.test(lastLine)) : undefined;
}

function hashTail(s: string): string {
  // Cheap non-crypto hash — enough to detect "same text" vs "different text"
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

/** Prompt callback. `context.window` is the cleaned text the match was found in,
 *  so the caller can decide which keystroke approves it (e.g. Enter vs 'y'). */
export type PromptCallback = (snippet: string, context?: { window: string }) => void;

export class PromptDetector {
  private buffers        = new Map<string, string>();
  private timers         = new Map<string, NodeJS.Timeout>();
  private immediateTimers = new Map<string, NodeJS.Timeout>();
  private callbacks      = new Map<string, PromptCallback>();
  private aiActive       = new Map<string, boolean>();
  private aiDetectedAt   = new Map<string, number>();
  private outputLen      = new Map<string, number>();
  private aiOutputStart  = new Map<string, number>();
  private watchedAt      = new Map<string, number>();
  private lastFiredHash  = new Map<string, string>();
  private lastFiredAt    = new Map<string, number>();
  // Fast-path state: rolling clean-text window
  private fastTail       = new Map<string, string>();

  /** Injectable clock (defaults to wall time). Lets tests drive time deterministically. */
  constructor(private now: () => number = () => Date.now()) {}

  watch(sessionId: string, onPrompt: PromptCallback): void {
    this.callbacks.set(sessionId, onPrompt);
    if (!this.watchedAt.has(sessionId)) {
      this.watchedAt.set(sessionId, this.now());
    }
  }

  feed(sessionId: string, data: string): void {
    // Track output volume
    const newLen = (this.outputLen.get(sessionId) ?? 0) + data.length;
    this.outputLen.set(sessionId, newLen);

    // Detect AI tool activity (strong signals only)
    const cleanChunk = data.replace(ANSI_STRIP, '');
    if (!this.aiActive.get(sessionId) && AI_ACTIVE_PATTERNS.some(p => p.test(cleanChunk))) {
      console.log(`[PromptDetector] AI tool detected in ${sessionId.slice(0, 8)}`);
      this.aiActive.set(sessionId, true);
      this.aiDetectedAt.set(sessionId, this.now());
      this.aiOutputStart.set(sessionId, newLen);
    }

    // Rolling buffer (raw bytes — includes ANSI sequences)
    const prev     = this.buffers.get(sessionId) ?? '';
    const combined = prev + data;
    this.buffers.set(
      sessionId,
      combined.length > BUFFER_MAX ? combined.slice(combined.length - BUFFER_MAX) : combined,
    );

    // ── FAST-PATH: per-chunk prompt detection ──
    // TUI apps (Claude Code, Codex, Gemini) redraw their spinner/status line
    // many times per second using cursor-up + clear-line sequences. After
    // ANSI stripping these are tiny, but the RAW byte count fills BUFFER_MAX
    // fast — pushing the original prompt question out before _check() ever
    // sees it. So we maintain a separate rolling window of CLEANED text and
    // match prompt patterns on every feed, firing on the rising edge.
    if (cleanChunk) {
      const startedAt = this.watchedAt.get(sessionId) ?? 0;
      if (this.now() - startedAt >= STARTUP_GRACE_MS) {
        const prevFast = this.fastTail.get(sessionId) ?? '';
        const fastWindow = (prevFast + cleanChunk).slice(-FAST_WINDOW);
        this.fastTail.set(sessionId, fastWindow);

        // Match the rolling window OR this fresh chunk on its own. A freshly
        // rendered box matches even when a long preceding redraw pushed the
        // window tail (slice(-FAST_WINDOW)) into the middle of a diff/command.
        //
        // Aber nur im SCHWANZ der Ausgabe: ein wartender Prompt ist immer das
        // Letzte, was zu sehen ist. Erwähnt eine KI mitten in ihrer Antwort ein
        // Bestätigungsmuster (oder ein Commit-/Log-Text enthält es), ist das
        // kein Prompt — und wurde früher trotzdem als einer gemeldet.
        const matched = matchPrompt(fastWindow) ?? matchPrompt(cleanChunk);
        if (matched && this._shouldFire(sessionId, hashTail(fastWindow))) {
          console.log(`[PromptDetector] PROMPT (fast) in ${sessionId.slice(0, 8)}: ${matched}`);
          const snippet = this._extractSnippet(fastWindow);
          this.lastFiredHash.set(sessionId, hashTail(fastWindow));
          this.lastFiredAt.set(sessionId, this.now());
          this.callbacks.get(sessionId)?.(snippet, { window: fastWindow });
        }
      }
    }

    // Immediate check (debounced by 50ms to coalesce rapid feeds into one check).
    // This is the primary detection path — spinner output no longer blocks matching.
    const existingImmediate = this.immediateTimers.get(sessionId);
    if (existingImmediate) clearTimeout(existingImmediate);
    const imm = setTimeout(() => {
      this.immediateTimers.delete(sessionId);
      this._check(sessionId);
    }, IMMEDIATE_DEBOUNCE_MS);
    imm.unref();
    this.immediateTimers.set(sessionId, imm);

    // Silence-based fallback (kept for edge cases where immediate misses)
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this._check(sessionId);
    }, SILENCE_MS);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  /** Re-bind the callback after a client reattach WITHOUT resetting the startup
   *  grace or dedup state. unwatch()+watch() would impose a fresh 1.5s blind
   *  window on every reconnect (common over mobile/Tailscale), dropping any
   *  prompt that lands in it. Only the stale pending timers and the callback are
   *  refreshed; the scrollback replayed on reattach is naturally deduped because
   *  lastFiredHash is preserved. */
  rewatch(sessionId: string, onPrompt: PromptCallback): void {
    this.callbacks.set(sessionId, onPrompt);
    // If the detector wasn't already tracking this session (e.g. server
    // restarted while the client was away), seed watchedAt in the past so grace
    // is already elapsed rather than starting a fresh blind window.
    if (!this.watchedAt.has(sessionId)) {
      this.watchedAt.set(sessionId, this.now() - STARTUP_GRACE_MS);
    }
    // Drop only the stale pending check timers — keep buffers / fastTail / dedup.
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); }
    const imm = this.immediateTimers.get(sessionId);
    if (imm) { clearTimeout(imm); this.immediateTimers.delete(sessionId); }
  }

  unwatch(sessionId: string): void {
    this.callbacks.delete(sessionId);
    this.buffers.delete(sessionId);
    this.aiActive.delete(sessionId);
    this.aiDetectedAt.delete(sessionId);
    this.outputLen.delete(sessionId);
    this.aiOutputStart.delete(sessionId);
    this.watchedAt.delete(sessionId);
    this.lastFiredHash.delete(sessionId);
    this.lastFiredAt.delete(sessionId);
    this.fastTail.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); }
    const imm = this.immediateTimers.get(sessionId);
    if (imm) { clearTimeout(imm); this.immediateTimers.delete(sessionId); }
  }

  /** Called after an auto-approve Enter is dispatched.
   *  The fire already recorded lastFiredHash for dedup; we only refresh the
   *  refractory timer from the moment of approval so the box tearing down AFTER
   *  Enter (whose residual can momentarily still match) can't trigger a re-fire.
   *  A genuinely new prompt fires once MIN_REFIRE_MS elapses. */
  /** Hash of the current cleaned tail window. The auto-approve retry uses this
   *  to verify the prompt is still sitting unchanged on screen: any new output
   *  (answer echo, box teardown, fresh content) changes the hash. */
  tailHash(sessionId: string): string {
    return hashTail(this.fastTail.get(sessionId) ?? '');
  }

  noteApproved(sessionId: string): void {
    this.lastFiredAt.set(sessionId, this.now());
  }

  /** Dedup gate shared by the fast-path and the _check fallback.
   *  Fires only for a DISTINCT prompt (cleaned-window hash changed) and only
   *  once the post-fire refractory window has elapsed. */
  private _shouldFire(sessionId: string, windowHash: string): boolean {
    const lastHash  = this.lastFiredHash.get(sessionId);
    const sinceFire = this.now() - (this.lastFiredAt.get(sessionId) ?? -Infinity);
    return windowHash !== lastHash && sinceFire >= MIN_REFIRE_MS;
  }

  private _check(sessionId: string): void {
    // ── Guard: startup grace period ──
    const startedAt = this.watchedAt.get(sessionId) ?? 0;
    if (this.now() - startedAt < STARTUP_GRACE_MS) return;

    // ── Guard: expire stale AI detection ──
    const aiDetTime = this.aiDetectedAt.get(sessionId) ?? 0;
    if (this.aiActive.get(sessionId) && aiDetTime > 0 && this.now() - aiDetTime > AI_EXPIRE_MS) {
      this.aiActive.set(sessionId, false);
      this.aiOutputStart.delete(sessionId);
      this.aiDetectedAt.delete(sessionId);
    }

    const raw   = this.buffers.get(sessionId) ?? '';
    const clean = raw.replace(ANSI_STRIP, '');
    const tail  = clean.slice(-SCAN_TAIL);
    const tailHash = hashTail(tail);
    // Dedup prompts on the SAME window the fast-path hashes, so the two paths
    // agree on "same screen" even though they slice different lengths (a large
    // box would otherwise hash differently here and get re-notified).
    const promptSig = hashTail(this.fastTail.get(sessionId) ?? tail);

    // Check 1: Interactive prompt patterns. Shares the fast-path's dedup gate
    // (_shouldFire) so the silence fallback never double-fires a prompt the
    // fast-path already handled, and never re-fires as the tail hash drifts.
    const promptMatch = matchPrompt(tail);
    const matched = promptMatch && this._shouldFire(sessionId, promptSig) ? promptMatch : undefined;

    // Check 2: AI tool finished (active + enough output + shell prompt returned)
    const aiWasActive    = this.aiActive.get(sessionId) ?? false;
    const outputSinceAi  = (this.outputLen.get(sessionId) ?? 0) - (this.aiOutputStart.get(sessionId) ?? 0);
    const hasEnoughOutput = outputSinceAi >= MIN_AI_OUTPUT;
    const lastHash  = this.lastFiredHash.get(sessionId);
    const lastFired = this.lastFiredAt.get(sessionId) ?? 0;
    const shellReturned  = aiWasActive && hasEnoughOutput && SHELL_PROMPT_PATTERNS.some(p => p.test(tail))
      && !(lastHash === tailHash && this.now() - lastFired < DEDUP_COOLDOWN_MS);

    if (!matched && !shellReturned) return;

    if (shellReturned) {
      console.log(`[PromptDetector] AI FINISHED in ${sessionId.slice(0, 8)} (${outputSinceAi} chars)`);
      this.aiActive.set(sessionId, false);
      this.outputLen.set(sessionId, 0);
      this.aiOutputStart.delete(sessionId);
      this.aiDetectedAt.delete(sessionId);
    } else if (matched) {
      console.log(`[PromptDetector] PROMPT in ${sessionId.slice(0, 8)}: ${matched}`);
    }

    const body = this._extractSnippet(tail) || (shellReturned ? 'Task abgeschlossen' : 'Eingabe erforderlich');
    const snippet = shellReturned ? `✅${body}` : body;

    this.lastFiredHash.set(sessionId, shellReturned ? tailHash : promptSig);
    this.lastFiredAt.set(sessionId, this.now());

    this.callbacks.get(sessionId)?.(snippet, { window: tail });
  }

  /** Extract a short, human-readable body from cleaned terminal text. */
  private _extractSnippet(text: string): string {
    // Task-Listen-Footer weglassen — die Notification soll die FRAGE zeigen,
    // nicht die Todo-Zeilen, die Claude Code darunter rendert.
    const lines = stripStatusFooter(text.split('\n'))
      .map((l) => l.replace(/\r/g, '').trim())
      .filter((l) => {
        if (!l || l.length < 3) return false;
        if (/^[%$#>❯➜]\s*$/.test(l)) return false;
        if (/\w+@[\w.-]+.*[%$#]/.test(l)) return false;
        if (/^\[>[0-9]/.test(l)) return false;
        if (l.replace(/[─━═╭╮╰╯│┃●◆▶►⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]/g, '').length < 2) return false;
        return true;
      });
    return lines.slice(-3).join(' ').slice(0, 150);
  }
}

export const promptDetector = new PromptDetector();
