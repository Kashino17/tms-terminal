export type AiToolType = 'claude' | 'codex' | 'gemini' | null;

export interface TerminalTab {
  id: string;
  sessionId?: string;
  title: string;
  serverId: string;
  active: boolean;
  aiTool?: AiToolType;
  notificationCount?: number;
  /** True when the user has manually renamed the tab — disables auto-naming from CWD. */
  customTitle?: boolean;
  /** Last known working directory — persisted so it survives app restarts. */
  lastCwd?: string;
  /** Last known foreground process name (e.g. "vim", "npm") when session was suspended. */
  lastProcess?: string;
}
