// Idle detection for terminal sessions.
// Sends a push notification when a session has had no input AND no output
// for a configurable duration (default 30 seconds, configurable up to 10 minutes).

export class IdleDetector {
  // Per-session tracking
  private lastActivity = new Map<string, number>(); // timestamp of last input or output
  private timers = new Map<string, NodeJS.Timeout>();
  private callbacks = new Map<string, (idleSecs: number) => void>();
  private idleThresholds = new Map<string, number>(); // per-session threshold in ms (default 30000)

  private defaultThreshold = 30_000; // 30 seconds default

  setDefaultThreshold(ms: number): void {
    this.defaultThreshold = Math.max(5000, Math.min(600_000, ms)); // 5s to 10min
  }

  getDefaultThreshold(): number {
    return this.defaultThreshold;
  }

  watch(sessionId: string, onIdle: (idleSecs: number) => void): void {
    this.callbacks.set(sessionId, onIdle);
    this.lastActivity.set(sessionId, Date.now());
  }

  // Call this on EVERY terminal:input and terminal:output
  activity(sessionId: string): void {
    this.lastActivity.set(sessionId, Date.now());
    // Reset the idle timer
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const threshold = this.idleThresholds.get(sessionId) ?? this.defaultThreshold;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      const lastAct = this.lastActivity.get(sessionId) ?? Date.now();
      const idleMs = Date.now() - lastAct;
      if (idleMs >= threshold * 0.9) { // 90% threshold to account for timer drift
        const cb = this.callbacks.get(sessionId);
        if (cb) cb(Math.round(idleMs / 1000));
      }
    }, threshold);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  setThreshold(sessionId: string, ms: number): void {
    this.idleThresholds.set(sessionId, Math.max(5000, Math.min(600_000, ms)));
  }

  unwatch(sessionId: string): void {
    this.callbacks.delete(sessionId);
    this.lastActivity.delete(sessionId);
    this.idleThresholds.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); }
  }
}

export const idleDetector = new IdleDetector();
