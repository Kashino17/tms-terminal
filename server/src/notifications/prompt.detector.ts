// Detects interactive prompts AND AI-tool-finished events in PTY output.
//
// Guards against false positives:
// - Startup grace period: ignore first STARTUP_GRACE_MS after watch()
// - AI detection requires strong signals (not just bare keyword mentions)
// - AI-finished requires minimum output volume since AI was detected
// - Prompt patterns are specific (no generic "ends with ?" matching)
// - Reduced retry count (2) to avoid notification spam
// - AI detection expires after 10 min without resolution

const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

// ── Interactive Prompt Patterns ──────────────────────────────────────────────
// ONLY match when the terminal is genuinely waiting for user input.
// Generic "?" at end of line is intentionally excluded — it matches help output, URLs, etc.
const PROMPT_PATTERNS = [
  // Y/N confirmations (explicit bracket/paren format)
  /\[y\/n\]/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,
  /press enter to continue/i,

  // Question phrases with clear intent
  /do you want (me )?to/i,
  /would you like to/i,
  /do you want to proceed/i,

  // Action confirmations (phrase + trailing ?)
  /continue\?\s*$/im,
  /proceed\?\s*$/im,
  /confirm\?\s*$/im,
  /approve\?\s*$/im,

  // ── Claude Code ──
  /allow (this action|bash|command|running|tool|edit|execution)/i,
  /dangerous command/i,
  /apply (this )?edit\?/i,

  // ── Codex (OpenAI) ──
  /apply (change|patch|diff)\?/i,
  /run (this )?command\?/i,

  // ── Gemini CLI ──
  /execute (this )?command/i,
  /allow execution of/i,
  /waiting for user confirmation/i,

  // inquirer-style: "Question? ›" or "Question? [choices]"
  /\?\s*(›|\[|\()/,
];

// ── AI Tool Detection ────────────────────────────────────────────────────────
// Strong signals ONLY. Bare keywords like "claude" or spinner chars are excluded
// because they fire on `pip install anthropic`, Starship prompts, npm spinners, etc.
const AI_ACTIVE_PATTERNS = [
  // Claude Code UI
  /╭──.*claude/i,                 // Box header with "claude"
  /tool_use/i,                    // Tool use indicator
  /allow (this action|bash|command|running|tool|edit|execution)/i,

  // Codex UI
  /codex\s*>\s/i,                 // Codex prompt marker
  /apply (change|patch|diff)\?/i,

  // Gemini CLI UI
  /waiting for user confirmation/i,
  /gemini\s*>\s/i,

  // Strong contextual signals
  /Thinking\.\.\./,              // Case-sensitive "Thinking..." (AI progress)
];

// ── Shell Prompt Return ──────────────────────────────────────────────────────
// Indicates the shell is idle. Used ONLY to detect AI-tool exit.
// The old /[%$#>]\s*$/m matched after EVERY command — removed.
const SHELL_PROMPT_PATTERNS = [
  /\w+@[\w.-]+[\s:~][^\n]*[%$#]\s*$/m,   // user@host:~/path$
  /PS [A-Z]:\\.*>\s*$/m,                   // PowerShell
  /[A-Z]:\\[^>\n]*>\s*$/m,                 // CMD
  /❯\s*$/m,                               // Starship
  /➜\s+\S/m,                              // Oh-My-Zsh
  /^\$\s*$/m,                              // Bare $
];

// ── Timing & Limits ──────────────────────────────────────────────────────────
const SILENCE_MS       = 2500;   // Silence before checking (was 1200 — too fast)
const RETRY_MS         = 5000;   // Retry interval for active prompts (was 3000)
const MAX_RETRIES      = 2;      // Max retries per prompt (was 8!)
const SCAN_TAIL        = 400;
const BUFFER_MAX       = 800;
const STARTUP_GRACE_MS = 5000;   // Ignore output for first 5s after watch()
const MIN_AI_OUTPUT    = 1500;   // Min chars since AI detected to trigger "finished"
const AI_EXPIRE_MS     = 10 * 60 * 1000; // AI detection expires after 10 min

export class PromptDetector {
  private buffers        = new Map<string, string>();
  private timers         = new Map<string, NodeJS.Timeout>();
  private retryTimers    = new Map<string, NodeJS.Timeout>();
  private callbacks      = new Map<string, (snippet: string) => void>();
  private aiActive       = new Map<string, boolean>();
  private aiDetectedAt   = new Map<string, number>();
  private outputLen      = new Map<string, number>();
  private aiOutputStart  = new Map<string, number>();
  private watchedAt      = new Map<string, number>();

  watch(sessionId: string, onPrompt: (snippet: string) => void): void {
    this.callbacks.set(sessionId, onPrompt);
    this.watchedAt.set(sessionId, Date.now());
    // Clear stale state from previous watch
    this.buffers.delete(sessionId);
    this.aiActive.delete(sessionId);
    this.aiDetectedAt.delete(sessionId);
    this.outputLen.delete(sessionId);
    this.aiOutputStart.delete(sessionId);
  }

  feed(sessionId: string, data: string): void {
    // Cancel pending retry (new output = prompt was answered or new activity)
    const retry = this.retryTimers.get(sessionId);
    if (retry) { clearTimeout(retry); this.retryTimers.delete(sessionId); }

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

    // Restart silence timer
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this._check(sessionId, 0);
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
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); }
    const r = this.retryTimers.get(sessionId);
    if (r) { clearTimeout(r); this.retryTimers.delete(sessionId); }
  }

  private _check(sessionId: string, retryCount: number): void {
    // ── Guard: startup grace period ──
    const startedAt = this.watchedAt.get(sessionId) ?? 0;
    if (Date.now() - startedAt < STARTUP_GRACE_MS) {
      return; // Ignore — shell just started, MOTD/prompt output is expected
    }

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

    if (shellReturned) {
      console.log(`[PromptDetector] AI FINISHED in ${sessionId.slice(0, 8)} (${outputSinceAi} chars output)`);
      this.aiActive.set(sessionId, false);
      this.outputLen.set(sessionId, 0);
      this.aiOutputStart.delete(sessionId);
      this.aiDetectedAt.delete(sessionId);
    } else if (matched) {
      console.log(`[PromptDetector] PROMPT in ${sessionId.slice(0, 8)}: ${matched} (retry=${retryCount})`);
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

    this.callbacks.get(sessionId)?.(snippet);

    // Retry ONLY for interactive prompts (not AI-finished), with reduced count
    if (shellReturned) return;
    if (retryCount < MAX_RETRIES) {
      const rt = setTimeout(() => {
        this.retryTimers.delete(sessionId);
        this._check(sessionId, retryCount + 1);
      }, RETRY_MS);
      rt.unref();
      this.retryTimers.set(sessionId, rt);
    }
  }
}

export const promptDetector = new PromptDetector();
