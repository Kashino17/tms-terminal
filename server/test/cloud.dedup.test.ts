import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DedupGuard } from '../src/manager/cloud/cloud.dedup';
import type { CloudState } from '../src/manager/cloud/cloud.types';
import { createEmptyCloudState } from '../src/manager/cloud/cloud.types';

describe('DedupGuard', () => {
  let state: CloudState;
  let guard: DedupGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T10:00:00Z'));
    state = createEmptyCloudState();
    guard = new DedupGuard(state, {
      rateLimitMax: 5,
      rateLimitWindowMs: 120_000,
      dedupWindowMs: 60_000,
      maxDedupEntries: 200,
    });
  });

  describe('hasSeen', () => {
    it('returns false for new hash', () => {
      expect(guard.hasSeen('abc')).toBe(false);
    });

    it('returns true after recordHash within window', () => {
      guard.recordHash('abc');
      expect(guard.hasSeen('abc')).toBe(true);
    });

    it('returns false after hash expires (60s window)', () => {
      guard.recordHash('abc');
      vi.advanceTimersByTime(61_000);
      expect(guard.hasSeen('abc')).toBe(false);
    });

    it('caps ring buffer at maxDedupEntries', () => {
      for (let i = 0; i < 250; i++) guard.recordHash(`h${i}`);
      expect(state.dedupHashes.length).toBeLessThanOrEqual(200);
      expect(guard.hasSeen('h0')).toBe(false);
      expect(guard.hasSeen('h249')).toBe(true);
    });
  });

  describe('cooldown', () => {
    it('isInCooldown is false by default', () => {
      expect(guard.isInCooldown('s1')).toBe(false);
    });

    it('isInCooldown is true right after setCooldown', () => {
      guard.setCooldown('s1', 3000);
      expect(guard.isInCooldown('s1')).toBe(true);
    });

    it('isInCooldown is false after duration passes', () => {
      guard.setCooldown('s1', 3000);
      vi.advanceTimersByTime(3001);
      expect(guard.isInCooldown('s1')).toBe(false);
    });

    it('is session-scoped (s1 cooldown does not affect s2)', () => {
      guard.setCooldown('s1', 3000);
      expect(guard.isInCooldown('s2')).toBe(false);
    });
  });

  describe('rate-limit', () => {
    it('isRateLimited is false under cap', () => {
      for (let i = 0; i < 4; i++) guard.recordReport('s1');
      expect(guard.isRateLimited('s1')).toBe(false);
    });

    it('isRateLimited is true at cap', () => {
      for (let i = 0; i < 5; i++) guard.recordReport('s1');
      expect(guard.isRateLimited('s1')).toBe(true);
    });

    it('releases after window passes', () => {
      for (let i = 0; i < 5; i++) guard.recordReport('s1');
      vi.advanceTimersByTime(120_001);
      expect(guard.isRateLimited('s1')).toBe(false);
    });

    it('is session-scoped', () => {
      for (let i = 0; i < 5; i++) guard.recordReport('s1');
      expect(guard.isRateLimited('s2')).toBe(false);
    });
  });
});
