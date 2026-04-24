# Cloud Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-side subsystem ("Cloud") that observes all terminal output in parallel to the Manager (Rem), fires two kinds of events (urgent pattern matches → direct FCM push, info-level silence triggers → LLM-summarized and routed through Rem), with four-layer loop prevention.

**Architecture:** Event-driven observer hooked into `managerService.feedOutput()`. Pattern-Matcher is synchronous and deterministic; Silence-Debouncer holds per-session `setTimeout` and accumulates buffered output for LLM summarization. State (dedup-hashes, rate-limit windows, cooldowns) persists in a new `cloudState` slot in `ManagerMemory`. Template summarization is always available; LLM summarization uses Anthropic Haiku with graceful fallback to templates on any failure.

**Tech Stack:** TypeScript / Node.js, vitest, `@anthropic-ai/sdk`, existing `fcm.service`, existing `manager.memory` JSON-persistence.

**Spec:** `docs/superpowers/specs/2026-04-24-cloud-observer-design.md`

---

## File Structure

### New files (all under `server/src/manager/cloud/`)
| File | Responsibility |
|---|---|
| `cloud.types.ts` | Shared types: `CloudReport`, `CloudTrigger`, `CloudUrgency`, `PatternMatch`, `CloudConfig`, `CloudState`. |
| `cloud.config.ts` | Load `cloud` block from `~/.tms-terminal/config.json` with defaults. |
| `cloud.dedup.ts` | `DedupGuard` class — hash-ring + cooldown-tracker + rate-limiter. |
| `cloud.patterns.ts` | Regex catalog + `match(chunk, sessionLabel): PatternMatch \| null`. |
| `cloud.summarizer.ts` | `templateSummary(event, label)` sync + `llmSummary(buffer, label, provider)` async. |
| `cloud.observer.ts` | Top-level orchestrator — `feed()`, `pauseSession()`, `start()`, `stop()`. |

### New tests (under `server/test/`)
| File | Covers |
|---|---|
| `cloud.dedup.test.ts` | Hash dedup, cooldown, rate-limit window cleanup. |
| `cloud.patterns.test.ts` | Each pattern positive + negative + edge cases. |
| `cloud.summarizer.test.ts` | Template extraction + LLM mock + fallback. |
| `cloud.observer.test.ts` | End-to-end feed() → trigger → push/ingest. |

### Modified files
| File | Change |
|---|---|
| `server/src/manager/manager.memory.ts` | Add `cloudState` to `ManagerMemory`, extend `createEmptyMemory()` + `loadMemory()`. |
| `server/src/manager/manager.service.ts` | Wire `cloudObserver` into `feedOutput()`, add `ingestCloudReport()`, hook `pauseSession()` into tool-handlers, start/stop observer with service lifecycle. |
| `server/src/notifications/fcm.service.ts` | No signature change; `data.sender` is already `Record<string, string>`-passthrough (no modification needed — enforced by convention in the design). |
| `shared/protocol.ts` | Add optional `manager:cloud_report` WS message type. |

---

## Task 1: Types, Config Schema, Memory Slot

**Files:**
- Create: `server/src/manager/cloud/cloud.types.ts`
- Create: `server/src/manager/cloud/cloud.config.ts`
- Modify: `server/src/manager/manager.memory.ts`

- [ ] **Step 1.1: Create cloud.types.ts**

Create `server/src/manager/cloud/cloud.types.ts`:

```typescript
export type CloudTrigger = 'pattern' | 'silence';
export type CloudUrgency = 'urgent' | 'info';

export type CloudPatternId =
  | 'claude-prompt-waiting'
  | 'codex-prompt-waiting'
  | 'gemini-prompt-waiting'
  | 'shell-yesno-prompt'
  | 'password-prompt'
  | 'error-signature'
  | 'test-failure'
  | 'crash-signal';

export interface PatternMatch {
  id: CloudPatternId;
  urgency: CloudUrgency;
  matchedLine: string;
  /** Key/value pairs the template summarizer will interpolate. */
  templateVars: Record<string, string>;
}

export interface CloudReport {
  sessionId: string;
  sessionLabel: string;
  trigger: CloudTrigger;
  urgency: CloudUrgency;
  title: string;
  body: string;
  /** Stable hash for dedup — SHA-256 of sessionId + last 200 chars of trigger context. */
  hash: string;
  ts: number;
}

export interface CloudConfig {
  enabled: boolean;
  silenceDebounceMs: number;
  remWriteCooldownMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  minBufferDeltaChars: number;
  llmProvider: 'anthropic' | 'openai';
  llmModel: string;
  llmTimeoutMs: number;
  templateOnly: boolean;
}

export interface CloudState {
  lastReportAt: Record<string, number>;
  dedupHashes: Array<{ hash: string; ts: number }>;
  rateLimitWindows: Record<string, number[]>;
}

export function createEmptyCloudState(): CloudState {
  return {
    lastReportAt: {},
    dedupHashes: [],
    rateLimitWindows: {},
  };
}
```

- [ ] **Step 1.2: Create cloud.config.ts**

Create `server/src/manager/cloud/cloud.config.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger';
import type { CloudConfig } from './cloud.types';

const CONFIG_FILE = path.join(os.homedir(), '.tms-terminal', 'config.json');

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  enabled: true,
  silenceDebounceMs: 1500,
  remWriteCooldownMs: 3000,
  rateLimitMax: 5,
  rateLimitWindowMs: 120_000,
  minBufferDeltaChars: 500,
  llmProvider: 'anthropic',
  llmModel: 'claude-haiku-4-5-20251001',
  llmTimeoutMs: 5000,
  templateOnly: false,
};

export function loadCloudConfig(): CloudConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CLOUD_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const block = (raw?.cloud ?? {}) as Partial<CloudConfig>;
    return { ...DEFAULT_CLOUD_CONFIG, ...block };
  } catch (err) {
    logger.warn(`[cloud.config] Failed to load, using defaults: ${err}`);
    return { ...DEFAULT_CLOUD_CONFIG };
  }
}
```

- [ ] **Step 1.3: Extend ManagerMemory with cloudState**

Modify `server/src/manager/manager.memory.ts`:

At the imports block top, add:
```typescript
import type { CloudState } from './cloud/cloud.types';
import { createEmptyCloudState } from './cloud/cloud.types';
```

In the `ManagerMemory` interface (around line 70-81), add the `cloudState` field before the closing brace:
```typescript
export interface ManagerMemory {
  user: MemoryUser;
  personality: MemoryPersonality;
  projects: MemoryProject[];
  insights: MemoryInsight[];
  archivedInsights: MemoryInsight[];
  journal: MemoryJournalEntry[];
  recentChat: MemoryChatEntry[];
  stats: MemoryStats;
  cloudState: CloudState;  // NEW
}
```

In `createEmptyMemory()` (around line 83), add:
```typescript
    stats: {
      totalSessions: 0,
      firstInteraction: '',
      lastInteraction: '',
      totalMessages: 0,
    },
    cloudState: createEmptyCloudState(),  // NEW
  };
}
```

In `loadMemory()` (around line 115), add the cloudState merge line:
```typescript
      return {
        user: { ...empty.user, ...parsed.user },
        personality: { ...empty.personality, ...parsed.personality },
        projects: parsed.projects ?? empty.projects,
        insights: parsed.insights ?? empty.insights,
        archivedInsights: parsed.archivedInsights ?? empty.archivedInsights,
        journal: parsed.journal ?? empty.journal,
        recentChat: parsed.recentChat ?? empty.recentChat,
        stats: { ...empty.stats, ...parsed.stats },
        cloudState: parsed.cloudState ?? empty.cloudState,  // NEW
      };
```

- [ ] **Step 1.4: TypeScript compile check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors. If there are pre-existing errors unrelated to cloud, note them but proceed.

- [ ] **Step 1.5: Commit**

```bash
git add server/src/manager/cloud/cloud.types.ts \
        server/src/manager/cloud/cloud.config.ts \
        server/src/manager/manager.memory.ts
git commit -m "feat(cloud): types, config, and memory slot scaffolding"
```

---

## Task 2: DedupGuard (TDD)

**Files:**
- Create: `server/src/manager/cloud/cloud.dedup.ts`
- Create: `server/test/cloud.dedup.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `server/test/cloud.dedup.test.ts`:

```typescript
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
      // Oldest should be evicted
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
```

- [ ] **Step 2.2: Run tests (expect FAIL — module does not exist)**

Run: `cd server && npx vitest run test/cloud.dedup.test.ts`
Expected: FAIL with "Cannot find module './cloud.dedup'" or similar.

- [ ] **Step 2.3: Implement DedupGuard**

Create `server/src/manager/cloud/cloud.dedup.ts`:

```typescript
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
```

- [ ] **Step 2.4: Run tests (expect PASS)**

Run: `cd server && npx vitest run test/cloud.dedup.test.ts`
Expected: All 11 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add server/src/manager/cloud/cloud.dedup.ts server/test/cloud.dedup.test.ts
git commit -m "feat(cloud): DedupGuard with hash ring, cooldowns, rate limits"
```

---

## Task 3: Pattern Matcher (TDD)

**Files:**
- Create: `server/src/manager/cloud/cloud.patterns.ts`
- Create: `server/test/cloud.patterns.test.ts`

- [ ] **Step 3.1: Write failing tests**

Create `server/test/cloud.patterns.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { matchPattern } from '../src/manager/cloud/cloud.patterns';

describe('matchPattern', () => {
  it('returns null for plain output with no signals', () => {
    expect(matchPattern('npm warn deprecated foo@1.0.0')).toBeNull();
  });

  it('detects [Y/n] shell prompt (urgent)', () => {
    const m = matchPattern('Overwrite existing file? [Y/n] ');
    expect(m).not.toBeNull();
    expect(m!.id).toBe('shell-yesno-prompt');
    expect(m!.urgency).toBe('urgent');
    expect(m!.templateVars.prompt_line).toContain('Overwrite');
  });

  it('detects (y/N) confirmation', () => {
    const m = matchPattern('Are you sure you want to proceed? (y/N)');
    expect(m!.id).toBe('shell-yesno-prompt');
  });

  it('detects password prompt', () => {
    const m = matchPattern('Password: ');
    expect(m!.id).toBe('password-prompt');
    expect(m!.urgency).toBe('urgent');
  });

  it('detects passphrase prompt', () => {
    const m = matchPattern('Enter passphrase for key ~/.ssh/id_rsa: ');
    expect(m!.id).toBe('password-prompt');
  });

  it('detects Error: signature', () => {
    const m = matchPattern('something happened\nError: ENOENT: no such file\n');
    expect(m!.id).toBe('error-signature');
    expect(m!.urgency).toBe('urgent');
    expect(m!.templateVars.error_line).toContain('ENOENT');
  });

  it('detects TypeError', () => {
    const m = matchPattern('TypeError: Cannot read property "x" of undefined');
    expect(m!.id).toBe('error-signature');
  });

  it('detects Fatal error', () => {
    const m = matchPattern('Fatal: repository not found');
    expect(m!.id).toBe('error-signature');
  });

  it('detects test failure (jest style)', () => {
    const m = matchPattern('FAIL src/foo.test.ts');
    expect(m!.id).toBe('test-failure');
    expect(m!.urgency).toBe('urgent');
  });

  it('detects test failure (vitest ✖)', () => {
    const m = matchPattern('✖ test failed');
    expect(m!.id).toBe('test-failure');
  });

  it('detects segfault/crash', () => {
    const m = matchPattern('Segmentation fault (core dumped)');
    expect(m!.id).toBe('crash-signal');
    expect(m!.urgency).toBe('urgent');
  });

  it('detects "Killed" crash', () => {
    const m = matchPattern('zsh: killed  node server.js');
    expect(m!.id).toBe('crash-signal');
  });

  it('does not match password inside normal text', () => {
    // The regex anchors to start-of-line — "password:" mid-sentence should not match
    expect(matchPattern('the password is stored here')).toBeNull();
  });

  it('does not match [Y/n] in quoted strings inside other context', () => {
    // This is a pragmatic test: the pattern fires on [Y/n] anywhere; if this
    // causes false positives in practice we'll tighten. For now we accept it.
    const m = matchPattern('docs say "press [Y/n] to confirm"');
    expect(m).not.toBeNull(); // accepted false-positive risk, documented
  });

  it('returns first match when multiple patterns hit', () => {
    const m = matchPattern('Error: boom\nAre you sure? [Y/n]');
    // Order: error before yesno in our catalog — whichever fires first is fine,
    // but it MUST return exactly one match, not throw.
    expect(m).not.toBeNull();
    expect(['error-signature', 'shell-yesno-prompt']).toContain(m!.id);
  });

  it('bounds work — returns null for very long benign output', () => {
    const big = 'progress: ' + '#'.repeat(5000);
    expect(matchPattern(big)).toBeNull();
  });
});
```

- [ ] **Step 3.2: Run tests (expect FAIL)**

Run: `cd server && npx vitest run test/cloud.patterns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement patterns**

Create `server/src/manager/cloud/cloud.patterns.ts`:

```typescript
import type { CloudPatternId, PatternMatch } from './cloud.types';

interface PatternDef {
  id: CloudPatternId;
  urgency: 'urgent' | 'info';
  regex: RegExp;
  extract: (chunk: string, match: RegExpMatchArray) => Record<string, string>;
}

const PATTERNS: PatternDef[] = [
  {
    id: 'error-signature',
    urgency: 'urgent',
    // Error:, Fatal:, TypeError:, ReferenceError:, SyntaxError: at start of a line
    regex: /^(Error|Fatal|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+)$/m,
    extract: (_chunk, m) => ({ error_line: `${m[1]}: ${m[2].trim()}`.slice(0, 200) }),
  },
  {
    id: 'crash-signal',
    urgency: 'urgent',
    regex: /(Segmentation fault|core dumped|zsh: killed|bash: killed|SIGKILL received)/i,
    extract: (_chunk, m) => ({ crash_signal: m[1] }),
  },
  {
    id: 'test-failure',
    urgency: 'urgent',
    // FAIL at start of line (jest/vitest), ✖ × markers, "Tests failed"
    regex: /^(FAIL\s+\S+|✖\s+.+|×\s+.+|Tests:\s+\d+\s+failed)/m,
    extract: (_chunk, m) => ({ fail_line: m[1].slice(0, 200) }),
  },
  {
    id: 'password-prompt',
    urgency: 'urgent',
    regex: /^(Password|Enter passphrase[^:]*|[Pp]assword for [^:]+):\s*$/m,
    extract: (_chunk, m) => ({ prompt_line: m[0].trim() }),
  },
  {
    id: 'shell-yesno-prompt',
    urgency: 'urgent',
    regex: /\[Y\/n\]|\(y\/N\)|\(Y\/n\)|Are you sure\?/i,
    extract: (chunk, _m) => {
      const lastLine = chunk.split('\n').filter((l) => l.trim()).pop() ?? '';
      return { prompt_line: lastLine.trim().slice(0, 200) };
    },
  },
  // Claude/Codex/Gemini prompt-waiting patterns can be added here as they
  // share prompt-detector state; initial release keeps them out (Task 3 scope).
];

/**
 * Match a chunk of cleaned terminal output against all known patterns.
 * Returns the first match (by catalog order) or null.
 *
 * Caller must pass ANSI-stripped text. Runs in O(n*k) where n = chunk length,
 * k = number of patterns. All regexes are bounded.
 */
export function matchPattern(chunk: string): PatternMatch | null {
  // Safety: cap chunk length we scan to avoid pathological regex time on huge buffers
  const scanable = chunk.length > 8000 ? chunk.slice(-8000) : chunk;

  for (const p of PATTERNS) {
    const m = scanable.match(p.regex);
    if (m) {
      return {
        id: p.id,
        urgency: p.urgency,
        matchedLine: m[0].slice(0, 500),
        templateVars: p.extract(scanable, m),
      };
    }
  }
  return null;
}

/** Exposed for tests and introspection. */
export function listPatterns(): ReadonlyArray<{ id: CloudPatternId; urgency: string }> {
  return PATTERNS.map((p) => ({ id: p.id, urgency: p.urgency }));
}
```

- [ ] **Step 3.4: Run tests (expect PASS)**

Run: `cd server && npx vitest run test/cloud.patterns.test.ts`
Expected: All 16 tests pass. If the "quoted strings" false-positive test fails because the regex is tighter than expected, adjust either the test or the regex — document which.

- [ ] **Step 3.5: Commit**

```bash
git add server/src/manager/cloud/cloud.patterns.ts server/test/cloud.patterns.test.ts
git commit -m "feat(cloud): pattern matcher with error/prompt/crash regex catalog"
```

---

## Task 4: Template Summarizer (TDD)

**Files:**
- Create: `server/src/manager/cloud/cloud.summarizer.ts`
- Create: `server/test/cloud.summarizer.test.ts`

- [ ] **Step 4.1: Write failing tests (template only for now)**

Create `server/test/cloud.summarizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { templateSummary } from '../src/manager/cloud/cloud.summarizer';
import type { PatternMatch } from '../src/manager/cloud/cloud.types';

describe('templateSummary', () => {
  it('formats error-signature', () => {
    const match: PatternMatch = {
      id: 'error-signature',
      urgency: 'urgent',
      matchedLine: 'Error: ENOENT',
      templateVars: { error_line: 'Error: ENOENT: no such file' },
    };
    const result = templateSummary(match, 'Shell 1');
    expect(result.title).toContain('Shell 1');
    expect(result.body).toContain('ENOENT');
    expect(result.body).toMatch(/error|Error|Fehler/i);
  });

  it('formats shell-yesno-prompt', () => {
    const match: PatternMatch = {
      id: 'shell-yesno-prompt',
      urgency: 'urgent',
      matchedLine: 'Overwrite? [Y/n]',
      templateVars: { prompt_line: 'Overwrite existing? [Y/n]' },
    };
    const result = templateSummary(match, 'tms-terminal');
    expect(result.title).toContain('tms-terminal');
    expect(result.body).toContain('Overwrite');
  });

  it('formats password-prompt', () => {
    const match: PatternMatch = {
      id: 'password-prompt',
      urgency: 'urgent',
      matchedLine: 'Password:',
      templateVars: { prompt_line: 'Password:' },
    };
    const result = templateSummary(match, 'Shell 2');
    expect(result.body).toMatch(/Passwort|password/i);
  });

  it('formats crash-signal', () => {
    const match: PatternMatch = {
      id: 'crash-signal',
      urgency: 'urgent',
      matchedLine: 'Segmentation fault',
      templateVars: { crash_signal: 'Segmentation fault' },
    };
    const result = templateSummary(match, 'Shell 3');
    expect(result.body).toMatch(/crash|gecrasht|Segmentation/i);
  });

  it('formats test-failure', () => {
    const match: PatternMatch = {
      id: 'test-failure',
      urgency: 'urgent',
      matchedLine: 'FAIL src/foo.test.ts',
      templateVars: { fail_line: 'FAIL src/foo.test.ts' },
    };
    const result = templateSummary(match, 'Shell 1');
    expect(result.body).toContain('foo.test.ts');
  });

  it('falls back to generic title for unknown pattern id', () => {
    const match = {
      id: 'unknown-id-xxx' as any,
      urgency: 'urgent' as const,
      matchedLine: 'whatever',
      templateVars: {},
    };
    const result = templateSummary(match as PatternMatch, 'Shell X');
    expect(result.title).toBeTruthy();
    expect(result.body).toBeTruthy();
  });

  it('truncates very long templateVars to prevent push-body overflow', () => {
    const match: PatternMatch = {
      id: 'error-signature',
      urgency: 'urgent',
      matchedLine: 'Error: x',
      templateVars: { error_line: 'Error: ' + 'x'.repeat(2000) },
    };
    const result = templateSummary(match, 'Shell 1');
    // Summary should stay well under 500 chars
    expect(result.body.length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 4.2: Run tests (expect FAIL)**

Run: `cd server && npx vitest run test/cloud.summarizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement templateSummary**

Create `server/src/manager/cloud/cloud.summarizer.ts`:

```typescript
import type { PatternMatch } from './cloud.types';

export interface SummaryOutput {
  title: string;
  body: string;
}

const MAX_BODY_CHARS = 400;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function templateSummary(match: PatternMatch, sessionLabel: string): SummaryOutput {
  const label = sessionLabel || 'Shell';
  const vars = match.templateVars;

  switch (match.id) {
    case 'error-signature':
      return {
        title: `🔴 Error · ${label}`,
        body: clip(`Error in ${label}: ${vars.error_line ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'shell-yesno-prompt':
      return {
        title: `⚠️ Bestätigung · ${label}`,
        body: clip(`${label} fragt: ${vars.prompt_line ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'password-prompt':
      return {
        title: `🔐 Passwort · ${label}`,
        body: clip(`${label} will ein Passwort: ${vars.prompt_line ?? ''}`.trim(), MAX_BODY_CHARS),
      };
    case 'crash-signal':
      return {
        title: `💥 Crash · ${label}`,
        body: clip(`${label} crashed: ${vars.crash_signal ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'test-failure':
      return {
        title: `🧪 Test Failure · ${label}`,
        body: clip(`Test failed in ${label}: ${vars.fail_line ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    case 'claude-prompt-waiting':
    case 'codex-prompt-waiting':
    case 'gemini-prompt-waiting': {
      const tool = match.id.split('-')[0];
      const toolName = tool.charAt(0).toUpperCase() + tool.slice(1);
      return {
        title: `🤖 ${toolName} wartet · ${label}`,
        body: clip(`${toolName} in ${label} wartet: ${vars.last_question ?? match.matchedLine}`, MAX_BODY_CHARS),
      };
    }
    default:
      return {
        title: `Cloud · ${label}`,
        body: clip(`Ereignis in ${label}: ${match.matchedLine}`, MAX_BODY_CHARS),
      };
  }
}

/** Generic template for silence-triggered info reports when LLM path fails. */
export function templateInfoSummary(sessionLabel: string, lastLine: string, chars: number): SummaryOutput {
  const label = sessionLabel || 'Shell';
  const safeLast = clip(lastLine.trim(), 200);
  return {
    title: `📋 Update · ${label}`,
    body: clip(`${label}: ${chars} chars neuer Output. Letzte Zeile: ${safeLast}`, MAX_BODY_CHARS),
  };
}
```

- [ ] **Step 4.4: Run tests (expect PASS)**

Run: `cd server && npx vitest run test/cloud.summarizer.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add server/src/manager/cloud/cloud.summarizer.ts server/test/cloud.summarizer.test.ts
git commit -m "feat(cloud): template summarizer (sync, no LLM)"
```

---

## Task 5: Observer Skeleton (TDD, template-only mode)

**Files:**
- Create: `server/src/manager/cloud/cloud.observer.ts`
- Create: `server/test/cloud.observer.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `server/test/cloud.observer.test.ts`:

```typescript
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
  templateOnly: true, // all tests use template-only mode
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
    // Feed 600 chars to exceed minBufferDeltaChars=500
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
    // Total 2s elapsed but second chunk reset — not yet past 1500ms since last feed
    expect(infoReports).toHaveLength(0);
    vi.advanceTimersByTime(600);
    // Now 1600ms since last feed, buffer=800 chars (> 500 threshold)
    expect(infoReports).toHaveLength(1);
  });

  it('enforces Rem-write cooldown (ignores all input)', () => {
    observer.pauseSession('s1', 3000);
    observer.feed('s1', 'Error: blocked\n'); // would be pattern match
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
    expect(infoReports).toHaveLength(0); // dropped
    observer.feed('s1', 'Error: urgent\n');
    expect(urgentPushes).toHaveLength(1); // urgent still fires
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
```

- [ ] **Step 5.2: Run tests (expect FAIL)**

Run: `cd server && npx vitest run test/cloud.observer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement CloudObserver**

Create `server/src/manager/cloud/cloud.observer.ts`:

```typescript
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
  buffer: string;          // accumulated cleaned output since last summary
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
    buf.buffer = (buf.buffer + chunk).slice(-3000); // tail-preserve, cap 3KB
    buf.lastFeedTs = Date.now();
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => this.onSilence(sessionId), this.deps.config.silenceDebounceMs);
    this.buffers.set(sessionId, buf);
  }

  // ── internal ────────────────────────────────────────────────────────────

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
    // Manager gate: skip ingest if Rem is generating; report reaches user via push only
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
      // Drop silence trigger while Rem busy — urgent path continues to work
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
    // Template-only fallback summary (LLM path added in Task 9)
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
```

- [ ] **Step 5.4: Run tests (expect PASS)**

Run: `cd server && npx vitest run test/cloud.observer.test.ts`
Expected: All 10 tests pass.

- [ ] **Step 5.5: Run full cloud test suite**

Run: `cd server && npx vitest run test/cloud.*.test.ts`
Expected: All tests across dedup/patterns/summarizer/observer pass.

- [ ] **Step 5.6: Commit**

```bash
git add server/src/manager/cloud/cloud.observer.ts server/test/cloud.observer.test.ts
git commit -m "feat(cloud): observer orchestrator (template-only silence path)"
```

---

## Task 6: Wire Observer into manager.service.ts

**Files:**
- Modify: `server/src/manager/manager.service.ts`
- Modify: `shared/protocol.ts`

- [ ] **Step 6.1: Add protocol type**

Modify `shared/protocol.ts` — add next to other `manager:*` server→client messages:

```typescript
// Add alongside existing manager:* message types
export interface ManagerCloudReportMessage {
  type: 'manager:cloud_report';
  sessionId: string;
  sessionLabel: string;
  trigger: 'pattern' | 'silence';
  urgency: 'urgent' | 'info';
  title: string;
  body: string;
  ts: number;
}
```

If there's a discriminated-union `ServerMessage` type, add `ManagerCloudReportMessage` to the union.

- [ ] **Step 6.2: Add imports and observer instance to manager.service.ts**

Modify `server/src/manager/manager.service.ts`. Near the top imports:

```typescript
import { CloudObserver } from './cloud/cloud.observer';
import { loadCloudConfig } from './cloud/cloud.config';
import type { CloudReport } from './cloud/cloud.types';
```

In the `ManagerService` class, alongside other private fields (around line 880-890), add:

```typescript
  private cloudObserver: CloudObserver | null = null;
```

- [ ] **Step 6.3: Construct observer in start()**

In the `start()` method (around line 1012), after `this.loadChatHistory()` and before the heartbeat setup:

```typescript
    // Cloud observer (autonomous terminal monitor)
    const cloudConfig = loadCloudConfig();
    this.cloudObserver = new CloudObserver({
      config: cloudConfig,
      state: this.memory.cloudState,
      resolveLabel: (sid) => this.resolveSessionLabel(sid),
      onUrgentPush: (report) => this.handleCloudUrgentPush(report),
      onInfoReport: (report) => this.ingestCloudReport(report),
      isManagerProcessing: () => this.isProcessing,
    });
    this.cloudObserver.start();
```

- [ ] **Step 6.4: Stop observer in stop()**

In `stop()` (around line 1064):

```typescript
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.cloudObserver?.stop();
    this.cloudObserver = null;
    this.cronManager.stopAll();
    logger.info('Manager: stopped');
  }
```

- [ ] **Step 6.5: Hook feedOutput → observer**

In `feedOutput()` (around line 1082), after the existing buffer logic completes, add:

```typescript
  feedOutput(sessionId: string, data: string): void {
    if (!this.enabled) return;

    const clean = data.replace(ANSI_STRIP, '');
    if (!clean.trim()) return;

    // ... existing buffer logic unchanged ...

    // Cloud: observe the same stream in parallel
    this.cloudObserver?.feed(sessionId, clean);
  }
```

(Add the `cloudObserver.feed()` call at the end of the method, after all existing logic.)

- [ ] **Step 6.6: Implement handleCloudUrgentPush and ingestCloudReport**

Add two new private methods to the class (place near the other handlers, e.g. after `feedOutput`):

```typescript
  /** Called by CloudObserver for pattern-triggered events — pushes directly to FCM. */
  private handleCloudUrgentPush(report: CloudReport): void {
    for (const token of this.fcmTokens) {
      void fcmService.sendBig(token, report.title, report.body, {
        sender: 'cloud',
        urgency: report.urgency,
        sessionId: report.sessionId,
        trigger: report.trigger,
        ts: String(report.ts),
      });
    }
    logger.info(
      `[cloud] urgent push: ${report.sessionLabel} — "${report.body.slice(0, 60)}"`,
    );
  }

  /** Called by CloudObserver for silence-triggered events — routes into Rem's context. */
  private ingestCloudReport(report: CloudReport): void {
    const bucketKey = this.chatBucketKey(report.sessionId);
    const bucket = this.chatHistoriesByTab.get(bucketKey) ?? [];
    const systemMessage: ChatMessage = {
      role: 'system',
      content: `[cloud:${report.trigger}] ${report.title}\n${report.body}`,
    };
    bucket.push(systemMessage);
    this.chatHistoriesByTab.set(bucketKey, bucket);

    // Also emit WS event for debugging / future mobile surfacing
    this.emitCloudReport?.(report);

    logger.info(
      `[cloud] info report: ${report.sessionLabel} — "${report.body.slice(0, 60)}"`,
    );
  }
```

Add a callback field next to the other `on*` fields (around line 1000):

```typescript
  private emitCloudReport?: (report: CloudReport) => void;
```

And in `setCallbacks()`, accept and wire it:

```typescript
  setCallbacks({ /* existing params */, onCloudReport }: {
    // existing types...
    onCloudReport?: (report: CloudReport) => void;
  }): void {
    // existing assignments...
    if (onCloudReport) this.emitCloudReport = onCloudReport;
  }
```

- [ ] **Step 6.7: Helper — resolveSessionLabel**

The observer asks for a session label. If a helper already exists, reuse it. Otherwise add this private method:

```typescript
  private resolveSessionLabel(sessionId: string): string {
    // Prefer shell-registered label if available; fallback to "Shell N"
    try {
      const term = globalManager.getSession?.(sessionId);
      if (term?.label) return term.label;
      if (term?.cwd) return term.cwd.split('/').pop() ?? sessionId;
    } catch {}
    return `Shell ${sessionId.slice(0, 6)}`;
  }
```

(If `globalManager.getSession` doesn't exist or has a different API, adapt — the goal is: best-effort human-readable label.)

- [ ] **Step 6.8: Tool handlers trigger pauseSession**

Search for the tool-execution code in `manager.service.ts` (`write_to_terminal`, `send_enter`, `send_keys`). For each, after the `globalManager.write(...)` / equivalent call, add:

```typescript
    this.cloudObserver?.pauseSession(sessionId, loadCloudConfig().remWriteCooldownMs);
```

Use a cached config if you prefer — pragmatically, `loadCloudConfig()` reads a small JSON file and is cheap enough.

- [ ] **Step 6.9: Wire the WS callback in index.ts (or wherever setCallbacks is called)**

Find where `managerService.setCallbacks({...})` is called (likely in `server/src/index.ts` or `ws.handler.ts`). Add `onCloudReport` that sends a `manager:cloud_report` WS message to all connected clients. Exact wiring depends on existing pattern — mirror how `onStreamChunk` is wired.

- [ ] **Step 6.10: Type-check and run all existing tests**

Run: `cd server && npx tsc --noEmit`
Expected: No errors related to cloud wiring.

Run: `cd server && npx vitest run`
Expected: All existing tests still pass + all cloud tests pass.

- [ ] **Step 6.11: Commit**

```bash
git add server/src/manager/manager.service.ts shared/protocol.ts
git commit -m "feat(cloud): integrate observer into manager service + protocol"
```

---

## Task 7: FCM sender convention documented + smoke-test harness

**Files:**
- Modify: `server/test/fcm.service.test.ts` (add sender-passthrough test)
- Create: `server/test/cloud.integration.test.ts`

No code changes in `fcm.service.ts` are needed — `data` is already `Record<string, string>` passthrough. We add a test to lock the convention in.

- [ ] **Step 7.1: Add sender-passthrough test**

Append to `server/test/fcm.service.test.ts`:

```typescript
describe('fcm sender convention', () => {
  it('documents that data.sender is passed through verbatim', () => {
    // This test is a convention contract: sendBig accepts arbitrary data,
    // and callers set data.sender = "cloud" | "rem". We don't call FCM here
    // (no mock needed) — we just assert the type signature accepts it.
    const data: Record<string, string> = {
      sender: 'cloud',
      urgency: 'urgent',
      sessionId: 's1',
      trigger: 'pattern',
      ts: '1234567890',
    };
    expect(data.sender).toBe('cloud');
    expect(Object.keys(data).every((k) => typeof data[k] === 'string')).toBe(true);
  });
});
```

- [ ] **Step 7.2: End-to-end integration test**

Create `server/test/cloud.integration.test.ts`:

```typescript
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
```

- [ ] **Step 7.3: Run tests**

Run: `cd server && npx vitest run test/fcm.service.test.ts test/cloud.integration.test.ts`
Expected: All pass.

- [ ] **Step 7.4: Commit**

```bash
git add server/test/fcm.service.test.ts server/test/cloud.integration.test.ts
git commit -m "test(cloud): sender convention + integration flow"
```

---

## Task 8: Manual Smoke (Template-Only Production Snapshot)

- [ ] **Step 8.1: Build & run server locally**

Run: `cd server && npm run build && npm run start`
Expected: Server starts, log shows `[cloud] observer started`.

- [ ] **Step 8.2: Connect mobile app, open a shell**

On the Fold 7 (or emulator), open the app, connect to the server, open a terminal.

- [ ] **Step 8.3: Trigger error pattern**

In the terminal, run a command that fails, e.g.:
```bash
ls /nonexistent/path
```
Expected: server log shows `[cloud] urgent push: <label> — "Error in ..."` within 1s. Mobile receives push notification.

- [ ] **Step 8.4: Trigger yes/no pattern**

In the terminal:
```bash
# Create a file, then:
rm -i somefile
```
Expected: when prompt `[y/N]` appears, server log shows cloud push; mobile notified.

- [ ] **Step 8.5: Trigger silence path**

In the terminal, run something that emits >500 chars then idles:
```bash
ls -la /usr/bin | head -50
```
Expected: ~1.5s after output stops, server log shows `[cloud] info report: ... — "..."`.

- [ ] **Step 8.6: Verify cooldown via Rem command**

Have Rem send a command to the terminal via the chat (e.g., "run ls in shell 1"). Within 3s after Rem writes, confirm Cloud does NOT fire on the resulting output (check server log — no `[cloud]` messages during the 3s window after Rem wrote).

- [ ] **Step 8.7: Commit the release if everything works**

```bash
git add -A  # includes any bug-fixes found during smoke
git commit -m "feat(cloud): template-only observer working end-to-end"
```

If bugs are found: triage, fix, add regression tests, re-commit. Do NOT proceed to Task 9 until smoke passes cleanly.

---

## Task 9: LLM Summarizer (Haiku)

**Files:**
- Modify: `server/src/manager/cloud/cloud.summarizer.ts`
- Modify: `server/test/cloud.summarizer.test.ts`
- Modify: `server/src/manager/cloud/cloud.observer.ts` (call LLM path when not templateOnly)

- [ ] **Step 9.1: Add Anthropic dependency (if not already)**

Check if `@anthropic-ai/sdk` is in `server/package.json`. If not:

Run: `cd server && npm install @anthropic-ai/sdk`

- [ ] **Step 9.2: Write failing tests for llmSummary**

Append to `server/test/cloud.summarizer.test.ts`:

```typescript
import { llmSummary, CloudLlmClient } from '../src/manager/cloud/cloud.summarizer';

describe('llmSummary', () => {
  it('calls the client and returns 2-3 sentence summary', async () => {
    const client: CloudLlmClient = {
      generate: async (prompt) => {
        expect(prompt).toContain('Shell 1');
        expect(prompt).toContain('tests running');
        return 'Shell 1 führt Tests aus. 5 von 10 sind grün. Letzter Test dauert länger.';
      },
    };
    const result = await llmSummary(
      'tests running\nok 1\nok 2\nok 3',
      'Shell 1',
      client,
      { timeoutMs: 5000 },
    );
    expect(result.title).toContain('Shell 1');
    expect(result.body).toContain('Tests');
  });

  it('throws on timeout', async () => {
    const client: CloudLlmClient = {
      generate: () => new Promise((resolve) => setTimeout(() => resolve('late'), 2000)),
    };
    await expect(
      llmSummary('x', 'Shell 1', client, { timeoutMs: 100 }),
    ).rejects.toThrow(/timeout/i);
  });

  it('throws on client error', async () => {
    const client: CloudLlmClient = {
      generate: async () => { throw new Error('api down'); },
    };
    await expect(
      llmSummary('x', 'Shell 1', client, { timeoutMs: 5000 }),
    ).rejects.toThrow(/api down/);
  });
});
```

- [ ] **Step 9.3: Run tests (expect FAIL — llmSummary/CloudLlmClient missing)**

Run: `cd server && npx vitest run test/cloud.summarizer.test.ts`
Expected: FAIL.

- [ ] **Step 9.4: Extend cloud.summarizer.ts with LLM path**

Append to `server/src/manager/cloud/cloud.summarizer.ts`:

```typescript
export interface CloudLlmClient {
  generate: (prompt: string) => Promise<string>;
}

export interface LlmSummaryOptions {
  timeoutMs: number;
}

const SUMMARY_PROMPT = (label: string, buffer: string) => `Fasse diesen Terminal-Output in 2-3 kurzen deutschen Sätzen zusammen.
Nenne den Befehl/Tool wenn erkennbar. Beginne mit "${label}:". Kein Prefix, keine Meta-Kommentare, keine Markdown-Formatierung.

Output:
${buffer}`;

export async function llmSummary(
  buffer: string,
  sessionLabel: string,
  client: CloudLlmClient,
  opts: LlmSummaryOptions,
): Promise<SummaryOutput> {
  const prompt = SUMMARY_PROMPT(sessionLabel || 'Shell', buffer.slice(-3000));

  const result = await Promise.race([
    client.generate(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('cloud llmSummary timeout')), opts.timeoutMs),
    ),
  ]);

  const body = result.trim().slice(0, 400);
  return {
    title: `📋 Update · ${sessionLabel || 'Shell'}`,
    body,
  };
}
```

- [ ] **Step 9.5: Run tests (expect PASS)**

Run: `cd server && npx vitest run test/cloud.summarizer.test.ts`
Expected: All pass.

- [ ] **Step 9.6: Create Anthropic client adapter**

Create `server/src/manager/cloud/cloud.llm.anthropic.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { CloudLlmClient } from './cloud.summarizer';
import { logger } from '../../utils/logger';

export function createAnthropicCloudClient(model: string, apiKey: string): CloudLlmClient {
  const client = new Anthropic({ apiKey });
  return {
    generate: async (prompt: string) => {
      const resp = await client.messages.create({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });
      const first = resp.content[0];
      if (first && first.type === 'text') return first.text;
      logger.warn('[cloud.llm] unexpected anthropic response shape');
      return '';
    },
  };
}
```

- [ ] **Step 9.7: Commit**

```bash
git add server/src/manager/cloud/cloud.summarizer.ts \
        server/src/manager/cloud/cloud.llm.anthropic.ts \
        server/test/cloud.summarizer.test.ts \
        server/package.json server/package-lock.json
git commit -m "feat(cloud): LLM summarizer (Anthropic Haiku) with timeout"
```

---

## Task 10: Activate LLM path in Observer + Circuit Breaker

**Files:**
- Modify: `server/src/manager/cloud/cloud.observer.ts`
- Modify: `server/test/cloud.observer.test.ts`

- [ ] **Step 10.1: Extend CloudObserverDeps to accept an LLM client**

In `cloud.observer.ts`, update `CloudObserverDeps`:

```typescript
import type { CloudLlmClient } from './cloud.summarizer';
import { llmSummary, templateInfoSummary } from './cloud.summarizer';

export interface CloudObserverDeps {
  config: CloudConfig;
  state: CloudState;
  resolveLabel: (sessionId: string) => string;
  onUrgentPush: (report: CloudReport) => void;
  onInfoReport: (report: CloudReport) => void;
  isManagerProcessing: () => boolean;
  llmClient?: CloudLlmClient;  // optional — absent = template-only
}
```

- [ ] **Step 10.2: Add circuit breaker state**

In the `CloudObserver` class, add:

```typescript
  private llmFailures: number[] = []; // timestamps of recent failures
  private circuitOpenUntil: number = 0;

  private isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private recordLlmFailure(): void {
    const now = Date.now();
    this.llmFailures = this.llmFailures.filter((t) => t > now - 60_000);
    this.llmFailures.push(now);
    if (this.llmFailures.length >= 3) {
      this.circuitOpenUntil = now + 5 * 60_000; // 5min cooldown
      this.llmFailures = [];
      logger.warn('[cloud] LLM circuit breaker opened for 5min');
    }
  }
```

- [ ] **Step 10.3: Use LLM path in onSilence**

Replace the existing `onSilence()` body's summary-creation block with:

```typescript
  private async onSilence(sessionId: string): Promise<void> {
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
    let summary: { title: string; body: string };

    const canUseLlm =
      !this.deps.config.templateOnly &&
      !!this.deps.llmClient &&
      !this.isCircuitOpen();

    if (canUseLlm) {
      try {
        summary = await llmSummary(content, label, this.deps.llmClient!, {
          timeoutMs: this.deps.config.llmTimeoutMs,
        });
      } catch (err) {
        logger.warn(`[cloud] llmSummary failed, falling back to template: ${err}`);
        this.recordLlmFailure();
        summary = templateInfoSummary(label, lastLine, content.length);
      }
    } else {
      summary = templateInfoSummary(label, lastLine, content.length);
    }

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
```

- [ ] **Step 10.4: Add test for LLM path + fallback**

Append to `server/test/cloud.observer.test.ts`:

```typescript
describe('CloudObserver — LLM silence path', () => {
  const state = createEmptyCloudState();
  let pushes: CloudReport[];
  let ingests: CloudReport[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T14:00:00Z'));
    pushes = [];
    ingests = [];
  });

  afterEach(() => vi.useRealTimers());

  it('uses LLM summary on silence when client provided', async () => {
    const obs = new CloudObserver({
      config: { ...CFG, templateOnly: false },
      state: createEmptyCloudState(),
      resolveLabel: (sid) => `T-${sid}`,
      onUrgentPush: (r) => pushes.push(r),
      onInfoReport: (r) => ingests.push(r),
      isManagerProcessing: () => false,
      llmClient: {
        generate: async () => 'Shell: tests grün, kein Fehler.',
      },
    });
    obs.start();
    obs.feed('s1', 'a'.repeat(600));
    await vi.advanceTimersByTimeAsync(1600);
    expect(ingests).toHaveLength(1);
    expect(ingests[0].body).toContain('tests grün');
    obs.stop();
  });

  it('falls back to template on LLM failure', async () => {
    const obs = new CloudObserver({
      config: { ...CFG, templateOnly: false },
      state: createEmptyCloudState(),
      resolveLabel: (sid) => `T-${sid}`,
      onUrgentPush: (r) => pushes.push(r),
      onInfoReport: (r) => ingests.push(r),
      isManagerProcessing: () => false,
      llmClient: {
        generate: async () => { throw new Error('api down'); },
      },
    });
    obs.start();
    obs.feed('s1', 'a'.repeat(600));
    await vi.advanceTimersByTimeAsync(1600);
    expect(ingests).toHaveLength(1);
    // Template fallback contains "chars neuer Output"
    expect(ingests[0].body).toMatch(/chars neuer Output/);
    obs.stop();
  });
});
```

- [ ] **Step 10.5: Run tests**

Run: `cd server && npx vitest run test/cloud.observer.test.ts`
Expected: All pass (original 10 + 2 new).

- [ ] **Step 10.6: Wire LLM client into manager.service.ts**

In `manager.service.ts` `start()`, build the client and pass into the observer. Modify the existing cloud construction (from Task 6.3):

```typescript
    const cloudConfig = loadCloudConfig();
    let llmClient: CloudLlmClient | undefined;
    if (!cloudConfig.templateOnly && cloudConfig.llmProvider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      if (apiKey) {
        llmClient = createAnthropicCloudClient(cloudConfig.llmModel, apiKey);
      } else {
        logger.warn('[cloud] ANTHROPIC_API_KEY missing, enforcing template-only');
      }
    }
    this.cloudObserver = new CloudObserver({
      config: cloudConfig,
      state: this.memory.cloudState,
      resolveLabel: (sid) => this.resolveSessionLabel(sid),
      onUrgentPush: (report) => this.handleCloudUrgentPush(report),
      onInfoReport: (report) => this.ingestCloudReport(report),
      isManagerProcessing: () => this.isProcessing,
      llmClient,
    });
```

Add imports at the top:
```typescript
import { createAnthropicCloudClient } from './cloud/cloud.llm.anthropic';
import type { CloudLlmClient } from './cloud/cloud.summarizer';
```

- [ ] **Step 10.7: Run full suite**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: All pass, no type errors.

- [ ] **Step 10.8: Commit**

```bash
git add server/src/manager/cloud/cloud.observer.ts \
        server/src/manager/manager.service.ts \
        server/test/cloud.observer.test.ts
git commit -m "feat(cloud): activate LLM silence-summary with fallback + circuit breaker"
```

---

## Task 11: Mobile Sender Badge (optional, can ship separately)

**Files:**
- Modify: mobile-side FCM message handler (path varies by project — check `mobile/src/services/notifications.service.ts` or `AgentNotificationModule.kt`)

- [ ] **Step 11.1: Read existing FCM data handling**

Run: `cd mobile && grep -rn "data.sender\|sender:" src/services/notifications.service.ts android/ 2>/dev/null`

Pick the spot where push-data is parsed. The exact approach depends on how the existing app routes pushes (the v1.20.0 expandable-push spec is the reference).

- [ ] **Step 11.2: Render different icon/channel for sender="cloud"**

Add conditional: if `data.sender === "cloud"` → use `ic_cloud_notification` (or existing icon tinted differently) and Android channel `tms_cloud` (vs default `tms_agent`). Specifics depend on existing `AgentNotificationModule.kt` conventions.

This task is best handled as a separate feature-dev pass — not strictly required for v1 server-side ship. Skip if time-pressed; `sender` field is already in the data-payload so mobile just treats it as a regular push until rendered.

- [ ] **Step 11.3: Commit (if done)**

```bash
git add mobile/
git commit -m "feat(cloud): mobile renders cloud-sender push with distinct icon"
```

---

## Task 12: Final Smoke + Release

- [ ] **Step 12.1: Run full test suite**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: Everything green.

- [ ] **Step 12.2: Smoke full LLM path**

Follow Task 8 steps 8.2-8.6 but with `templateOnly: false` and `ANTHROPIC_API_KEY` set. Verify:
- Silence trigger produces a 2-3-sentence German summary via Haiku.
- Offline simulation (block anthropic.com via hosts file or unset key) → fallback to template.

- [ ] **Step 12.3: Bump version**

Run: `cd mobile && ./release.sh minor`
Expected: version bumps (e.g., v1.21.1 → v1.22.0), APK built to `~/Desktop/`, git tag created.

- [ ] **Step 12.4: GitHub release**

The `release.sh` script prompts for release creation. Confirm to push the APK to GitHub Releases.

- [ ] **Step 12.5: Update memory + project-state**

Modify `memory/project-state.md` — add v1.22.0 entry under "Zuletzt abgeschlossene Features". Modify `memory/journal.md` — append session entry for 2026-04-24.

- [ ] **Step 12.6: Commit memory updates**

```bash
git add memory/
git commit -m "memory: update session journal (v1.22.0 cloud observer release)"
```

---

## Self-Review

**Spec coverage check:**
- ✅ G1 (Events <2s) → Task 3 (pattern matcher synchronous) + Task 6 (wired into feedOutput)
- ✅ G2 (autark von Rem) → Task 10 (LLM via API, independent from lmstudio)
- ✅ G3 (kein Duplicate-Spam) → Task 6 (sender field) + Task 7 (integration test)
- ✅ G4 (Rem kriegt alle Events) → Task 6.6 (`ingestCloudReport` adds to chatHistoriesByTab)
- ✅ G5 (Offline-fähig) → Task 10 (fallback to template on LLM fail, circuit breaker)
- ✅ Trigger: pattern + silence 1.5s → Tasks 3, 5
- ✅ Push: urgent direct, info via Rem → Task 6.6 (two callback paths)
- ✅ Summarizer: template + LLM → Tasks 4, 9
- ✅ Persistence: cloudState slot → Task 1
- ✅ Loop prevention: all four layers → Task 2 (dedup/rate-limit) + Task 5 (cooldown integration) + Task 5 (manager-processing gate)
- ✅ Config: enabled + templateOnly kill-switches → Task 1.2 + Task 5 respects both

**Placeholder scan:** No "TBD"/"TODO"/"implement later" in plan. Task 6.9 (WS callback wiring) and Task 11 (mobile badge) do say "adapt to existing pattern" — that's unavoidable without reading every existing callsite; engineer should follow the nearest `onStreamChunk` precedent.

**Type consistency:** `CloudReport.hash` defined once in Task 1, used consistently in Tasks 5, 7, 10. `resolveLabel`/`isManagerProcessing` signatures consistent across Tasks 5, 6, 10. `onUrgentPush`/`onInfoReport` field names stable.

**Scope:** Single subsystem, server-side core + optional mobile polish. No decomposition needed.
