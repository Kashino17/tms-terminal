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
  /** `full`: this is the whole state — what is missing from it has no activity. */
  send: (changes: Record<string, Activity | null>, full: boolean) => void,
  initial: Record<string, Activity> = {},
): ActivityFeed {
  let foreground = true;
  /** What the client has been told. */
  const known = new Map<string, Activity>();
  /** The true state, where it differs from `known`. */
  const pending = new Map<string, Activity | null>();
  for (const [id, a] of Object.entries(initial)) pending.set(id, a);

  const flush = (full = false): void => {
    // The full state goes out even when empty: after a reconnect the app must
    // learn that activities it still shows are gone.
    if (pending.size === 0 && !full) return;
    const changes: Record<string, Activity | null> = {};
    for (const [id, a] of pending) {
      changes[id] = a;
      if (a) known.set(id, a); else known.delete(id);
    }
    pending.clear();
    send(changes, full);
  };

  return {
    start() { flush(true); },
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
