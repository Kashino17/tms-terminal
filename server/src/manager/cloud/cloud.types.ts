export type CloudTrigger = 'pattern' | 'silence';
export type CloudUrgency = 'urgent' | 'info';

export type CloudPatternId =
  | 'claude-prompt-waiting'
  | 'codex-prompt-waiting'
  | 'gemini-prompt-waiting'
  | 'shell-yesno-prompt'
  | 'password-prompt'
  | 'error-signature'
  | 'test-failure'
  | 'crash-signal';

export interface PatternMatch {
  id: CloudPatternId;
  urgency: CloudUrgency;
  matchedLine: string;
  /** Key/value pairs the template summarizer will interpolate. */
  templateVars: Record<string, string>;
}

export interface CloudReport {
  sessionId: string;
  sessionLabel: string;
  trigger: CloudTrigger;
  urgency: CloudUrgency;
  title: string;
  body: string;
  /** Stable hash for dedup — SHA-256 of sessionId + last 200 chars of trigger context. */
  hash: string;
  ts: number;
}

export interface CloudConfig {
  enabled: boolean;
  silenceDebounceMs: number;
  remWriteCooldownMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  minBufferDeltaChars: number;
  llmProvider: 'anthropic' | 'openai';
  llmModel: string;
  llmTimeoutMs: number;
  templateOnly: boolean;
}

export interface CloudState {
  lastReportAt: Record<string, number>;
  dedupHashes: Array<{ hash: string; ts: number }>;
  rateLimitWindows: Record<string, number[]>;
}

export function createEmptyCloudState(): CloudState {
  return {
    lastReportAt: {},
    dedupHashes: [],
    rateLimitWindows: {},
  };
}
