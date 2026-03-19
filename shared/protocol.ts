// Shared WebSocket message types between server and mobile app

// ── Client → Server ──────────────────────────────────────────────

export interface TerminalCreateMessage {
  type: 'terminal:create';
  payload: { cols: number; rows: number };
}

export interface TerminalInputMessage {
  type: 'terminal:input';
  sessionId: string;
  payload: { data: string };
}

export interface TerminalResizeMessage {
  type: 'terminal:resize';
  sessionId: string;
  payload: { cols: number; rows: number };
}

export interface TerminalCloseMessage {
  type: 'terminal:close';
  sessionId: string;
}

export interface TerminalClearMessage {
  type: 'terminal:clear';
  sessionId: string;
}

export interface TerminalReattachMessage {
  type: 'terminal:reattach';
  sessionId: string;
  payload: { cols: number; rows: number };
}

export interface PingMessage {
  type: 'ping';
}

export interface RegisterTokenMessage {
  type: 'client:register_token';
  payload: { token: string };
}

// ── Watcher messages (Client → Server) ──────────────────────────
export interface WatcherListMessage { type: 'watcher:list'; payload: Record<string, never>; }
export interface WatcherCreateMessage { type: 'watcher:create'; payload: { id: string; type: string; label: string; enabled: boolean; config: Record<string, string> }; }
export interface WatcherUpdateMessage { type: 'watcher:update'; payload: { id: string; enabled?: boolean }; }
export interface WatcherDeleteMessage { type: 'watcher:delete'; payload: { id: string }; }
export interface WatcherTestMessage   { type: 'watcher:test';   payload: { id: string }; }

// ── System monitor messages (Client → Server) ──────────────────
export interface SystemSnapshotMessage { type: 'system:snapshot'; }
export interface SystemKillMessage     { type: 'system:kill'; payload: { pid: number; signal?: string }; }

export type ClientMessage =
  | TerminalCreateMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalCloseMessage
  | TerminalClearMessage
  | TerminalReattachMessage
  | PingMessage
  | RegisterTokenMessage
  | WatcherListMessage
  | WatcherCreateMessage
  | WatcherUpdateMessage
  | WatcherDeleteMessage
  | WatcherTestMessage
  | SystemSnapshotMessage
  | SystemKillMessage;

// ── Server → Client ──────────────────────────────────────────────

export interface TerminalCreatedMessage {
  type: 'terminal:created';
  sessionId: string;
  payload: { cols: number; rows: number };
}

export interface TerminalOutputMessage {
  type: 'terminal:output';
  sessionId: string;
  payload: { data: string };
}

export interface TerminalClosedMessage {
  type: 'terminal:closed';
  sessionId: string;
  payload: { exitCode: number };
}

export interface TerminalErrorMessage {
  type: 'terminal:error';
  sessionId: string;
  payload: { message: string };
}

export interface TerminalReattachedMessage {
  type: 'terminal:reattached';
  sessionId: string;
  payload: {
    cols: number;
    rows: number;
    /** Working directory at the time the client last disconnected. */
    cwd?: string;
    /** Foreground process name at the time the client last disconnected. */
    processName?: string;
  };
}

export interface TerminalPromptDetectedMessage {
  type: 'terminal:prompt_detected';
  sessionId: string;
  payload: { snippet: string };
}

export interface PongMessage {
  type: 'pong';
}

// ── Watcher responses (Server → Client) ──────────────────────────
export interface WatcherListResponseMessage {
  type: 'watcher:list';
  payload: { watchers: Array<{ id: string; type: string; label: string; enabled: boolean; config: Record<string, string> }> };
}

export interface WatcherCreatedMessage {
  type: 'watcher:created';
  payload: { id: string; type: string; label: string; enabled: boolean; config: Record<string, string> };
}

export interface WatcherUpdatedMessage {
  type: 'watcher:updated';
  payload: { id: string; enabled: boolean };
}

export interface WatcherDeletedMessage {
  type: 'watcher:deleted';
  payload: { id: string };
}

export interface WatcherTestResultMessage {
  type: 'watcher:test_result';
  payload: { id: string; success: boolean; message?: string };
}

// ── System responses (Server → Client) ──────────────────────────
export interface SystemKillResultMessage {
  type: 'system:kill_result';
  payload: { pid: number; success: boolean; message?: string };
}

// ── System snapshot response (Server → Client) ──────────────────
export interface SystemSnapshotResponseMessage {
  type: 'system:snapshot';
  payload: {
    system: {
      cpuPercent: number;
      memPercent: number;
      memUsedMB: number;
      memTotalMB: number;
      diskPercent: number;
      uptime: string;
      loadAvg: number[];
    };
    processes: Array<{
      pid: number;
      name: string;
      cpu: number;
      mem: number;
      user: string;
    }>;
  };
}

export type ServerMessage =
  | TerminalCreatedMessage
  | TerminalOutputMessage
  | TerminalClosedMessage
  | TerminalErrorMessage
  | TerminalReattachedMessage
  | TerminalPromptDetectedMessage
  | PongMessage
  | WatcherListResponseMessage
  | WatcherCreatedMessage
  | WatcherUpdatedMessage
  | WatcherDeletedMessage
  | WatcherTestResultMessage
  | SystemSnapshotResponseMessage
  | SystemKillResultMessage;
