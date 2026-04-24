import type { CloudState } from './cloud.types';

export interface DedupGuardOptions {
  rateLimitMax: number;
  rateLimitWindowMs: number;
  dedupWindowMs: number;
  maxDedupEntries: number;
}

export class DedupGuard {
  private cooldowns: Map<string, number> = new Map();

  constructor(
    private state: CloudState,
    private opts: DedupGuardOptions,
  ) {}

  hasSeen(hash: string): boolean {
    this.pruneDedup();
    return this.state.dedupHashes.some((e) => e.hash === hash);
  }

  recordHash(hash: string): void {
    this.pruneDedup();
    this.state.dedupHashes.push({ hash, ts: Date.now() });
    if (this.state.dedupHashes.length > this.opts.maxDedupEntries) {
      this.state.dedupHashes.splice(
        0,
        this.state.dedupHashes.length - this.opts.maxDedupEntries,
      );
    }
  }

  isInCooldown(sessionId: string): boolean {
    const until = this.cooldowns.get(sessionId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldowns.delete(sessionId);
      return false;
    }
    return true;
  }

  setCooldown(sessionId: string, durationMs: number): void {
    this.cooldowns.set(sessionId, Date.now() + durationMs);
  }

  isRateLimited(sessionId: string): boolean {
    const window = this.pruneRateLimit(sessionId);
    return window.length >= this.opts.rateLimitMax;
  }

  recordReport(sessionId: string): void {
    const window = this.pruneRateLimit(sessionId);
    window.push(Date.now());
    this.state.rateLimitWindows[sessionId] = window;
  }

  private pruneDedup(): void {
    const cutoff = Date.now() - this.opts.dedupWindowMs;
    this.state.dedupHashes = this.state.dedupHashes.filter((e) => e.ts >= cutoff);
  }

  private pruneRateLimit(sessionId: string): number[] {
    const cutoff = Date.now() - this.opts.rateLimitWindowMs;
    const existing = this.state.rateLimitWindows[sessionId] ?? [];
    const pruned = existing.filter((ts) => ts >= cutoff);
    this.state.rateLimitWindows[sessionId] = pruned;
    return pruned;
  }
}
