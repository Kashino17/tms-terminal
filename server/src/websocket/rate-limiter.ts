import { logger } from '../utils/logger';

// ── Rate Limiting: per-connection token bucket by message category ──────────
//
// Categories reflect risk/cost profile:
//   typing  — terminal:input, ping                → high throughput, low risk
//   actions — terminal:create/close, system:*      → creates processes, moderate risk
//   ai      — manager:chat, manager:poll, audio:*  → triggers paid API calls
//   config  — everything else                      → settings changes, watchers, etc.

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
  actions: { maxTokens: 10,  refillRate: 1 },     // 1/sec sustained, 10 burst
  ai:      { maxTokens: 5,   refillRate: 0.2 },   // 1 per 5s sustained, 5 burst
  config:  { maxTokens: 15,  refillRate: 1 },     // 1/sec sustained, 15 burst
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
  private violations = 0;
  private blocked = false;
  private blockedUntil = 0;

  /** Check if a message type is allowed. Returns true if allowed, false if rate limited. */
  consume(messageType: string): boolean {
    const now = Date.now();

    // Check if connection is temporarily blocked (too many violations)
    if (this.blocked) {
      if (now < this.blockedUntil) return false;
      this.blocked = false;
      this.violations = 0;
      logger.info('Rate limit: connection unblocked');
    }

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

    // Rate limited
    this.violations++;
    if (this.violations >= 50) {
      // 50 violations → block connection for 30 seconds
      this.blocked = true;
      this.blockedUntil = now + 30_000;
      logger.warn(`Rate limit: connection blocked for 30s (${this.violations} violations, category=${category})`);
    } else if (this.violations % 10 === 0) {
      logger.warn(`Rate limit: ${this.violations} violations (latest: ${messageType})`);
    }

    return false;
  }

  isBlocked(): boolean {
    if (!this.blocked) return false;
    if (Date.now() >= this.blockedUntil) {
      this.blocked = false;
      this.violations = 0;
      return false;
    }
    return true;
  }
}
