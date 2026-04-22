// Detects interactive prompts AND AI-tool-finished events in PTY output.
//
// Design goals:
// - Fast response: match on every feed, not just on silence (Claude Code spinners
//   reset a silence-only timer forever).
// - Robust against dup-fires: buffer-hash cooldown after each successful match.
// - Minimal false positives: strict patterns, AI detection requires strong signals.

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

  // ── TUI patterns (ANSI stripping removes spaces in Claude Code's rendered output) ──
  /Esc\s*to\s*cancel/i,
  /Esctocancel/i,
  /1\.?\s*Yes/,
  /allowalledits/i,
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

function hashTail(s: string): string {
  // Cheap non-crypto hash — enough to detect "same text" vs "different text"
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

export class PromptDetector {
  private buffers        = new Map<string, string>();
  private timers         = new Map<string, NodeJS.Timeout>();
  private immediateTimers = new Map<string, NodeJS.Timeout>();
  private callbacks      = new Map<string, (snippet: string) => void>();
  private aiActive       = new Map<string, boolean>();
  private aiDetectedAt   = new Map<string, number>();
  private outputLen      = new Map<string, number>();
  private aiOutputStart  = new Map<string, number>();
  private watchedAt      = new Map<string, number>();
  private lastFiredHash  = new Map<string, string>();
  private lastFiredAt    = new Map<string, number>();

  watch(sessionId: string, onPrompt: (snippet: string) => void): void {
    this.callbacks.set(sessionId, onPrompt);
    if (!this.watchedAt.has(sessionId)) {
      this.watchedAt.set(sessionId, Date.now());
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
      this.aiDetectedAt.set(sessionId, Date.now());
      this.aiOutputStart.set(sessionId, newLen);
    }

    // Rolling buffer
    const prev     = this.buffers.get(sessionId) ?? '';
    const combined = prev + data;
    this.buffers.set(
      sessionId,
      combined.length > BUFFER_MAX ? combined.slice(combined.length - BUFFER_MAX) : combined,
    );

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
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); }
    const imm = this.immediateTimers.get(sessionId);
    if (imm) { clearTimeout(imm); this.immediateTimers.delete(sessionId); }
  }

  /** Called after an auto-approve Enter is dispatched — forces a fresh match cycle. */
  noteApproved(sessionId: string): void {
    // Clear buffer so residual text from before Enter can't re-match.
    this.buffers.set(sessionId, '');
    this.lastFiredHash.delete(sessionId);
    this.lastFiredAt.delete(sessionId);
  }

  private _check(sessionId: string): void {
    // ── Guard: startup grace period ──
    const startedAt = this.watchedAt.get(sessionId) ?? 0;
    if (Date.now() - startedAt < STARTUP_GRACE_MS) return;

    // ── Guard: expire stale AI detection ──
    const aiDetTime = this.aiDetectedAt.get(sessionId) ?? 0;
    if (this.aiActive.get(sessionId) && aiDetTime > 0 && Date.now() - aiDetTime > AI_EXPIRE_MS) {
      this.aiActive.set(sessionId, false);
      this.aiOutputStart.delete(sessionId);
      this.aiDetectedAt.delete(sessionId);
    }

    const raw   = this.buffers.get(sessionId) ?? '';
    const clean = raw.replace(ANSI_STRIP, '');
    const tail  = clean.slice(-SCAN_TAIL);

    // Check 1: Interactive prompt patterns
    const matched = PROMPT_PATTERNS.find((p) => p.test(tail));

    // Check 2: AI tool finished (active + enough output + shell prompt returned)
    const aiWasActive    = this.aiActive.get(sessionId) ?? false;
    const outputSinceAi  = (this.outputLen.get(sessionId) ?? 0) - (this.aiOutputStart.get(sessionId) ?? 0);
    const hasEnoughOutput = outputSinceAi >= MIN_AI_OUTPUT;
    const shellReturned   = aiWasActive && hasEnoughOutput && SHELL_PROMPT_PATTERNS.some(p => p.test(tail));

    if (!matched && !shellReturned) return;

    // ── Dedup: don't re-fire on the same tail within cooldown window ──
    const tailHash = hashTail(tail);
    const lastHash = this.lastFiredHash.get(sessionId);
    const lastFired = this.lastFiredAt.get(sessionId) ?? 0;
    if (lastHash === tailHash && Date.now() - lastFired < DEDUP_COOLDOWN_MS) {
      return;
    }

    if (shellReturned) {
      console.log(`[PromptDetector] AI FINISHED in ${sessionId.slice(0, 8)} (${outputSinceAi} chars)`);
      this.aiActive.set(sessionId, false);
      this.outputLen.set(sessionId, 0);
      this.aiOutputStart.delete(sessionId);
      this.aiDetectedAt.delete(sessionId);
    } else if (matched) {
      console.log(`[PromptDetector] PROMPT in ${sessionId.slice(0, 8)}: ${matched}`);
    }

    // Extract meaningful snippet for notification body
    const lines = tail
      .split('\n')
      .map((l) => l.replace(/\r/g, '').trim())
      .filter((l) => {
        if (!l || l.length < 3) return false;
        if (/^[%$#>❯➜]\s*$/.test(l)) return false;
        if (/\w+@[\w.-]+.*[%$#]/.test(l)) return false;
        if (/^\[>[0-9]/.test(l)) return false;
        if (l.replace(/[─━═╭╮╰╯│┃●◆▶►⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]/g, '').length < 2) return false;
        return true;
      });

    const lastLines = lines.slice(-3).join(' ').slice(0, 150);
    const body = lastLines || (shellReturned ? 'Task abgeschlossen' : 'Eingabe erforderlich');
    const snippet = shellReturned ? `✅${body}` : body;

    this.lastFiredHash.set(sessionId, tailHash);
    this.lastFiredAt.set(sessionId, Date.now());

    this.callbacks.get(sessionId)?.(snippet);
  }
}

export const promptDetector = new PromptDetector();
