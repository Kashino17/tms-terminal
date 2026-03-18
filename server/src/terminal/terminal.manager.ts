import { v4 as uuidv4 } from 'uuid';
import { createPty } from './terminal.factory';
import { TerminalSession, CreateSessionOptions } from './terminal.types';
import { readProcessCwd, readForegroundProcess } from './cwd.utils';
import { logger } from '../utils/logger';
import { config } from '../config';

type OutputCallback = (sessionId: string, data: string) => void;
type CloseCallback = (sessionId: string, exitCode: number) => void;

const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const REATTACH_BUFFER_MAX = 300_000; // 300 KB — captured while client is away
const MAX_SESSIONS = 50;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private outputCallbacks = new Map<string, OutputCallback>();
  private closeCallbacks = new Map<string, CloseCallback>();
  private outputBuffers = new Map<string, string>();   // output-batching buffer (short-lived)
  private reattachBuffers = new Map<string, string>(); // output captured while detached
  private outputTimers = new Map<string, NodeJS.Timeout>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  /** Get all active PTY pids (for restricting system:kill to managed processes). */
  getManagedPids(): Set<number> {
    const pids = new Set<number>();
    for (const session of this.sessions.values()) {
      pids.add(session.pty.pid);
    }
    return pids;
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
      this.outputBuffers.set(id, existing + data);

      if (!this.outputTimers.has(id)) {
        const timer = setTimeout(() => {
          const buffered = this.outputBuffers.get(id);
          if (buffered) {
            this.outputCallbacks.get(id)?.(id, buffered);
            this.outputBuffers.delete(id);
          }
          this.outputTimers.delete(id);
        }, config.outputBufferMs);
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
  detachSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.closeCallbacks.delete(sessionId);

    // Snapshot CWD and foreground process before the client goes away (async, best-effort)
    const session = this.sessions.get(sessionId)!;
    const pid = session.pty.pid;
    void Promise.all([readProcessCwd(pid), readForegroundProcess(pid)]).then(([cwd, processName]) => {
      if (cwd) session.cwd = cwd;
      if (processName) session.processName = processName;
    });

    // Replace the send-to-client callback with a local buffer.
    // This ensures the existing batching timer (outputTimers) still fires
    // and its data lands in reattachBuffers rather than being dropped.
    this.outputCallbacks.set(sessionId, (_id, data) => {
      const existing = this.reattachBuffers.get(sessionId) || '';
      const combined = existing + data;
      this.reattachBuffers.set(
        sessionId,
        combined.length > REATTACH_BUFFER_MAX
          ? combined.slice(combined.length - REATTACH_BUFFER_MAX)
          : combined,
      );
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

  /** Reattach new callbacks to an existing session.
   *  Flushes any output buffered during detachment to the new client first. */
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

    // Flush output buffered while client was away
    const buffered = this.reattachBuffers.get(sessionId);
    if (buffered) {
      onOutput(sessionId, buffered);
      this.reattachBuffers.delete(sessionId);
    }

    this.outputCallbacks.set(sessionId, onOutput);
    this.closeCallbacks.set(sessionId, onClose);

    logger.success(`Session reattached: ${sessionId}`);
    return session;
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
    session.pty.kill();
    this._cleanup(sessionId);
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
    this.sessions.delete(sessionId);
    this.outputCallbacks.delete(sessionId);
    this.closeCallbacks.delete(sessionId);
    this.outputBuffers.delete(sessionId);
    this.reattachBuffers.delete(sessionId);
    const t = this.outputTimers.get(sessionId);
    if (t) { clearTimeout(t); this.outputTimers.delete(sessionId); }
    const i = this.idleTimers.get(sessionId);
    if (i) { clearTimeout(i); this.idleTimers.delete(sessionId); }
  }
}

// Global singleton — sessions survive WebSocket disconnects
export const globalManager = new TerminalManager();
