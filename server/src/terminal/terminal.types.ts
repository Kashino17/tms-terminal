import type { IPty } from 'node-pty';

export interface TerminalSession {
  id: string;
  pty: IPty;
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
}
