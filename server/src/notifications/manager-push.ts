/**
 * Decides whether a manager-reply push notification should be sent,
 * based on the mobile client's last-reported screen state and per-session
 * debouncing. Extracted from ws.handler for testability.
 */

export interface ScreenState {
  activeScreen: 'manager_chat' | 'other';
  foregrounded: boolean;
}

export interface ShouldPushResult {
  push: boolean;
  reason?: 'no-tokens' | 'chat-active' | 'debounced';
}

interface ManagerPushDeciderOptions {
  clock?: () => number;
  staleThresholdMs?: number;
  debounceMs?: number;
}

export class ManagerPushDecider {
  private tokensCount = 0;
  private screenState: ScreenState | null = null;
  private lastScreenStateAt = 0;
  private lastReplyPushAt = new Map<string, number>();
  private readonly clock: () => number;
  private readonly staleThresholdMs: number;
  private readonly debounceMs: number;

  constructor(opts: ManagerPushDeciderOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.staleThresholdMs = opts.staleThresholdMs ?? 15_000;
    this.debounceMs = opts.debounceMs ?? 3_000;
  }

  setTokensCount(n: number): void {
    this.tokensCount = n;
  }

  updateScreenState(state: ScreenState): void {
    this.screenState = state;
    this.lastScreenStateAt = this.clock();
  }

  shouldPush(sessionId: string): ShouldPushResult {
    if (this.tokensCount === 0) return { push: false, reason: 'no-tokens' };

    const stateAge = this.clock() - this.lastScreenStateAt;
    const stateIsFresh = stateAge < this.staleThresholdMs;
    if (
      stateIsFresh &&
      this.screenState?.activeScreen === 'manager_chat' &&
      this.screenState.foregrounded
    ) {
      return { push: false, reason: 'chat-active' };
    }

    const lastPush = this.lastReplyPushAt.get(sessionId) ?? 0;
    if (this.clock() - lastPush < this.debounceMs) {
      return { push: false, reason: 'debounced' };
    }

    return { push: true };
  }

  recordPushed(sessionId: string): void {
    this.lastReplyPushAt.set(sessionId, this.clock());
  }

  generateMessageId(): string {
    const ts = this.clock();
    const rnd = Math.random().toString(36).slice(2, 8);
    return `mr_${ts}_${rnd}`;
  }
}
