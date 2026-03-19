import type WebSocket from 'ws';
import type { TerminalManager } from '../terminal/terminal.manager';

export interface AuthenticatedClient {
  ws: WebSocket;
  terminalManager: TerminalManager;
  authenticated: boolean;
  ip: string;
}
