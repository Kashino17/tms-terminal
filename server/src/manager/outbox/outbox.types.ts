export type OutboxKind = 'reminder' | 'checkin' | 'stuck' | 'suggestion' | 'event';

export interface OutboxMessage {
  id: string;
  kind: OutboxKind;
  text: string;
  /** Stable key for "this exact topic", e.g. "stuck:<error-hash>". */
  topicKey?: string;
  project?: string;
  sessionId?: string;
  createdAt: number;
  readAt?: number;
  pushedAt?: number;
  dismissed?: boolean;
}

export interface OutboxFile {
  messages: OutboxMessage[];
  /** Topics the user rejected. They never come back. */
  suppressedTopics: string[];
}
