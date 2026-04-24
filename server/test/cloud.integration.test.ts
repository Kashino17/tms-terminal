import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudObserver } from '../src/manager/cloud/cloud.observer';
import type { CloudConfig, CloudReport } from '../src/manager/cloud/cloud.types';
import { createEmptyCloudState } from '../src/manager/cloud/cloud.types';
import { DEFAULT_CLOUD_CONFIG } from '../src/manager/cloud/cloud.config';

describe('Cloud integration — full pattern→push→ingest flow', () => {
  let observer: CloudObserver;
  let pushes: CloudReport[];
  let ingests: CloudReport[];

  const cfg: CloudConfig = { ...DEFAULT_CLOUD_CONFIG, templateOnly: true };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    pushes = [];
    ingests = [];
    observer = new CloudObserver({
      config: cfg,
      state: createEmptyCloudState(),
      resolveLabel: (sid) => `T-${sid}`,
      onUrgentPush: (r) => pushes.push(r),
      onInfoReport: (r) => ingests.push(r),
      isManagerProcessing: () => false,
    });
    observer.start();
  });

  afterEach(() => {
    observer.stop();
    vi.useRealTimers();
  });

  it('urgent error triggers push AND ingest (dual-surface)', () => {
    observer.feed('s1', 'TypeError: x is undefined\n');
    expect(pushes).toHaveLength(1);
    expect(ingests).toHaveLength(1);
    expect(pushes[0].hash).toBe(ingests[0].hash);
  });

  it('silence trigger routes only to ingest (no urgent push)', () => {
    observer.feed('s1', 'running tests...\n' + 'a'.repeat(600));
    vi.advanceTimersByTime(1600);
    expect(pushes).toHaveLength(0);
    expect(ingests).toHaveLength(1);
    expect(ingests[0].urgency).toBe('info');
  });

  it('tool-call cooldown blocks both paths', () => {
    observer.pauseSession('s1', 3000);
    observer.feed('s1', 'Error: during cooldown\n' + 'a'.repeat(600));
    vi.advanceTimersByTime(1600);
    expect(pushes).toHaveLength(0);
    expect(ingests).toHaveLength(0);
  });
});
