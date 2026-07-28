import { randomUUID } from 'crypto';
import { readStore, writeStore, MANAGER_DIR } from '../store';
import type { OutboxFile, OutboxKind, OutboxMessage } from './outbox.types';

const FILE = 'outbox.json';
const MAX_MESSAGES = 500;
const PER_SESSION_COOLDOWN_MS = 60 * 60 * 1000;
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;

/** Kinds that are the agent's own idea and therefore rate-limited. */
const AGENT_INITIATED: OutboxKind[] = ['stuck', 'suggestion', 'event'];

export interface NewOutboxInput {
  kind: OutboxKind;
  text: string;
  topicKey?: string;
  project?: string;
  sessionId?: string;
}

export class Outbox {
  constructor(
    private readonly now: () => number,
    private readonly dir: string = MANAGER_DIR,
  ) {}

  private load(): OutboxFile {
    return readStore<OutboxFile>(FILE, { messages: [], suppressedTopics: [] }, this.dir);
  }

  private save(file: OutboxFile): void {
    writeStore<OutboxFile>(FILE, file, this.dir);
  }

  /**
   * Add a message if the dosage rules allow it, otherwise return null.
   *
   * The rules exist so the agent stays welcome: its own ideas are capped, the
   * user's own reminders never are.
   */
  push(input: NewOutboxInput): OutboxMessage | null {
    const file = this.load();
    const now = this.now();

    if (input.topicKey !== undefined) {
      // Rejected once — never again.
      if (file.suppressedTopics.includes(input.topicKey)) return null;
      // Already said once — saying it twice is what makes an assistant annoying.
      if (file.messages.some(m => m.topicKey === input.topicKey)) return null;
    }

    if (AGENT_INITIATED.includes(input.kind) && input.sessionId !== undefined) {
      const recent = file.messages.some(m =>
        m.sessionId === input.sessionId &&
        AGENT_INITIATED.includes(m.kind) &&
        now - m.createdAt < PER_SESSION_COOLDOWN_MS,
      );
      if (recent) return null;
    }

    const msg: OutboxMessage = {
      id: randomUUID(),
      kind: input.kind,
      text: input.text,
      topicKey: input.topicKey,
      project: input.project,
      sessionId: input.sessionId,
      createdAt: now,
    };
    file.messages.push(msg);
    this.enforceCap(file);
    this.save(file);
    return msg;
  }

  /** Newest first. */
  list(limit = 50): OutboxMessage[] {
    return [...this.load().messages].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  unreadCount(): number {
    return this.load().messages.filter(m => m.readAt === undefined).length;
  }

  markAllRead(): void {
    const file = this.load();
    const now = this.now();
    let touched = false;
    for (const m of file.messages) {
      if (m.readAt === undefined) { m.readAt = now; touched = true; }
    }
    if (touched) this.save(file);
  }

  markPushed(id: string): void {
    const file = this.load();
    const msg = file.messages.find(m => m.id === id);
    if (msg === undefined) return;
    msg.pushedAt = this.now();
    this.save(file);
  }

  suppressTopic(topicKey: string): void {
    const file = this.load();
    if (file.suppressedTopics.includes(topicKey)) return;
    file.suppressedTopics.push(topicKey);
    this.save(file);
  }

  /** Rejecting a message also buries its topic for good. */
  dismiss(id: string): void {
    const file = this.load();
    const msg = file.messages.find(m => m.id === id);
    if (msg === undefined) return;
    msg.dismissed = true;
    msg.readAt = msg.readAt ?? this.now();
    if (msg.topicKey !== undefined && !file.suppressedTopics.includes(msg.topicKey)) {
      file.suppressedTopics.push(msg.topicKey);
    }
    this.save(file);
  }

  /**
   * Whether this message may raise a push right now. Quiet hours silence the
   * phone but never the message itself — reminders the user scheduled are exempt,
   * because being woken at 06:00 is exactly what they asked for.
   */
  shouldPush(msg: OutboxMessage): boolean {
    if (msg.kind === 'reminder') return true;
    const hour = new Date(this.now()).getHours();
    const quiet = hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
    return !quiet;
  }

  /** Drop read messages first, oldest to newest; unread ones are kept. */
  private enforceCap(file: OutboxFile): void {
    if (file.messages.length <= MAX_MESSAGES) return;
    const excess = file.messages.length - MAX_MESSAGES;

    const readOldestFirst = file.messages
      .filter(m => m.readAt !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
    const doomed = new Set(readOldestFirst.slice(0, excess).map(m => m.id));

    if (doomed.size < excess) {
      // Not enough read messages — fall back to the oldest overall.
      const rest = file.messages
        .filter(m => !doomed.has(m.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const m of rest.slice(0, excess - doomed.size)) doomed.add(m.id);
    }

    file.messages = file.messages.filter(m => !doomed.has(m.id));
  }
}
