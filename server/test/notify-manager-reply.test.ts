import { describe, it, expect, beforeEach } from 'vitest';
import { ManagerPushDecider } from '../src/notifications/manager-push';

describe('ManagerPushDecider', () => {
  let decider: ManagerPushDecider;
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    decider = new ManagerPushDecider({ clock });
    now = 1_000_000;
  });

  describe('shouldPush', () => {
    it('returns false when no tokens registered', () => {
      expect(decider.shouldPush('session-1')).toEqual({ push: false, reason: 'no-tokens' });
    });

    it('returns true when tokens exist and no screen state', () => {
      decider.setTokensCount(1);
      expect(decider.shouldPush('session-1')).toEqual({ push: true });
    });

    it('skips when user is on manager_chat + foregrounded + state is fresh', () => {
      decider.setTokensCount(1);
      decider.updateScreenState({ activeScreen: 'manager_chat', foregrounded: true });
      expect(decider.shouldPush('session-1')).toEqual({ push: false, reason: 'chat-active' });
    });

    it('pushes when screen state is stale (>15s old) even if chat was last reported', () => {
      decider.setTokensCount(1);
      decider.updateScreenState({ activeScreen: 'manager_chat', foregrounded: true });
      now += 16_000;
      expect(decider.shouldPush('session-1')).toEqual({ push: true });
    });

    it('pushes when chat screen reported but foregrounded is false (backgrounded)', () => {
      decider.setTokensCount(1);
      decider.updateScreenState({ activeScreen: 'manager_chat', foregrounded: false });
      expect(decider.shouldPush('session-1')).toEqual({ push: true });
    });

    it('pushes when on other screen even if foregrounded', () => {
      decider.setTokensCount(1);
      decider.updateScreenState({ activeScreen: 'other', foregrounded: true });
      expect(decider.shouldPush('session-1')).toEqual({ push: true });
    });
  });

  describe('debounce', () => {
    it('skips second push within 3s for same session', () => {
      decider.setTokensCount(1);
      expect(decider.shouldPush('session-1')).toEqual({ push: true });
      decider.recordPushed('session-1');
      now += 1_000;
      expect(decider.shouldPush('session-1')).toEqual({ push: false, reason: 'debounced' });
    });

    it('allows second push after 3s', () => {
      decider.setTokensCount(1);
      decider.recordPushed('session-1');
      now += 3_001;
      expect(decider.shouldPush('session-1')).toEqual({ push: true });
    });

    it('tracks debounce per session independently', () => {
      decider.setTokensCount(1);
      decider.recordPushed('session-1');
      now += 1_000;
      expect(decider.shouldPush('session-2')).toEqual({ push: true });
    });
  });

  describe('generateMessageId', () => {
    it('returns a string starting with mr_', () => {
      expect(decider.generateMessageId()).toMatch(/^mr_\d+_[a-z0-9]{6}$/);
    });

    it('returns unique ids on consecutive calls', () => {
      const id1 = decider.generateMessageId();
      now += 1;
      const id2 = decider.generateMessageId();
      expect(id1).not.toBe(id2);
    });
  });
});
