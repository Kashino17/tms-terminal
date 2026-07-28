import { logger } from '../utils/logger';

// ── Rate Limiting: per-connection token bucket by message category ──────────
//
// Categories reflect risk/cost profile:
//   typing  — terminal:input, ping                → high throughput, low risk
//   actions — terminal:create/close, system:*      → creates processes, moderate risk
//   ai      — manager:chat, manager:poll, audio:*  → triggers paid API calls
//   config  — everything else                      → settings changes, watchers, etc.
//
// Design constraints (learned the hard way — see git history):
//  * Buckets must absorb the app's legitimate reconnect behavior: after a
//    background return the client fires reattachAll twice (2×N reattaches for
//    N terminals) plus a resize per card, all within ~1.5s.
//  * NEVER block the whole connection. A full block swallows ping/pong, the
//    client then declares the link dead and reconnects, and the resulting
//    reattach storm re-triggers the limiter — a self-sustaining outage.
//  * Dropped messages must stay rare and visible (logged); silently dropping
//    terminal:create/reattach leaves ghost cards with no PTY behind them.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface BucketConfig {
  maxTokens: number;
  refillRate: number;  // tokens per second
}

const BUCKET_CONFIGS: Record<string, BucketConfig> = {
  typing:  { maxTokens: 200, refillRate: 100 },  // 100/sec sustained, 200 burst
  actions: { maxTokens: 60,  refillRate: 20 },    // absorbs reattach/resize storms
  ai:      { maxTokens: 10,  refillRate: 0.5 },   // 1 per 2s sustained, 10 burst
  config:  { maxTokens: 60,  refillRate: 10 },
};

const MESSAGE_CATEGORIES: Record<string, string> = {
  'terminal:input':   'typing',
  'ping':             'typing',
  'client:rtt':       'typing',
  'client:app_state': 'typing',
  'client:active_tab':'typing',

  'terminal:create':  'actions',
  'terminal:close':   'actions',
  'terminal:reattach':'actions',
  'terminal:resize':  'actions',
  'terminal:clear':   'actions',
  'system:snapshot':  'actions',
  'system:kill':      'actions',

  'manager:chat':     'ai',
  'manager:poll':     'ai',
  'audio:transcribe': 'ai',
  'autopilot:optimize': 'ai',

  // Everything else falls to 'config'
};

export class ConnectionRateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastDropLog = 0;
  private droppedSinceLog = 0;

  /** Check if a message type is allowed. Returns true if allowed, false if rate limited. */
  consume(messageType: string): boolean {
    const now = Date.now();

    const category = MESSAGE_CATEGORIES[messageType] ?? 'config';
    const cfg = BUCKET_CONFIGS[category];
    let bucket = this.buckets.get(category);

    if (!bucket) {
      bucket = { tokens: cfg.maxTokens, lastRefill: now };
      this.buckets.set(category, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(cfg.maxTokens, bucket.tokens + elapsed * cfg.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    // Rate limited — drop just this message, never the connection. Log at most
    // every 5s so a flood can't drown the server log.
    this.droppedSinceLog++;
    if (now - this.lastDropLog > 5_000) {
      logger.warn(`Rate limit: dropped ${this.droppedSinceLog} message(s) (latest: ${messageType}, category=${category})`);
      this.lastDropLog = now;
      this.droppedSinceLog = 0;
    }
    return false;
  }

  /** Whole-connection blocking was removed: it swallowed ping/pong, the client
   *  declared the link dead, and the reconnect+reattach storm re-triggered the
   *  limiter in a loop. Kept for call-site compatibility. */
  isBlocked(): boolean {
    return false;
  }
}
