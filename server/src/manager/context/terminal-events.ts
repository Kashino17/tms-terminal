const IDLE_MS = 2 * 60 * 1000;

interface State {
  lastOutputAt: number;
  /** Whether anything worth calling "work" has happened since the last report. */
  wasBusy: boolean;
}

/**
 * Notices when a terminal that was actually working falls quiet.
 *
 * Deliberately separate from the delegated-task machinery in manager.service.ts:
 * this one exists for the terminals the user drives themselves, which nothing
 * else watches.
 */
export class TerminalEventDetector {
  private states = new Map<string, State>();

  constructor(
    private readonly now: () => number,
    private readonly idleMs: number = IDLE_MS,
  ) {}

  noteOutput(sessionId: string, busy: boolean): void {
    const s = this.states.get(sessionId) ?? { lastOutputAt: 0, wasBusy: false };
    s.lastOutputAt = this.now();
    // Sticky: the tail end of a build is often plain text, but the run as a
    // whole was work and still deserves a "fertig".
    if (busy) s.wasBusy = true;
    this.states.set(sessionId, s);
  }

  /** Sessions that just finished. Each is reported once per busy period. */
  pollFinished(): string[] {
    const now = this.now();
    const finished: string[] = [];
    for (const [sessionId, s] of this.states) {
      if (!s.wasBusy) continue;
      if (now - s.lastOutputAt < this.idleMs) continue;
      s.wasBusy = false; // re-arms only when real work happens again
      finished.push(sessionId);
    }
    return finished;
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }
}
