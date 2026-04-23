# Expandable Push Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manager-Agent push notifications render as WhatsApp-style expandable MessagingStyle notifications (up to 800 chars), also fire when the app is killed, and skip when the user is actively viewing the chat.

**Architecture:** Server-side `sendBig()` FCM sender (data-only payload) + screen-state heartbeat tracking from mobile + debounce. Mobile native `AgentNotificationModule.kt` (already uses `NotificationCompat.MessagingStyle`) gets longer body text plus a `messageId` pass-through. Background FCM handler renders via the same native module for visual consistency across app states.

**Tech Stack:** Node.js/TypeScript (server), React Native + Expo (mobile), Kotlin (Android native module), Firebase Admin SDK + FCM, `vitest` (server tests), `jest` (mobile tests).

**Spec:** `docs/superpowers/specs/2026-04-23-expandable-push-notifications-design.md`

---

## File Structure

**Files to create:**
- `server/test/fcm.service.test.ts` — unit tests for `sendBig()` truncation + markdown stripping
- `server/test/notify-manager-reply.test.ts` — unit tests for screen-state/debounce logic (helper extracted from ws.handler)
- `server/src/notifications/manager-push.ts` — new module extracting the decision logic (stale check, debounce, message-id generation) for testability

**Files to modify:**
- `shared/protocol.ts` — add `ClientActiveScreenMessage` type + union member
- `server/src/notifications/fcm.service.ts` — add `sendBig()` method + `stripMarkdownForPush()` helper export
- `server/src/websocket/ws.handler.ts` — add `client:active_screen` handler, wire `notifyManagerReply` into `setupManagerCallbacks`
- `server/src/manager/manager.service.ts` — update `notifyTaskEvent` bodies + switch to `sendBig()`
- `server/src/watchers/watcher.service.ts` — switch to `sendBig()`
- `mobile/src/services/managerNotifications.service.ts` — expand preview 80→800, add `setChatScreenActive`, invert AppState rule
- `mobile/src/services/notifications.service.ts` — extend `registerBackgroundHandler` for data-only `manager_reply` + `task_*`
- `mobile/src/services/notifications.service.ts` — add avatar-caching helper reading from AsyncStorage
- `mobile/src/App.tsx` — add launch-extras reader after native-notification tap
- `mobile/src/screens/ManagerChatScreen.tsx` — add mount/unmount screen-state lifecycle + 10s heartbeat
- `mobile/android/app/src/main/java/com/tms/terminal/AgentNotificationModule.kt` — `show()` gains `messageId`, unique `PendingIntent` request-code, add `consumeLaunchExtras()` `@ReactMethod`

---

## Phase 1 — Protocol Types

### Task 1: Add `client:active_screen` protocol type

**Files:**
- Modify: `shared/protocol.ts` — new interface + union member

- [ ] **Step 1: Read current message union location**

Run: `grep -n "ActiveTabMessage\|export type ClientMessage" shared/protocol.ts`

Expected: `AppStateMessage` and `ActiveTabMessage` are in the `Client → Server` section; the union `ClientMessage` is at line ~184.

- [ ] **Step 2: Add interface after `ActiveTabMessage`**

Insert in `shared/protocol.ts` right after `ActiveTabMessage` definition (around line 109):

```ts
export interface ActiveScreenMessage {
  type: 'client:active_screen';
  payload: { activeScreen: 'manager_chat' | 'other'; foregrounded: boolean };
}
```

- [ ] **Step 3: Add `ActiveScreenMessage` to `ClientMessage` union**

At line ~184, add `| ActiveScreenMessage` to the union (alphabetical order inside the union isn't enforced — place it near `ActiveTabMessage`).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit code 0, no errors.

Run: `cd mobile && npx tsc --noEmit`
Expected: exit code 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(protocol): add client:active_screen message type for push screen-state tracking"
```

---

## Phase 2 — Server: `sendBig()` + Markdown Helper

### Task 2: Write failing tests for `sendBig()` truncation + markdown stripping

**Files:**
- Create: `server/test/fcm.service.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect } from 'vitest';
import { truncateForPush, stripMarkdownForPush } from '../src/notifications/fcm.service';

describe('truncateForPush', () => {
  it('returns text unchanged if below limit', () => {
    expect(truncateForPush('kurz', 800)).toEqual({ text: 'kurz', truncated: false });
  });

  it('truncates at grapheme boundary and appends suffix when over limit', () => {
    const long = 'a'.repeat(1000);
    const result = truncateForPush(long, 800);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('a'.repeat(800))).toBe(true);
    expect(result.text).toContain('… (tap to read more)');
  });

  it('does not split multi-codepoint emojis', () => {
    const text = 'a'.repeat(799) + '👨‍👩‍👧'; // family emoji = multiple codepoints
    const result = truncateForPush(text, 800);
    // Must NOT cut through the middle of the emoji
    expect(result.text).not.toMatch(/\uD83D[^\uDC68]/);
  });

  it('unicode-safe with Array.from (graphemes)', () => {
    const text = 'ä'.repeat(1000);
    const result = truncateForPush(text, 800);
    expect(Array.from(result.text.replace('\n\n… (tap to read more)', '')).length).toBe(800);
  });
});

describe('stripMarkdownForPush', () => {
  it('replaces code fences with [code]', () => {
    expect(stripMarkdownForPush('Hallo ```js\nconst x=1;\n``` weiter')).toBe('Hallo [code] weiter');
  });

  it('removes inline code backticks but keeps content', () => {
    expect(stripMarkdownForPush('Nutze `npm install`')).toBe('Nutze npm install');
  });

  it('removes bold markers', () => {
    expect(stripMarkdownForPush('Das ist **wichtig**')).toBe('Das ist wichtig');
  });

  it('removes italic markers', () => {
    expect(stripMarkdownForPush('Das ist *kursiv*')).toBe('Das ist kursiv');
  });

  it('removes header markers', () => {
    expect(stripMarkdownForPush('# Titel\n## Subtitel\nText')).toBe('Titel\nSubtitel\nText');
  });

  it('converts links to link text', () => {
    expect(stripMarkdownForPush('Siehe [Docs](https://x.com)')).toBe('Siehe Docs');
  });

  it('is idempotent for plain text', () => {
    expect(stripMarkdownForPush('plain text.')).toBe('plain text.');
  });
});
```

- [ ] **Step 2: Run test — expect failure (exports don't exist yet)**

Run: `cd server && npx vitest run test/fcm.service.test.ts`
Expected: FAIL — `truncateForPush is not a function` / `stripMarkdownForPush is not a function`.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/test/fcm.service.test.ts
git commit -m "test(fcm): add failing tests for truncation + markdown helpers"
```

---

### Task 3: Implement `truncateForPush` + `stripMarkdownForPush`

**Files:**
- Modify: `server/src/notifications/fcm.service.ts`

- [ ] **Step 1: Add helpers at top of `fcm.service.ts` (before the class)**

After the import block in `server/src/notifications/fcm.service.ts`, insert:

```ts
const TRUNCATE_SUFFIX = '\n\n… (tap to read more)';

export function truncateForPush(text: string, limit: number): { text: string; truncated: boolean } {
  const graphemes = Array.from(text);
  if (graphemes.length <= limit) return { text, truncated: false };
  const truncated = graphemes.slice(0, limit).join('') + TRUNCATE_SUFFIX;
  return { text: truncated, truncated: true };
}

export function stripMarkdownForPush(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}
```

- [ ] **Step 2: Run tests — expect pass**

Run: `cd server && npx vitest run test/fcm.service.test.ts`
Expected: all 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/notifications/fcm.service.ts
git commit -m "feat(fcm): add truncateForPush + stripMarkdownForPush helpers"
```

---

### Task 4: Add `sendBig()` method to FcmService

**Files:**
- Modify: `server/src/notifications/fcm.service.ts`

- [ ] **Step 1: Add `sendBig` method inside the `FcmService` class**

Add after the existing `send()` method:

```ts
  /**
   * Send a data-only FCM message for Big-Style rendering on the mobile client.
   * Body is truncated to 800 grapheme-count chars. Title is unchanged.
   * data payload MUST include the full `text` field so the client can render.
   */
  async sendBig(
    token: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    if (!this.ready || !this.admin) {
      logger.warn(`FCM: sendBig not ready (ready=${this.ready}, admin=${!!this.admin})`);
      return;
    }
    const { text: truncatedBody } = truncateForPush(body, 800);
    logger.info(`FCM sendBig: to ${token.slice(0, 20)}… — "${truncatedBody.slice(0, 60)}" (${truncatedBody.length} chars)`);

    try {
      // Data-only payload. Client renders via native module (Android) or expo-notifications (iOS).
      const result = await this.admin.messaging().send({
        token,
        data: {
          ...data,
          title,
          body: truncatedBody,
        },
        android: {
          priority: 'high', // required for data-only to wake the app reliably
        },
      });
      logger.success(`FCM sendBig: ✓ (${result})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`FCM sendBig: failed — ${msg}`);
      throw err; // re-throw so callers can delete stale tokens
    }
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/notifications/fcm.service.ts
git commit -m "feat(fcm): add sendBig() for data-only big-style notifications"
```

---

## Phase 3 — Server: Screen State + Debounce Logic (extracted for testability)

### Task 5: Write failing tests for push decision logic

**Files:**
- Create: `server/test/notify-manager-reply.test.ts`

- [ ] **Step 1: Write the test file**

```ts
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
```

- [ ] **Step 2: Run test — expect failure (module doesn't exist)**

Run: `cd server && npx vitest run test/notify-manager-reply.test.ts`
Expected: FAIL — `Cannot find module '../src/notifications/manager-push'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/test/notify-manager-reply.test.ts
git commit -m "test(manager-push): add failing tests for decision logic"
```

---

### Task 6: Implement `ManagerPushDecider`

**Files:**
- Create: `server/src/notifications/manager-push.ts`

- [ ] **Step 1: Create the module**

Create `server/src/notifications/manager-push.ts`:

```ts
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
```

- [ ] **Step 2: Run tests — expect pass**

Run: `cd server && npx vitest run test/notify-manager-reply.test.ts`
Expected: all 12 tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/notifications/manager-push.ts
git commit -m "feat(manager-push): add ManagerPushDecider for screen-state + debounce"
```

---

## Phase 4 — Server: Wire Into WebSocket Handler

### Task 7: Add `client:active_screen` handler + wire `ManagerPushDecider`

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`

- [ ] **Step 1: Add import at top of file**

After line 9 (`import { fcmService } from '../notifications/fcm.service';`), add:

```ts
import { ManagerPushDecider } from '../notifications/manager-push';
import { stripMarkdownForPush } from '../notifications/fcm.service';
```

- [ ] **Step 2: Create a per-connection decider inside `handleConnection`**

Find `handleConnection(ws: WebSocket, ...)` and, near the other per-connection state (close to `pendingInputLen`, `ownedSessions`, etc. — search for `const ownedSessions`), add:

```ts
const pushDecider = new ManagerPushDecider();
pushDecider.setTokensCount(persistedTokens.size);
```

Update the existing places that mutate `persistedTokens` to also call `pushDecider.setTokensCount(persistedTokens.size)` after add/delete. Search for `persistedTokens.add(` and `persistedTokens.delete(`.

- [ ] **Step 3: Add `client:active_screen` message branch**

Right after the existing `client:active_tab` handler block (currently ends at line ~680), add:

```ts
if (msgType === 'client:active_screen') {
  const { activeScreen, foregrounded } = (msg as any).payload ?? {};
  if (activeScreen === 'manager_chat' || activeScreen === 'other') {
    pushDecider.updateScreenState({ activeScreen, foregrounded: !!foregrounded });
  }
  return;
}
```

- [ ] **Step 4: Add `notifyManagerReply` helper inside `handleConnection`**

Near `watchSessionIdle` (line ~234), add:

```ts
/** Send an FCM push for a manager-agent reply, respecting screen-state + debounce. */
const notifyManagerReply = (text: string, sessionId: string = 'manager-global'): void => {
  const decision = pushDecider.shouldPush(sessionId);
  if (!decision.push) {
    logger.info(`ManagerReply push: skipped (${decision.reason})`);
    return;
  }
  pushDecider.recordPushed(sessionId);

  const agentName = managerService.personality?.agentName ?? 'Manager';
  const cleanText = stripMarkdownForPush(text || '');
  const messageId = pushDecider.generateMessageId();

  for (const token of persistedTokens) {
    fcmService.sendBig(token, `💬 ${agentName}`, cleanText, {
      type: 'manager_reply',
      agentName,
      messageId,
    }).catch(() => {
      persistedTokens.delete(token);
      pushDecider.setTokensCount(persistedTokens.size);
    });
  }
};
```

- [ ] **Step 5: Wire `notifyManagerReply` into `setupManagerCallbacks`**

Find `setupManagerCallbacks(ws)` (starts line ~107). Replace the `onStreamEnd` arrow:

```ts
// OLD:
(text, actions, phases, images, presentations) => sendManager({ type: 'manager:stream_end', payload: { text, actions, phases, images, presentations } }),
// NEW:
(text, actions, phases, images, presentations) => {
  sendManager({ type: 'manager:stream_end', payload: { text, actions, phases, images, presentations } });
  notifyManagerReply(text);
},
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit code 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(ws): wire ManagerPushDecider + client:active_screen handler + notifyManagerReply"
```

---

## Phase 5 — Server: Update Task + Watcher Notifications

### Task 8: Update `notifyTaskEvent` bodies and switch to `sendBig`

**Files:**
- Modify: `server/src/manager/manager.service.ts:3282-3299`

- [ ] **Step 1: Read current `notifyTaskEvent` implementation**

Run: `sed -n '3282,3299p' server/src/manager/manager.service.ts`
Expected: see current titles/bodies using short strings.

- [ ] **Step 2: Replace the method body**

Replace lines ~3282–3299 with:

```ts
  /** Send FCM push notification for task lifecycle events */
  private notifyTaskEvent(task: DelegatedTask, event: 'completed' | 'failed' | 'needs_input'): void {
    if (this.fcmTokens.size === 0) return;
    const titles: Record<string, string> = {
      completed:   '✅ Aufgabe fertig',
      failed:      '❌ Aufgabe fehlgeschlagen',
      needs_input: '🔔 Eingabe nötig',
    };
    const description = task.description?.trim() || '(ohne Beschreibung)';
    const bodies: Record<string, string> = {
      completed:   description,
      failed:      `${description}\n\nDie Task ist fehlgeschlagen.`,
      needs_input: `${description}\n\nDeine Eingabe wird benötigt.`,
    };
    for (const token of this.fcmTokens) {
      fcmService.sendBig(token, titles[event], bodies[event], { taskId: task.id, type: `task_${event}` })
        .catch(() => {}); // Don't crash on FCM errors
    }
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): task notifications use sendBig with full description body"
```

---

### Task 9: Switch watcher notifications to `sendBig`

**Files:**
- Modify: `server/src/watchers/watcher.service.ts:153-158`

- [ ] **Step 1: Replace `fcmService.send(...)` call**

Change:

```ts
fcmService.send(
  this.deviceToken,
  `🔔 ${typeLabel}: ${watcher.label}`,
  message,
  { watcherId: watcher.id, watcherType: watcher.type },
).catch(() => {});
```

to:

```ts
fcmService.sendBig(
  this.deviceToken,
  `🔔 ${typeLabel}: ${watcher.label}`,
  message,
  { watcherId: watcher.id, watcherType: watcher.type, type: 'watcher_alert' },
).catch(() => {});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/watchers/watcher.service.ts
git commit -m "feat(watcher): use sendBig for longer expandable alert bodies"
```

---

## Phase 6 — Mobile: Expand Preview + Screen-Active Gate

### Task 10: Update `managerNotifications.service.ts`

**Files:**
- Modify: `mobile/src/services/managerNotifications.service.ts`

- [ ] **Step 1: Add `setChatScreenActive` + flip AppState rule**

Replace the entire file body (keep imports) with:

```ts
import { AppState, NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

let _chatScreenActive = false;

export function setChatScreenActive(active: boolean): void {
  _chatScreenActive = active;
}

/** Call once at app startup to create the notification channel */
export function setupManagerNotificationChannel(): void {
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('manager-responses', {
      name: 'Manager Agent',
      description: 'Benachrichtigungen vom Manager-Agent',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
      vibrationPattern: [0, 300, 150, 300, 150, 300],
      enableVibrate: true,
    }).catch(() => {});
  }
}

function truncateForPush(text: string, limit = 800): string {
  const graphemes = Array.from(text);
  if (graphemes.length <= limit) return text;
  return graphemes.slice(0, limit).join('') + '\n\n… (tap to read more)';
}

/**
 * Render a local notification for a manager reply.
 *
 * New rule: only render when the app is foregrounded AND the user is NOT on the
 * ManagerChatScreen. When the app is backgrounded, the server sends a matching
 * FCM push instead — the background handler renders via the same native module.
 * This avoids duplicate notifications.
 */
export async function notifyManagerResponse(
  text: string,
  agentName: string,
  avatarUri?: string,
  messageId?: string,
): Promise<void> {
  try {
    if (AppState.currentState !== 'active') return; // server handles it via FCM
    if (_chatScreenActive) return;                   // user is reading the reply live

    const preview = truncateForPush(text, 800);
    const title = `💬 ${agentName}`;

    if (Platform.OS === 'android' && NativeModules.AgentNotification) {
      NativeModules.AgentNotification.show(title, preview, avatarUri ?? null, messageId ?? null);
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: preview,
        sound: 'default',
        data: { type: 'manager_reply', messageId: messageId ?? '' },
        ...(Platform.OS === 'android' ? { channelId: 'manager-responses' } : {}),
      },
      trigger: null,
    });
  } catch {
    // Permission denied or other error — silently ignore
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: exit code 0.

Note: the new rule inverts previous behavior — manager WS-handler in `TerminalScreen` already calls this function; after this change, it only renders when `AppState === 'active' && !_chatScreenActive`. Backgrounded-but-WS-alive state is now the server's job via FCM.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/services/managerNotifications.service.ts
git commit -m "feat(mobile/notifications): expand preview to 800 chars + invert AppState rule"
```

---

### Task 11: Wire `setChatScreenActive` + screen-state heartbeat into `ManagerChatScreen`

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add imports**

At the top of the file (merge with existing RN imports), ensure these are present:

```ts
import { AppState } from 'react-native';
```

Add near other service imports:

```ts
import { setChatScreenActive } from '../services/managerNotifications.service';
import { wsService } from '../services/ws.service'; // already imported as wsService elsewhere
```

Verify via: `grep -n "setChatScreenActive\|wsService" mobile/src/screens/ManagerChatScreen.tsx | head -5`.

- [ ] **Step 2: Add a new `useEffect` for screen-state + heartbeat**

Add this `useEffect` once near the top of the component body (place it with the other `useEffect` hooks, ideally right after the hooks that don't depend on it):

```tsx
useEffect(() => {
  const sendState = (foregrounded: boolean) => {
    wsService.send({
      type: 'client:active_screen',
      payload: { activeScreen: 'manager_chat', foregrounded },
    } as any);
  };

  setChatScreenActive(true);
  sendState(AppState.currentState === 'active');

  const appStateSub = AppState.addEventListener('change', (next) => {
    sendState(next === 'active');
  });

  const heartbeat = setInterval(() => {
    sendState(AppState.currentState === 'active');
  }, 10_000);

  return () => {
    setChatScreenActive(false);
    clearInterval(heartbeat);
    appStateSub.remove();
    wsService.send({
      type: 'client:active_screen',
      payload: { activeScreen: 'other', foregrounded: AppState.currentState === 'active' },
    } as any);
  };
}, []);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(mobile/chat): emit client:active_screen on mount/unmount/app-state change + 10s heartbeat"
```

---

## Phase 7 — Mobile: Native Module Changes

### Task 12: Extend `AgentNotificationModule.kt` with `messageId` + unique PendingIntent

**Files:**
- Modify: `mobile/android/app/src/main/java/com/tms/terminal/AgentNotificationModule.kt`

- [ ] **Step 1: Change `show(...)` signature to accept `messageId`**

Replace the `@ReactMethod fun show(...)` signature and body up to the PendingIntent definition with:

```kotlin
@ReactMethod
fun show(title: String, body: String, avatarUri: String?, messageId: String?) {
    ensureChannel()

    val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val agentName = title.replace("💬 ", "")

    // Launch app when tapping — extras carry navigation intent
    val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)?.apply {
        putExtra("notificationType", "manager_reply")
        if (messageId != null) putExtra("messageId", messageId)
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }

    // Unique requestCode per notification so previous extras don't leak into new taps
    val pendingIntent = PendingIntent.getActivity(
        reactContext,
        (NOTIFICATION_ID_BASE + notificationCounter),
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    // Load and crop avatar
    val avatarBitmap = loadBitmap(avatarUri)
    val circularAvatar = avatarBitmap?.let { makeCircular(it) }
```

Keep the rest of the method (MessagingStyle build) **unchanged** — it already handles long bodies via `addMessage`.

- [ ] **Step 2: Add `consumeLaunchExtras` `@ReactMethod`**

Add these imports near the top of `AgentNotificationModule.kt`:

```kotlin
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
```

Add this method to the class (e.g., right after `show(...)`):

```kotlin
@ReactMethod
fun consumeLaunchExtras(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
        promise.resolve(null)
        return
    }
    val intent = activity.intent
    val type = intent?.getStringExtra("notificationType")
    if (type == null) {
        promise.resolve(null)
        return
    }
    val messageId = intent.getStringExtra("messageId")
    val result = Arguments.createMap().apply {
        putString("notificationType", type)
        if (messageId != null) putString("messageId", messageId)
    }
    // Clear so the same tap doesn't re-trigger when React re-mounts
    intent.removeExtra("notificationType")
    intent.removeExtra("messageId")
    promise.resolve(result)
}
```

- [ ] **Step 3: Build Android debug to verify no Kotlin errors**

Run: `cd mobile/android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL. If failing, check imports (`android.content.Intent`, `com.facebook.react.bridge.Arguments`, `com.facebook.react.bridge.Promise`).

- [ ] **Step 4: Commit**

```bash
git add mobile/android/app/src/main/java/com/tms/terminal/AgentNotificationModule.kt
git commit -m "feat(android): AgentNotification.show accepts messageId + consumeLaunchExtras bridge"
```

---

## Phase 8 — Mobile: App.tsx Intent Reader + Background Handler

### Task 13: Read launch-extras in `App.tsx` and navigate

**Files:**
- Modify: `mobile/src/App.tsx`

- [ ] **Step 1: Find how other notification taps navigate**

Run: `grep -n "consumePendingNotificationTarget\|navigationRef\|navigate(" mobile/src/App.tsx | head -10`
Expected: see existing pattern using `consumePendingNotificationTarget` and a nav ref.

- [ ] **Step 2: Add a launch-extras check after `NavigationContainer` is mounted**

Near the existing `useEffect` that handles `consumePendingNotificationTarget`, add a new `useEffect`:

```tsx
useEffect(() => {
  const checkLaunchExtras = async () => {
    try {
      const extras = NativeModules.AgentNotification?.consumeLaunchExtras
        ? await NativeModules.AgentNotification.consumeLaunchExtras()
        : null;
      if (extras?.notificationType === 'manager_reply') {
        // Wait one tick so navigationRef is attached
        setTimeout(() => {
          navigationRef.current?.navigate('ManagerChat' as never);
        }, 100);
      }
    } catch {
      // native module might not be present on first install or iOS
    }
  };
  checkLaunchExtras();
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') checkLaunchExtras();
  });
  return () => sub.remove();
}, []);
```

Ensure `NativeModules` is imported at the top:

```tsx
import { NativeModules, AppState } from 'react-native';
```

(Adjust the existing imports — `AppState` is likely already imported.)

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/App.tsx
git commit -m "feat(mobile/app): read AgentNotification launch extras and navigate to ManagerChat"
```

---

### Task 14: Extend `registerBackgroundHandler` for data-only `manager_reply` + `task_*`

**Files:**
- Modify: `mobile/src/services/notifications.service.ts`

- [ ] **Step 1: Add helper to read cached avatar from AsyncStorage**

At the top of `mobile/src/services/notifications.service.ts`, import AsyncStorage:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
```

Add this helper near the bottom of the file (before exports):

```ts
const AVATAR_CACHE_KEY = 'manager.agentAvatarUri';

export async function cacheAvatarUri(uri: string | null): Promise<void> {
  try {
    if (uri) await AsyncStorage.setItem(AVATAR_CACHE_KEY, uri);
    else await AsyncStorage.removeItem(AVATAR_CACHE_KEY);
  } catch { /* ignore */ }
}

async function readCachedAvatarUri(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(AVATAR_CACHE_KEY);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Replace `registerBackgroundHandler`**

Replace the existing function body:

```ts
export function registerBackgroundHandler(): void {
  messaging().setBackgroundMessageHandler(async (message) => {
    const type = typeof message.data?.type === 'string' ? message.data.type : '';

    if (type === 'manager_reply') {
      const title = String(message.data?.title ?? '💬 Manager');
      const body = String(message.data?.body ?? '');
      const messageId = String(message.data?.messageId ?? '');
      const avatarUri = await readCachedAvatarUri();

      if (Platform.OS === 'android' && NativeModules.AgentNotification) {
        NativeModules.AgentNotification.show(title, body, avatarUri ?? null, messageId || null);
        return;
      }
      // Fallback: expo-notifications
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { type: 'manager_reply', messageId },
          ...(Platform.OS === 'android' ? { channelId: 'manager-responses' } : {}),
        },
        trigger: null,
      });
      return;
    }

    if (type.startsWith('task_')) {
      const title = String(message.data?.title ?? '');
      const body = String(message.data?.body ?? '');
      const taskId = String(message.data?.taskId ?? '');
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { type, taskId },
          ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
        },
        trigger: null,
      });
      return;
    }

    if (type === 'watcher_alert') {
      const title = String(message.data?.title ?? '🔔 Watcher');
      const body = String(message.data?.body ?? '');
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: message.data as Record<string, string>,
          ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
        },
        trigger: null,
      });
      return;
    }

    // Fallback for any legacy notification-shaped message
  });
}
```

Add `NativeModules` import at the top if not already present:

```ts
import { NativeModules, PermissionsAndroid, Platform, AppState } from 'react-native';
```

- [ ] **Step 3: Update `registerForegroundHandler` to handle data-only messages the same way**

Replace the foreground handler body to branch on `data.type` the same way, using the same rendering paths. The existing handler currently reads `remoteMessage.notification?.title` — since the server now sends data-only, we must read from `data`:

```ts
export function registerForegroundHandler(): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    const type = typeof remoteMessage.data?.type === 'string' ? remoteMessage.data.type : '';

    if (type === 'manager_reply') {
      const title = String(remoteMessage.data?.title ?? '💬 Manager');
      const body = String(remoteMessage.data?.body ?? '');
      const messageId = String(remoteMessage.data?.messageId ?? '');
      const avatarUri = await readCachedAvatarUri();
      if (Platform.OS === 'android' && NativeModules.AgentNotification) {
        NativeModules.AgentNotification.show(title, body, avatarUri ?? null, messageId || null);
        return;
      }
    }

    const title = String(remoteMessage.data?.title ?? remoteMessage.notification?.title ?? '💤 Terminal');
    const body = String(remoteMessage.data?.body ?? remoteMessage.notification?.body ?? '');
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(remoteMessage.data ?? {})) {
      if (typeof v === 'string') data[k] = v;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        data,
        ...(Platform.OS === 'android' ? { channelId: 'terminal-prompts' } : {}),
      },
      trigger: null,
    });
  });
}
```

- [ ] **Step 4: Call `cacheAvatarUri` whenever the agent avatar changes**

First, find the exact file + line where `agentAvatarUri` is written:

```bash
grep -rn "agentAvatarUri" mobile/src/stores mobile/src/App.tsx --include="*.ts" --include="*.tsx"
```

Expected: you find the manager store `setPersonality` (or similar) setter that updates `agentAvatarUri`.

In that setter, add at the top of the file:

```ts
import { cacheAvatarUri } from '../services/notifications.service';
```

And right after the state update in the setter, add:

```ts
void cacheAvatarUri(payload.agentAvatarUri ?? null);
```

(Adjust the reference `payload.agentAvatarUri` to match the actual local variable name in the setter — check the few lines above.)

Additionally, call it once on app launch so the cache is populated even when the avatar was set in a previous session. In `mobile/src/App.tsx`, add inside an existing top-level `useEffect` (or a new one that runs once on mount):

```ts
const currentAvatar = useManagerStore.getState().personality?.agentAvatarUri ?? null;
void cacheAvatarUri(currentAvatar);
```

Ensure `cacheAvatarUri` is imported at the top of `App.tsx`:

```ts
import { cacheAvatarUri } from './services/notifications.service';
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/services/notifications.service.ts mobile/src/stores/manager.store.ts mobile/src/App.tsx
git commit -m "feat(mobile/notifications): handle data-only FCM for manager_reply + task_* + cache avatar"
```

---

## Phase 9 — Manual QA on Device

### Task 15: Release build + install on Samsung Galaxy Fold 7

**Files:** none

- [ ] **Step 1: Make sure server is running with latest changes**

```bash
cd server && npm run build && tms-terminal restart
```

Expected: server logs show `FCM: Push notifications enabled ✓`.

- [ ] **Step 2: Build and install mobile debug APK via USB**

```bash
cd mobile && ./deploy.sh adb
```

Expected: app installs; FCM token is registered in server logs.

- [ ] **Step 3: Run the test plan matrix from spec**

Go through each scenario and mark PASS/FAIL in a scratch notepad:

| # | Szenario | Erwartung |
|---|----------|-----------|
| 1 | App offen, ManagerChatScreen aktiv, Manager antwortet (500 chars) | Keine Push |
| 2 | App offen, TerminalScreen, Manager antwortet (500 chars) | 1 lokale Push, ausklappbar, voller Text |
| 3 | App offen, TerminalScreen, Manager antwortet (1500 chars) | Push zeigt 800 chars + Suffix, Tap → Chat |
| 4 | App gebackgrounded, Manager antwortet | 1 FCM-Push via native Modul |
| 5 | App gekillt, Manager antwortet | 1 FCM-Push via Background-Handler, Tap öffnet App + Chat |
| 6 | App gekillt → reconnect nach 10s, 2 Replies dazwischen | Max 2 Pushes, mit 3s-Debounce-Gap |
| 7 | Task completed (kurze Desc) | Titel `✅ Aufgabe fertig`, Body = Desc, ausklappbar |
| 8 | Task failed (lange Desc) | Body zeigt Desc + Zusatzzeile |
| 9 | 3 Replies in 1s | Max 1 Push (Debounce) |
| 10 | Text mit Markdown (`**bold**`, Code-Fences) | Push zeigt plain text |
| 11 | Tap auf Manager-Push | Navigiert zu ManagerChatScreen |
| 12 | Tap auf Task-Push | Navigiert zum Terminal |
| 13 | Push-Tap während App offen auf Chat | No-op |
| 14 | WS offline > 15s (Airplane-Mode 16s), dann Reply | Server sendet FCM via Stale-Detection |

- [ ] **Step 4: Fix any regressions**

If a scenario fails, diagnose and fix. Re-run that scenario.

---

## Phase 10 — Release

### Task 16: Bump mobile version + release APK

**Files:** none

- [ ] **Step 1: Release patch version**

```bash
cd mobile && ./release.sh
```

Expected: version bumped (e.g., 1.19.0 → 1.19.1), APK copied to `~/Desktop/TMS-Terminal-v1.19.1.apk`, prompted to create GitHub Release.

- [ ] **Step 2: Create GitHub Release when prompted**

Confirm with `y` — `gh release create` publishes the APK so in-app auto-updater picks it up on next launch.

- [ ] **Step 3: Update memory**

Update `memory/project-state.md`:
- Bump current version
- Add to "Zuletzt abgeschlossene Features": "Ausklappbare Manager-Push-Benachrichtigungen (WhatsApp-Style)"

Update `memory/journal.md` with a new entry dated today:
- Feature delivered: expandable push notifications
- Files touched: spec, plan, server (fcm, ws, manager, watcher, manager-push), mobile (managerNotifications, notifications, ManagerChatScreen, App.tsx, AgentNotificationModule.kt)

- [ ] **Step 4: Commit memory**

```bash
git add memory/project-state.md memory/journal.md
git commit -m "memory: update after expandable-push-notifications release"
```

---

## Spec Coverage Check

- **Goal: 800-char body** → Task 3 (`truncateForPush`), Task 10 (mobile truncation)
- **Skip when on ManagerChatScreen** → Task 6 (decider), Task 7 (wiring), Task 10 (`_chatScreenActive`)
- **Works when app killed** → Task 14 (`registerBackgroundHandler` for `manager_reply`)
- **Server FCM push new** → Task 7 (`notifyManagerReply` + wiring)
- **Screen-state heartbeat** → Task 11 (10s `setInterval` + `AppState` listener)
- **15s stale threshold** → Task 6 (`staleThresholdMs`)
- **3s debounce** → Task 6 (`debounceMs`)
- **Markdown stripping** → Task 3 (`stripMarkdownForPush`), Task 7 (calls it)
- **MessagingStyle preserved + avatar** → Task 12 (native module unchanged style; adds `messageId` + unique PendingIntent)
- **Task bodies use description** → Task 8
- **Watcher uses sendBig** → Task 9
- **Tap → navigate to Chat** → Task 12 (`consumeLaunchExtras`) + Task 13 (App.tsx reader)
- **No duplicate push (local vs FCM)** → Task 10 (inverts local-handler rule: only when `active && !chatActive`)
- **Avatar available to background handler** → Task 14 (`cacheAvatarUri` via AsyncStorage)
- **Out-of-scope: scroll-to-messageId, iOS parity, reply-from-notif** → not included (by design)
