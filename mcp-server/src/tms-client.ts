import WebSocket from 'ws';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionId: string;
  label: string;
  cols: number;
  rows: number;
}

// ── ANSI stripping ──────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

// ── TMS Terminal WebSocket Client ───────────────────────────────────────────

export class TmsClient {
  private ws: WebSocket | null = null;
  private sessions = new Map<string, SessionInfo>();
  private outputBuffers = new Map<string, string>();
  private pendingResolvers = new Map<string, (value: any) => void>();
  private connected = false;

  constructor(
    private host: string,
    private port: number,
    private token: string,
  ) {}

  // ── Connection ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}/?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('Connection timeout (10s)'));
      }, 10_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        // Start ping keepalive
        this.startPing();
        resolve();
      });

      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch { /* ignore parse errors */ }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.connected) reject(err);
      });
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.sessions.clear();
    this.outputBuffers.clear();
  }

  isConnected(): boolean { return this.connected; }

  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, 10_000);
  }

  // ── Message Handling ────────────────────────────────────────────────────

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'terminal:created': {
        const info: SessionInfo = {
          sessionId: msg.sessionId,
          label: `Shell ${this.sessions.size + 1}`,
          cols: msg.payload.cols,
          rows: msg.payload.rows,
        };
        this.sessions.set(msg.sessionId, info);
        this.outputBuffers.set(msg.sessionId, '');
        this.resolvePending('create', info);
        break;
      }
      case 'terminal:output': {
        const buf = this.outputBuffers.get(msg.sessionId) ?? '';
        const clean = stripAnsi(msg.payload.data);
        // Keep last 20KB per session
        const combined = buf + clean;
        this.outputBuffers.set(
          msg.sessionId,
          combined.length > 20_000 ? combined.slice(-20_000) : combined,
        );
        break;
      }
      case 'terminal:closed': {
        this.sessions.delete(msg.sessionId);
        this.outputBuffers.delete(msg.sessionId);
        break;
      }
      case 'terminal:reattached': {
        if (!this.sessions.has(msg.sessionId)) {
          this.sessions.set(msg.sessionId, {
            sessionId: msg.sessionId,
            label: `Shell ${this.sessions.size + 1}`,
            cols: msg.payload.cols,
            rows: msg.payload.rows,
          });
          this.outputBuffers.set(msg.sessionId, '');
        }
        break;
      }
      case 'pong':
        break;
    }
  }

  private resolvePending(key: string, value: any): void {
    const resolver = this.pendingResolvers.get(key);
    if (resolver) {
      this.pendingResolvers.delete(key);
      resolver(value);
    }
  }

  // ── Send Helper ─────────────────────────────────────────────────────────

  private send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to TMS Terminal server');
    }
    this.ws.send(JSON.stringify(msg));
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** List all active terminal sessions. */
  listSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  /** Create a new terminal session. */
  async createSession(cols = 120, rows = 30): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete('create');
        reject(new Error('Session creation timeout (5s)'));
      }, 5_000);

      this.pendingResolvers.set('create', (info) => {
        clearTimeout(timeout);
        resolve(info);
      });

      this.send({ type: 'terminal:create', payload: { cols, rows } });
    });
  }

  /** Send input to a terminal session. */
  sendInput(sessionId: string, data: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    this.send({ type: 'terminal:input', sessionId, payload: { data } });
  }

  /** Send a command (text + Enter) to a terminal session. */
  sendCommand(sessionId: string, command: string): void {
    this.sendInput(sessionId, command);
    // Send Enter after a short delay (same pattern as autopilot)
    setTimeout(() => this.sendInput(sessionId, '\r'), 100);
  }

  /** Read recent output from a terminal session. */
  readOutput(sessionId: string, lastN = 2000): string {
    const buf = this.outputBuffers.get(sessionId);
    if (buf === undefined) throw new Error(`Session ${sessionId} not found`);
    return buf.length > lastN ? buf.slice(-lastN) : buf;
  }

  /** Clear the output buffer for a session. */
  clearOutput(sessionId: string): void {
    if (!this.outputBuffers.has(sessionId)) throw new Error(`Session ${sessionId} not found`);
    this.outputBuffers.set(sessionId, '');
  }

  /** Close a terminal session. */
  closeSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} not found`);
    this.send({ type: 'terminal:close', sessionId });
  }

  /** Send Ctrl+C to a session. */
  sendCtrlC(sessionId: string): void {
    this.sendInput(sessionId, '\x03');
  }

  /** Resolve a session by label (e.g. "Shell 1") or partial ID. */
  resolveSession(ref: string): SessionInfo | null {
    // Exact ID match
    const byId = this.sessions.get(ref);
    if (byId) return byId;

    // Label match (case insensitive)
    for (const s of this.sessions.values()) {
      if (s.label.toLowerCase() === ref.toLowerCase()) return s;
    }

    // Partial ID match
    for (const s of this.sessions.values()) {
      if (s.sessionId.startsWith(ref)) return s;
    }

    return null;
  }
}
