import * as crypto from 'crypto';
import { logger } from '../../utils/logger';
import { DedupGuard } from './cloud.dedup';
import { matchPattern } from './cloud.patterns';
import { templateSummary, templateInfoSummary } from './cloud.summarizer';
import type {
  CloudConfig,
  CloudReport,
  CloudState,
  PatternMatch,
} from './cloud.types';

export interface CloudObserverDeps {
  config: CloudConfig;
  state: CloudState;
  resolveLabel: (sessionId: string) => string;
  onUrgentPush: (report: CloudReport) => void;
  onInfoReport: (report: CloudReport) => void;
  isManagerProcessing: () => boolean;
}

interface SessionBuf {
  buffer: string;
  timer: NodeJS.Timeout | null;
  lastFeedTs: number;
}

export class CloudObserver {
  private running = false;
  private guard: DedupGuard;
  private buffers: Map<string, SessionBuf> = new Map();

  constructor(private deps: CloudObserverDeps) {
    this.guard = new DedupGuard(deps.state, {
      rateLimitMax: deps.config.rateLimitMax,
      rateLimitWindowMs: deps.config.rateLimitWindowMs,
      dedupWindowMs: 60_000,
      maxDedupEntries: 200,
    });
  }

  start(): void {
    this.running = true;
    if (this.deps.config.enabled) {
      logger.info('[cloud] observer started');
    }
  }

  stop(): void {
    this.running = false;
    for (const buf of this.buffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
    }
    this.buffers.clear();
    logger.info('[cloud] observer stopped');
  }

  pauseSession(sessionId: string, durationMs: number): void {
    this.guard.setCooldown(sessionId, durationMs);
  }

  feed(sessionId: string, chunk: string): void {
    if (!this.running || !this.deps.config.enabled) return;
    if (this.guard.isInCooldown(sessionId)) return;
    if (!chunk.trim()) return;

    // 1. Synchronous pattern check (urgent path)
    const match = matchPattern(chunk);
    if (match) {
      this.emitPatternReport(sessionId, chunk, match);
    }

    // 2. Accumulate buffer and (re)arm silence debounce
    const buf = this.buffers.get(sessionId) ?? { buffer: '', timer: null, lastFeedTs: 0 };
    buf.buffer = (buf.buffer + chunk).slice(-3000);
    buf.lastFeedTs = Date.now();
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => this.onSilence(sessionId), this.deps.config.silenceDebounceMs);
    this.buffers.set(sessionId, buf);
  }

  private emitPatternReport(sessionId: string, chunk: string, match: PatternMatch): void {
    if (this.guard.isRateLimited(sessionId)) return;

    const hash = this.makeHash(sessionId, match.matchedLine);
    if (this.guard.hasSeen(hash)) return;

    const label = this.deps.resolveLabel(sessionId);
    const summary = templateSummary(match, label);
    const report: CloudReport = {
      sessionId,
      sessionLabel: label,
      trigger: 'pattern',
      urgency: 'urgent',
      title: summary.title,
      body: summary.body,
      hash,
      ts: Date.now(),
    };

    this.guard.recordHash(hash);
    this.guard.recordReport(sessionId);
    try {
      this.deps.onUrgentPush(report);
    } catch (err) {
      logger.warn(`[cloud] onUrgentPush threw: ${err}`);
    }
    if (!this.deps.isManagerProcessing()) {
      try {
        this.deps.onInfoReport(report);
      } catch (err) {
        logger.warn(`[cloud] onInfoReport(urgent-copy) threw: ${err}`);
      }
    }
  }

  private onSilence(sessionId: string): void {
    if (!this.running) return;
    if (this.deps.isManagerProcessing()) {
      const buf = this.buffers.get(sessionId);
      if (buf) buf.buffer = '';
      return;
    }
    const buf = this.buffers.get(sessionId);
    if (!buf) return;
    if (buf.buffer.length < this.deps.config.minBufferDeltaChars) {
      buf.buffer = '';
      return;
    }
    if (this.guard.isRateLimited(sessionId)) return;

    const content = buf.buffer;
    const last200 = content.slice(-200);
    const hash = this.makeHash(sessionId, last200);
    if (this.guard.hasSeen(hash)) {
      buf.buffer = '';
      return;
    }

    const label = this.deps.resolveLabel(sessionId);
    const lastLine = content.split('\n').filter((l) => l.trim()).pop() ?? '';
    const summary = templateInfoSummary(label, lastLine, content.length);

    const report: CloudReport = {
      sessionId,
      sessionLabel: label,
      trigger: 'silence',
      urgency: 'info',
      title: summary.title,
      body: summary.body,
      hash,
      ts: Date.now(),
    };

    this.guard.recordHash(hash);
    this.guard.recordReport(sessionId);
    buf.buffer = '';
    this.deps.state.lastReportAt[sessionId] = Date.now();

    try {
      this.deps.onInfoReport(report);
    } catch (err) {
      logger.warn(`[cloud] onInfoReport threw: ${err}`);
    }
  }

  private makeHash(sessionId: string, content: string): string {
    return crypto.createHash('sha256').update(`${sessionId}|${content}`).digest('hex');
  }
}
