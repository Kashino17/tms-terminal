// Detects interactive prompts in PTY output (Claude Code, Codex, Gemini CLI, generic shells).
// Strategy: accumulate recent output → wait for silence → run pattern check → notify + retry.

const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

// Reviewed: patterns short-circuit on first match; ReDoS risk is acceptable given bounded input.
const PATTERNS = [
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

  watch(sessionId: string, onPrompt: (snippet: string) => void): void {
    this.callbacks.set(sessionId, onPrompt);
  }

  feed(sessionId: string, data: string): void {
    // New output → cancel pending retry (prompt was answered or new activity started)
    const retry = this.retryTimers.get(sessionId);
    if (retry) { clearTimeout(retry); this.retryTimers.delete(sessionId); }

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
      this._check(sessionId, 0);
    }, SILENCE_MS);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  unwatch(sessionId: string): void {
    this.callbacks.delete(sessionId);
    this.buffers.delete(sessionId);
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

    if (!PATTERNS.some((p) => p.test(tail))) return;

    // Use last non-empty line as the notification body
    const lastLine = tail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? 'Waiting for input';

    this.callbacks.get(sessionId)?.(lastLine);

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
