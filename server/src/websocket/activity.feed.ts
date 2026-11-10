/**
 * "What is each terminal working on" → one client connection.
 *
 * Same rule as the output pacer (output.pacer.ts): while the app is not on
 * screen NOTHING is sent — the phone's radio stays asleep. Changes collapse
 * into the final state, which goes out as one message when the app returns.
 */
import { sameActivity, type Activity } from '../terminal/activity';

export interface ActivityFeed {
  /** Send the full current state (call once after the connection is up). */
  start(): void;
  note(sessionId: string, activity: Activity | null): void;
  setForeground(foreground: boolean): void;
}

export function createActivityFeed(
  send: (changes: Record<string, Activity | null>) => void,
  initial: Record<string, Activity> = {},
): ActivityFeed {
  let foreground = true;
  /** What the client has been told. */
  const known = new Map<string, Activity>();
  /** The true state, where it differs from `known`. */
  const pending = new Map<string, Activity | null>();
  for (const [id, a] of Object.entries(initial)) pending.set(id, a);

  const flush = (): void => {
    if (pending.size === 0) return;
    const changes: Record<string, Activity | null> = {};
    for (const [id, a] of pending) {
      changes[id] = a;
      if (a) known.set(id, a); else known.delete(id);
    }
    pending.clear();
    send(changes);
  };

  return {
    start() { flush(); },
    note(sessionId, activity) {
      if (sameActivity(known.get(sessionId) ?? null, activity)) pending.delete(sessionId);
      else pending.set(sessionId, activity);
      if (foreground) flush();
    },
    setForeground(next) {
      foreground = next;
      if (foreground) flush();
    },
  };
}
