// Detects interactive prompts AND AI-tool-finished events in PTY output.
// Strategy: accumulate recent output → wait for silence → run pattern check → notify + retry.
// Also tracks when an AI tool (Claude, Codex, Gemini) was active and shell prompt returns.

const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

// Reviewed: patterns short-circuit on first match; ReDoS risk is acceptable given bounded input.
const PROMPT_PATTERNS = [
  // ── Generic y/n confirmations ──────────────────────────────────────────────
  /\[y\/n\]/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,
  /press enter to continue/i,

  // ── Question phrases ───────────────────────────────────────────────────────
  /do you want (me )?to/i,
  /do you want to proceed/i,
  /would you like/i,
  /shall i /i,
  /continue\?/i,
  /proceed\?/i,
  /confirm\?/i,
  /approve\?/i,

  // ── Claude Code specific ───────────────────────────────────────────────────
  /allow (this action|bash|command|running|tool|edit|execution)/i,
  /dangerous command/i,
  /apply (this )?edit/i,

  // ── Codex (OpenAI) specific ────────────────────────────────────────────────
  /apply (change|patch|diff)\?/i,
  /run (this )?command\?/i,

  // ── Gemini CLI specific ────────────────────────────────────────────────────
  /execute (this )?command/i,
  /allow execution of/i,
  /waiting for user confirmation/i,
  /execution of:/i,

  // ── inquirer-style prompt cursor (line ends with "? " then [/( )
  /\?\s*(›|\[|\()/,
  /\?\s*$/m,
];

// Patterns that indicate an AI tool is running
const AI_ACTIVE_PATTERNS = [
  /\bclaude\b/i,
  /\bcodex\b/i,
  /\bgemini\b/i,
  /\banthropic\b/i,
  /\bopenai\b/i,
  /\bopus\b/i,
  /\bsonnet\b/i,
  /\bhaiku\b/i,
  /╭─/,              // Claude Code box drawing
  /tool_use/i,       // Claude Code tool use indicator
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Spinner characters (AI thinking)
];

// Shell prompt patterns — indicates the AI tool has exited and control returned to user
const SHELL_PROMPT_PATTERNS = [
  /[%$#>]\s*$/m,                             // Generic: ends with %, $, #, >
  /\w+@[\w.-]+\s+[~\/]\S*\s*[%$#]\s*$/m,    // user@host ~/path %
  /PS [A-Z]:\\.*>\s*$/m,                      // PowerShell: PS C:\path>
  /[A-Z]:\\.*>\s*$/m,                         // CMD: C:\path>
  /❯\s*$/m,                                  // Starship / custom prompts
  /➜\s+/m,                                   // Oh-My-Zsh arrow prompt
];

// Wait this long after last output before checking
const SILENCE_MS  = 1200;
// While a prompt is still active, re-notify every N ms (handles late enable of auto-approve)
const RETRY_MS    = 3000;
// Max retries per prompt occurrence to avoid infinite loops
const MAX_RETRIES = 8;
// Only scan the last N chars for prompt patterns (ignore historical matches)
const SCAN_TAIL   = 400;
const BUFFER_MAX  = 800;

export class PromptDetector {
  private buffers      = new Map<string, string>();
  private timers       = new Map<string, NodeJS.Timeout>();
  private retryTimers  = new Map<string, NodeJS.Timeout>();
  private callbacks    = new Map<string, (snippet: string) => void>();
  /** Tracks whether an AI tool was recently active in each session */
  private aiActive     = new Map<string, boolean>();
  /** Tracks total output length — used to detect significant output (AI was working) */
  private outputLen    = new Map<string, number>();

  watch(sessionId: string, onPrompt: (snippet: string) => void): void {
    this.callbacks.set(sessionId, onPrompt);
  }

  feed(sessionId: string, data: string): void {
    // New output → cancel pending retry (prompt was answered or new activity started)
    const retry = this.retryTimers.get(sessionId);
    if (retry) { clearTimeout(retry); this.retryTimers.delete(sessionId); }

    // Track total output and AI tool activity
    this.outputLen.set(sessionId, (this.outputLen.get(sessionId) ?? 0) + data.length);
    const cleanChunk = data.replace(ANSI_STRIP, '');
    if (AI_ACTIVE_PATTERNS.some(p => p.test(cleanChunk))) {
      if (!this.aiActive.get(sessionId)) {
        console.log(`[PromptDetector] AI tool detected in session ${sessionId.slice(0,8)}`);
      }
      this.aiActive.set(sessionId, true);
    }

    // Append to rolling buffer
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
      const bufLen = (this.buffers.get(sessionId) ?? '').length;
      console.log(`[PromptDetector] Silence timeout for ${sessionId.slice(0,8)}, buffer=${bufLen} chars`);
      this._check(sessionId, 0);
    }, SILENCE_MS);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  unwatch(sessionId: string): void {
    this.callbacks.delete(sessionId);
    this.buffers.delete(sessionId);
    this.aiActive.delete(sessionId);
    this.outputLen.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); }
    const r = this.retryTimers.get(sessionId);
    if (r) { clearTimeout(r); this.retryTimers.delete(sessionId); }
  }

  private _check(sessionId: string, retryCount: number): void {
    const raw   = this.buffers.get(sessionId) ?? '';
    const clean = raw.replace(ANSI_STRIP, '');

    // Only look at the tail of the buffer — ignore old prompt text from earlier interactions
    const tail = clean.slice(-SCAN_TAIL);

    // Check 1: Interactive prompt patterns (y/n, allow action, etc.)
    const matched = PROMPT_PATTERNS.find((p) => p.test(tail));

    // Check 2: AI tool was active and shell prompt returned (= AI finished)
    const aiWasActive = this.aiActive.get(sessionId) ?? false;
    const shellReturned = aiWasActive && SHELL_PROMPT_PATTERNS.some(p => p.test(tail));

    if (!matched && !shellReturned) {
      // Log tail for debugging
      const lastChars = tail.slice(-120).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      console.log(`[PromptDetector] No match (ai=${aiWasActive}). Tail: ${lastChars}`);
      return;
    }

    if (shellReturned) {
      console.log(`[PromptDetector] AI FINISHED in session ${sessionId.slice(0,8)} — shell prompt returned`);
      // Reset AI active state — we've notified, next time needs fresh AI detection
      this.aiActive.set(sessionId, false);
      this.outputLen.set(sessionId, 0);
    } else {
      console.log(`[PromptDetector] PROMPT MATCH: ${matched} in session ${sessionId.slice(0,8)} (retry=${retryCount})`);
    }

    // Extract last meaningful lines for the notification body
    // Filter out control chars, empty lines, prompt lines, and spinner artifacts
    const lines = tail
      .split('\n')
      .map((l) => l.replace(/\r/g, '').trim())
      .filter((l) => {
        if (!l || l.length < 3) return false;
        // Skip shell prompts
        if (/^[%$#>❯➜]\s*$/.test(l)) return false;
        if (/\w+@[\w.-]+.*[%$#]/.test(l)) return false;
        // Skip xterm control sequences
        if (/^\[>[0-9]/.test(l) || /^\?\s*$/.test(l)) return false;
        // Skip lines that are mostly special chars
        if (l.replace(/[─━═╭╮╰╯│┃●◆▶►⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]/g, '').length < 2) return false;
        return true;
      });

    const lastLines = lines.slice(-3).join(' ').slice(0, 150);
    const body = lastLines || 'Task abgeschlossen';

    const isAiFinished = shellReturned;
    const snippet = isAiFinished ? `✅${body}` : body;

    this.callbacks.get(sessionId)?.(snippet);

    // Only retry for interactive prompts, not for "AI finished" events
    if (shellReturned) return;

    // Schedule retry: re-notify every RETRY_MS so late-enabled auto-approve still fires
    if (retryCount < MAX_RETRIES) {
      const retry = setTimeout(() => {
        this.retryTimers.delete(sessionId);
        this._check(sessionId, retryCount + 1);
      }, RETRY_MS);
      retry.unref();
      this.retryTimers.set(sessionId, retry);
    }
  }
}

export const promptDetector = new PromptDetector();
