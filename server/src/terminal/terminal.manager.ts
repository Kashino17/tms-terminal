import { v4 as uuidv4 } from 'uuid';
import { createPty } from './terminal.factory';
import { TerminalSession, CreateSessionOptions } from './terminal.types';
import { readProcessCwd, readForegroundProcess } from './cwd.utils';
import { logger } from '../utils/logger';
import { config } from '../config';

type OutputCallback = (sessionId: string, data: string) => void;
type CloseCallback = (sessionId: string, exitCode: number) => void;

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — was 4h, halved to release per-session
                                              // resources sooner (PTY procs + reattachBuffers)
                                              // when a mobile client doesn't return.
const REATTACH_BUFFER_MAX = 300_000; // 300 KB — captured while client is away
const OUTPUT_BUFFER_FLUSH_SIZE = 8192; // 8 KB — flush immediately when buffer exceeds this
const MAX_SESSIONS = 50;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private outputCallbacks = new Map<string, OutputCallback>();
  private closeCallbacks = new Map<string, CloseCallback>();
  private outputBuffers = new Map<string, string>();   // output-batching buffer (short-lived)
  private reattachBuffers = new Map<string, string>(); // output captured while detached
  private outputTimers = new Map<string, NodeJS.Timeout>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private batchIntervals = new Map<string, number>();  // per-session adaptive batch interval (ms)
  private attachGen = new Map<string, number>();       // monotonic generation counter — prevents stale detach

  /** Optional callback invoked during detached buffering — allows prompt detector
   *  to keep receiving data for server-side auto-approve and FCM push notifications. */
  public detachFeedCallback: ((sessionId: string, data: string) => void) | null = null;

  /** Get all active PTY pids (for restricting system:kill to managed processes). */
  getManagedPids(): Set<number> {
    const pids = new Set<number>();
    for (const session of this.sessions.values()) {
      pids.add(session.pty.pid);
    }
    return pids;
  }

  /** Get the current attach generation for a session (used by ws.handler to tag detach calls). */
  getAttachGen(sessionId: string): number {
    return this.attachGen.get(sessionId) ?? 0;
  }

  /** Set the adaptive batch interval for a session based on measured RTT. */
  setSessionRtt(sessionId: string, rtt: number): void {
    if (!this.sessions.has(sessionId)) return;
    const interval = Math.max(config.outputBufferMs, Math.min(150, Math.round(rtt * 0.4)));
    this.batchIntervals.set(sessionId, interval);
  }

  createSession(
    options: CreateSessionOptions,
    onOutput: OutputCallback,
    onClose: CloseCallback,
  ): TerminalSession {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum session limit reached (${MAX_SESSIONS}). Close existing sessions first.`);
    }

    const id = uuidv4();
    const pty = createPty(options.cols, options.rows);

    const session: TerminalSession = {
      id,
      pty,
      cols: options.cols,
      rows: options.rows,
      createdAt: new Date(),
    };

    this.outputCallbacks.set(id, onOutput);
    this.closeCallbacks.set(id, onClose);

    pty.onData((data: string) => {
      const existing = this.outputBuffers.get(id) || '';
      const combined = existing + data;
      this.outputBuffers.set(id, combined);

      // Small buffer = likely keystroke echo → flush immediately (no timer delay)
      if (combined.length <= 32) {
        const pendingTimer = this.outputTimers.get(id);
        if (pendingTimer) { clearTimeout(pendingTimer); this.outputTimers.delete(id); }
        this.outputCallbacks.get(id)?.(id, combined);
        this.outputBuffers.delete(id);
        return;
      }

      // Flush immediately if buffer exceeds 8 KB (large outputs like `cat` of a big file)
      if (combined.length >= OUTPUT_BUFFER_FLUSH_SIZE) {
        const pendingTimer = this.outputTimers.get(id);
        if (pendingTimer) { clearTimeout(pendingTimer); this.outputTimers.delete(id); }
        this.outputCallbacks.get(id)?.(id, combined);
        this.outputBuffers.delete(id);
        return;
      }

      // Medium buffer (> 32 bytes, < 8 KB) = bulk output → batch with timer
      if (!this.outputTimers.has(id)) {
        const batchMs = this.batchIntervals.get(id) ?? config.outputBufferMs;
        const timer = setTimeout(() => {
          const buffered = this.outputBuffers.get(id);
          if (buffered) {
            this.outputCallbacks.get(id)?.(id, buffered);
            this.outputBuffers.delete(id);
          }
          this.outputTimers.delete(id);
        }, batchMs);
        this.outputTimers.set(id, timer);
      }
    });

    pty.onExit(({ exitCode }) => {
      const remaining = this.outputBuffers.get(id);
      if (remaining) {
        this.outputCallbacks.get(id)?.(id, remaining);
        this.outputBuffers.delete(id);
      }
      const timer = this.outputTimers.get(id);
      if (timer) { clearTimeout(timer); this.outputTimers.delete(id); }

      logger.info(`Session ${id} exited with code ${exitCode}`);
      this.closeCallbacks.get(id)?.(id, exitCode);
      this._cleanup(id);
    });

    this.sessions.set(id, session);
    logger.success(`Session created: ${id}`);
    return session;
  }

  /** Detach callbacks without killing the PTY — session stays alive.
   *  Captures CWD + foreground process at the moment of detach.
   *  Installs a buffer callback so any PTY output while detached is captured. */
  /** Detach a session. If `expectedGen` is provided and doesn't match the current
   *  attach generation, the detach is stale (a newer reattach already happened) and is skipped. */
  detachSession(sessionId: string, expectedGen?: number): void {
    if (!this.sessions.has(sessionId)) return;
    // If a generation is specified, only proceed if it matches the current one.
    // This prevents an old connection's close handler from overwriting a newer reattach's callbacks.
    const currentGen = this.attachGen.get(sessionId) ?? 0;
    if (expectedGen !== undefined && expectedGen !== currentGen) {
      logger.info(`Stale detach skipped for ${sessionId} (gen ${expectedGen} vs ${currentGen})`);
      return;
    }
    this.closeCallbacks.delete(sessionId);

    // Snapshot CWD and foreground process before the client goes away (async, best-effort)
    const session = this.sessions.get(sessionId)!;
    const pid = session.pty.pid;
    void Promise.all([readProcessCwd(pid), readForegroundProcess(pid)]).then(([cwd, processName]) => {
      if (cwd) session.cwd = cwd;
      if (processName) session.processName = processName;
    });

    // Replace the send-to-client callback with a local buffer + prompt detector feed.
    // The prompt detector must keep receiving data so server-side auto-approve and
    // FCM push notifications continue to work while the client is backgrounded/disconnected.
    this.outputCallbacks.set(sessionId, (_id, data) => {
      const existing = this.reattachBuffers.get(sessionId) || '';
      const combined = existing + data;
      this.reattachBuffers.set(
        sessionId,
        combined.length >= REATTACH_BUFFER_MAX
          ? combined.slice(combined.length - REATTACH_BUFFER_MAX)
          : combined,
      );
      // Keep prompt detector alive for server-side auto-approve + FCM notifications
      this.detachFeedCallback?.(sessionId, data);
    });

    // Start idle timer — kill if nobody reconnects within 4 hours
    const existing = this.idleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      logger.info(`Session ${sessionId} idle timeout — closing`);
      this.closeSession(sessionId);
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(sessionId, timer);
  }

  /** Get a summary of missed output for a detached session. */
  getMissedOutputSummary(sessionId: string): { byteCount: number; lineCount: number } | null {
    const buffered = this.reattachBuffers.get(sessionId);
    if (!buffered) return null;
    const lineCount = (buffered.match(/\n/g) || []).length;
    return { byteCount: buffered.length, lineCount };
  }

  /** Reattach new callbacks to an existing session.
   *  Flushes any output buffered during detachment to the new client first.
   *  The reattach buffer is trimmed to a clean line boundary to avoid sending
   *  partial ANSI escape sequences that could corrupt the client terminal. */
  reattachSession(
    sessionId: string,
    onOutput: OutputCallback,
    onClose: CloseCallback,
  ): TerminalSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Cancel idle timer
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) { clearTimeout(idleTimer); this.idleTimers.delete(sessionId); }

    // Advance the attach generation — any pending detach with the old gen becomes a no-op
    const nextGen = (this.attachGen.get(sessionId) ?? 0) + 1;
    this.attachGen.set(sessionId, nextGen);

    // Set callbacks BEFORE flushing the reattach buffer so that any PTY output
    // arriving during the flush goes to the new client instead of being dropped.
    this.outputCallbacks.set(sessionId, onOutput);
    this.closeCallbacks.set(sessionId, onClose);

    // Flush output buffered while client was away, trimmed to a clean line boundary
    const buffered = this.reattachBuffers.get(sessionId);
    if (buffered) {
      const trimmed = this.trimToLineBoundary(buffered);
      if (trimmed.length > 0) {
        onOutput(sessionId, trimmed);
      }
      this.reattachBuffers.delete(sessionId);
    }

    logger.success(`Session reattached: ${sessionId}`);
    return session;
  }

  /** Trim a buffer to a clean boundary at the start (skip any partial line and
   *  incomplete ANSI escape sequences that could corrupt the terminal display). */
  private trimToLineBoundary(buf: string): string {
    // If the buffer was already captured from the start (not sliced), it's clean
    if (buf.length < REATTACH_BUFFER_MAX) return buf;

    // The buffer was sliced from a larger stream — the start may be mid-ANSI-sequence
    // or mid-line. Skip to the first complete line after any partial ANSI sequences.
    const firstNewline = buf.indexOf('\n');
    if (firstNewline === -1) return buf; // no newlines at all, send as-is

    let start = firstNewline + 1;

    // After skipping the first partial line, check if we're still inside an incomplete
    // ANSI escape sequence. An incomplete sequence looks like: \x1b followed by [ and
    // then digits/semicolons but no terminating letter (A-Z, a-z).
    // Scan up to 32 chars to find the end of any stale partial sequence.
    const chunk = buf.slice(start, start + 32);
    if (/^[0-9;]*[A-Za-z]/.test(chunk)) {
      // Looks like the tail of a split CSI sequence (e.g., "27;200mText")
      // Skip past the terminating letter
      const match = chunk.match(/^[0-9;]*[A-Za-z]/);
      if (match) start += match[0].length;
    }

    return buf.slice(start);
  }

  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    return true;
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId); // prevent reattach
    session.pty.kill(); // onExit will handle full cleanup
    logger.info(`Session closed: ${sessionId}`);
    return true;
  }

  closeAllSessions(): void {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }

  detachAllSessions(): void {
    for (const [id] of this.sessions) {
      this.detachSession(id);
    }
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private _cleanup(sessionId: string): void {
    this.sessions.delete(sessionId); // tolerate already-deleted
    this.outputCallbacks.delete(sessionId);
    this.closeCallbacks.delete(sessionId);
    this.outputBuffers.delete(sessionId);
    this.reattachBuffers.delete(sessionId);
    this.batchIntervals.delete(sessionId);
    this.attachGen.delete(sessionId);
    const t = this.outputTimers.get(sessionId);
    if (t) { clearTimeout(t); this.outputTimers.delete(sessionId); }
    const i = this.idleTimers.get(sessionId);
    if (i) { clearTimeout(i); this.idleTimers.delete(sessionId); }
  }
}

// Global singleton — sessions survive WebSocket disconnects
export const globalManager = new TerminalManager();
