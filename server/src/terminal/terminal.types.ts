/**
 * The slice of node-pty's IPty the server actually uses. A real node-pty
 * satisfies it directly; so does the proxy for a terminal held by the
 * terminal keeper daemon (ptyd/client.ts), which survives server restarts.
 */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface TerminalSession {
  id: string;
  pty: PtyLike;
  cols: number;
  rows: number;
  createdAt: Date;
  /** Last known working directory — captured when the client disconnects. */
  cwd?: string;
  /** Last known foreground process name — captured when the client disconnects. */
  processName?: string;
}

export interface CreateSessionOptions {
  cols: number;
  rows: number;
  /**
   * Vorgegebene Session-ID. Nur für die Wiederherstellung nach einem Neustart:
   * die App hält ihre Reiter an dieser ID fest. Sonst weglassen.
   */
  id?: string;
  /** Startverzeichnis der Shell. Standard: Home. */
  cwd?: string;
}
