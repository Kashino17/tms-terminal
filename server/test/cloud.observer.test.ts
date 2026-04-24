import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudObserver } from '../src/manager/cloud/cloud.observer';
import type { CloudReport, CloudConfig } from '../src/manager/cloud/cloud.types';
import { createEmptyCloudState } from '../src/manager/cloud/cloud.types';

const CFG: CloudConfig = {
  enabled: true,
  silenceDebounceMs: 1500,
  remWriteCooldownMs: 3000,
  rateLimitMax: 5,
  rateLimitWindowMs: 120_000,
  minBufferDeltaChars: 500,
  llmProvider: 'anthropic',
  llmModel: 'claude-haiku-4-5-20251001',
  llmTimeoutMs: 5000,
  templateOnly: true,
};

describe('CloudObserver', () => {
  let observer: CloudObserver;
  let state = createEmptyCloudState();
  let urgentPushes: CloudReport[];
  let infoReports: CloudReport[];
  let labelFor: (sid: string) => string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T10:00:00Z'));
    state = createEmptyCloudState();
    urgentPushes = [];
    infoReports = [];
    labelFor = (sid) => `Label-${sid}`;

    observer = new CloudObserver({
      config: CFG,
      state,
      resolveLabel: labelFor,
      onUrgentPush: (r) => urgentPushes.push(r),
      onInfoReport: (r) => infoReports.push(r),
      isManagerProcessing: () => false,
    });
    observer.start();
  });

  afterEach(() => {
    observer.stop();
    vi.useRealTimers();
  });

  it('fires urgent push on pattern match', () => {
    observer.feed('s1', 'Error: boom happened\n');
    expect(urgentPushes).toHaveLength(1);
    expect(urgentPushes[0].urgency).toBe('urgent');
    expect(urgentPushes[0].trigger).toBe('pattern');
    expect(urgentPushes[0].body).toContain('boom');
  });

  it('fires info report after silence if buffer exceeds minDelta', () => {
    observer.feed('s1', 'a'.repeat(600));
    expect(infoReports).toHaveLength(0);
    vi.advanceTimersByTime(1501);
    expect(infoReports).toHaveLength(1);
    expect(infoReports[0].trigger).toBe('silence');
  });

  it('does NOT fire silence trigger if buffer below minDelta', () => {
    observer.feed('s1', 'a'.repeat(100));
    vi.advanceTimersByTime(2000);
    expect(infoReports).toHaveLength(0);
  });

  it('resets silence debounce on new chunk', () => {
    observer.feed('s1', 'a'.repeat(400));
    vi.advanceTimersByTime(1000);
    observer.feed('s1', 'b'.repeat(400));
    vi.advanceTimersByTime(1000);
    expect(infoReports).toHaveLength(0);
    vi.advanceTimersByTime(600);
    expect(infoReports).toHaveLength(1);
  });

  it('enforces Rem-write cooldown (ignores all input)', () => {
    observer.pauseSession('s1', 3000);
    observer.feed('s1', 'Error: blocked\n');
    expect(urgentPushes).toHaveLength(0);
    vi.advanceTimersByTime(3001);
    observer.feed('s1', 'Error: now allowed\n');
    expect(urgentPushes).toHaveLength(1);
  });

  it('enforces dedup within window (same hash twice → one push)', () => {
    observer.feed('s1', 'Error: same\n');
    observer.feed('s1', 'Error: same\n');
    expect(urgentPushes).toHaveLength(1);
  });

  it('enforces rate limit (max 5 per session in 2min)', () => {
    for (let i = 0; i < 10; i++) {
      observer.feed('s1', `Error: boom-${i}\n`);
    }
    expect(urgentPushes.length).toBeLessThanOrEqual(5);
  });

  it('skips silence trigger when Manager is processing (urgent still fires)', () => {
    observer.stop();
    observer = new CloudObserver({
      config: CFG,
      state,
      resolveLabel: labelFor,
      onUrgentPush: (r) => urgentPushes.push(r),
      onInfoReport: (r) => infoReports.push(r),
      isManagerProcessing: () => true,
    });
    observer.start();
    observer.feed('s1', 'a'.repeat(600));
    vi.advanceTimersByTime(2000);
    expect(infoReports).toHaveLength(0);
    observer.feed('s1', 'Error: urgent\n');
    expect(urgentPushes).toHaveLength(1);
  });

  it('is disabled when config.enabled=false', () => {
    observer.stop();
    observer = new CloudObserver({
      config: { ...CFG, enabled: false },
      state,
      resolveLabel: labelFor,
      onUrgentPush: (r) => urgentPushes.push(r),
      onInfoReport: (r) => infoReports.push(r),
      isManagerProcessing: () => false,
    });
    observer.start();
    observer.feed('s1', 'Error: boom\n');
    vi.advanceTimersByTime(2000);
    expect(urgentPushes).toHaveLength(0);
    expect(infoReports).toHaveLength(0);
  });

  it('is session-isolated (s1 cooldown does not affect s2)', () => {
    observer.pauseSession('s1', 3000);
    observer.feed('s2', 'Error: s2\n');
    expect(urgentPushes).toHaveLength(1);
    expect(urgentPushes[0].sessionId).toBe('s2');
  });
});
