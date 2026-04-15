# Chrome Remote Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote-control the PC's Google Chrome from the TMS Terminal mobile app via Chrome DevTools Protocol (CDP), streaming live JPEG frames and forwarding touch/keyboard input.

**Architecture:** The TMS server connects to Chrome via CDP on localhost:9222 and bridges everything to the mobile app over the existing WebSocket. The app renders screencast frames as `<Image>` and translates touch events into CDP input commands. Adaptive quality switches between low/high based on interaction state.

**Tech Stack:** `chrome-remote-interface` (CDP client), `chrome-launcher` (Chrome lifecycle), React Native `<Image>` + PanResponder (frame rendering + touch), Zustand (state), existing WebSocket infrastructure.

**Design Spec:** `docs/superpowers/specs/2026-04-15-chrome-remote-control-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `shared/protocol.ts` | (modify) Add `chrome:*` message interfaces + union members |
| `server/src/chrome/chrome.manager.ts` | CDP connection lifecycle, screencast streaming, Chrome launch/detect |
| `server/src/chrome/chrome.input.ts` | Translate app touch/key events → CDP `Input.dispatch*` calls |
| `server/src/chrome/chrome.tabs.ts` | Tab polling, new/closed/updated tab detection, tab switching |
| `server/src/chrome/chrome.types.ts` | TypeScript interfaces for Chrome sessions, config, events |
| `mobile/src/store/chromeRemoteStore.ts` | Zustand store: connection state, tabs, active tab, frame, quality |
| `mobile/src/components/ChromeRemoteView.tsx` | Frame rendering, touch capture, coordinate mapping, keyboard input |
| `mobile/src/components/ChromeConnectScreen.tsx` | Connection UI: "Verbinden" button, status, errors |

### Modified Files

| File | Change |
|------|--------|
| `shared/protocol.ts` | Add 12 client→server + 6 server→client chrome message types |
| `server/package.json` | Add `chrome-remote-interface`, `chrome-launcher` |
| `server/src/websocket/ws.handler.ts` | Add `chrome:*` message routing block (before main switch) |
| `mobile/src/components/BrowserPanel.tsx` | Integrate remote tabs in tab bar, render ChromeRemoteView for remote tabs |

---

## Task 1: Protocol Types

**Files:**
- Modify: `shared/protocol.ts`

- [ ] **Step 1: Add Chrome client→server message interfaces**

Insert after `ActiveTabMessage` (line 111), before the `ClientMessage` union (line 113):

```typescript
// ── Chrome Remote Control (Client → Server) ─────────────────────
export interface ChromeConnectMessage {
  type: 'chrome:connect';
}
export interface ChromeDisconnectMessage {
  type: 'chrome:disconnect';
}
export interface ChromeInputMessage {
  type: 'chrome:input';
  payload: {
    action: 'click' | 'dblclick' | 'scroll' | 'key';
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    key?: string;
    code?: string;
    text?: string;
    modifiers?: number;
  };
}
export interface ChromeNavigateMessage {
  type: 'chrome:navigate';
  payload: { url: string };
}
export interface ChromeTabSwitchMessage {
  type: 'chrome:tab:switch';
  payload: { targetId: string };
}
export interface ChromeTabOpenMessage {
  type: 'chrome:tab:open';
  payload: { url?: string };
}
export interface ChromeTabCloseMessage {
  type: 'chrome:tab:close';
  payload: { targetId: string };
}
export interface ChromeQualityMessage {
  type: 'chrome:quality';
  payload: { quality: number; maxFps: number };
}
export interface ChromePauseMessage {
  type: 'chrome:pause';
}
export interface ChromeResumeMessage {
  type: 'chrome:resume';
}
export interface ChromeResizeMessage {
  type: 'chrome:resize';
  payload: { width: number; height: number };
}
export interface ChromeGoBackMessage {
  type: 'chrome:back';
}
export interface ChromeGoForwardMessage {
  type: 'chrome:forward';
}
export interface ChromeReloadMessage {
  type: 'chrome:reload';
}
```

- [ ] **Step 2: Add chrome types to ClientMessage union**

Add to the `ClientMessage` union (after `ActiveTabMessage` at line 140):

```typescript
  | ChromeConnectMessage
  | ChromeDisconnectMessage
  | ChromeInputMessage
  | ChromeNavigateMessage
  | ChromeTabSwitchMessage
  | ChromeTabOpenMessage
  | ChromeTabCloseMessage
  | ChromeQualityMessage
  | ChromePauseMessage
  | ChromeResumeMessage
  | ChromeResizeMessage
  | ChromeGoBackMessage
  | ChromeGoForwardMessage
  | ChromeReloadMessage;
```

- [ ] **Step 3: Add Chrome server→client message interfaces**

Insert before the `ServerMessage` union (before line 341):

```typescript
// ── Chrome Remote Control (Server → Client) ─────────────────────
export interface ChromeStatusMessage {
  type: 'chrome:status';
  payload: {
    state: 'connected' | 'disconnected' | 'not-found' | 'busy' | 'connecting';
    reason?: string;
    activeClient?: string;
  };
}
export interface ChromeFrameMessage {
  type: 'chrome:frame';
  payload: {
    data: string;
    width: number;
    height: number;
    timestamp: number;
  };
}
export interface ChromeTabsMessage {
  type: 'chrome:tabs';
  payload: {
    tabs: Array<{ targetId: string; title: string; url: string; faviconUrl?: string }>;
    activeTargetId?: string;
  };
}
export interface ChromeTabCreatedMessage {
  type: 'chrome:tab:created';
  payload: { targetId: string; title: string; url: string };
}
export interface ChromeTabRemovedMessage {
  type: 'chrome:tab:removed';
  payload: { targetId: string };
}
export interface ChromeTabUpdatedMessage {
  type: 'chrome:tab:updated';
  payload: { targetId: string; title?: string; url?: string };
}
```

- [ ] **Step 4: Add chrome types to ServerMessage union**

Add to the `ServerMessage` union (after `ManagerStreamEndMessage` at line 366):

```typescript
  | ChromeStatusMessage
  | ChromeFrameMessage
  | ChromeTabsMessage
  | ChromeTabCreatedMessage
  | ChromeTabRemovedMessage
  | ChromeTabUpdatedMessage;
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(chrome): add chrome remote control protocol messages"
```

---

## Task 2: Server Dependencies

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install chrome-remote-interface and chrome-launcher**

```bash
cd server && npm install chrome-remote-interface chrome-launcher
```

- [ ] **Step 2: Install type definitions**

```bash
cd server && npm install -D @types/chrome-remote-interface
```

Note: `chrome-launcher` ships its own types. `chrome-remote-interface` has community types.

- [ ] **Step 3: Verify build still works**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "feat(chrome): add CDP and chrome-launcher dependencies"
```

---

## Task 3: Chrome Types

**Files:**
- Create: `server/src/chrome/chrome.types.ts`

- [ ] **Step 1: Create the types file**

```typescript
import type CDP from 'chrome-remote-interface';

export interface ChromeSession {
  /** CDP client connection */
  client: CDP.Client;
  /** Port Chrome is running on */
  port: number;
  /** Whether we launched Chrome (vs. connected to existing) */
  launched: boolean;
  /** Chrome launcher instance (only if we launched it) */
  launcher?: import('chrome-launcher').LaunchedChrome;
  /** Currently active target (tab) ID */
  activeTargetId: string | null;
  /** Whether screencast is currently running */
  screencastActive: boolean;
  /** Current screencast quality settings */
  quality: QualitySettings;
  /** Current viewport dimensions */
  viewport: { width: number; height: number };
}

export interface QualitySettings {
  quality: number;
  maxFps: number;
}

export interface ChromeTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

/** Quality presets for adaptive streaming */
export const QUALITY_PRESETS = {
  interaction: { quality: 40, maxFps: 20 } as QualitySettings,
  idle:        { quality: 80, maxFps: 5 } as QualitySettings,
  still:       { quality: 95, maxFps: 1 } as QualitySettings,
  slow:        { quality: 30, maxFps: 10 } as QualitySettings,
} as const;

/** Adaptive quality thresholds */
export const QUALITY_TIMERS = {
  /** ms after last interaction → switch to idle quality */
  idleThreshold: 1500,
  /** ms after last interaction → send one high-quality still frame */
  stillThreshold: 3000,
} as const;

/** CDP port range to try */
export const CDP_PORT_MIN = 9222;
export const CDP_PORT_MAX = 9232;

/** Tab polling interval in ms */
export const TAB_POLL_INTERVAL = 2000;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/chrome/chrome.types.ts
git commit -m "feat(chrome): add Chrome session types and quality presets"
```

---

## Task 4: Chrome Input Handler

**Files:**
- Create: `server/src/chrome/chrome.input.ts`

- [ ] **Step 1: Create the input handler**

```typescript
import type CDP from 'chrome-remote-interface';
import { logger } from '../utils/logger';

/**
 * Translates mobile app touch/keyboard events into CDP Input.dispatch* calls.
 * Coordinate mapping: caller must pre-scale (x, y) to Chrome viewport coordinates.
 */

export async function dispatchClick(
  client: CDP.Client,
  x: number,
  y: number,
): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } catch (err) {
    logger.warn(`[chrome:input] click failed: ${err}`);
  }
}

export async function dispatchDoubleClick(
  client: CDP.Client,
  x: number,
  y: number,
): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
  } catch (err) {
    logger.warn(`[chrome:input] dblclick failed: ${err}`);
  }
}

export async function dispatchRightClick(
  client: CDP.Client,
  x: number,
  y: number,
): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  } catch (err) {
    logger.warn(`[chrome:input] right-click failed: ${err}`);
  }
}

export async function dispatchScroll(
  client: CDP.Client,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  } catch (err) {
    logger.warn(`[chrome:input] scroll failed: ${err}`);
  }
}

export async function dispatchKey(
  client: CDP.Client,
  key: string,
  code: string,
  text?: string,
  modifiers?: number,
): Promise<void> {
  try {
    await client.Input.dispatchKeyEvent({
      type: 'keyDown',
      key,
      code,
      text: text || '',
      windowsVirtualKeyCode: getVirtualKeyCode(key),
      modifiers: modifiers || 0,
    });
    await client.Input.dispatchKeyEvent({
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: getVirtualKeyCode(key),
      modifiers: modifiers || 0,
    });
  } catch (err) {
    logger.warn(`[chrome:input] key failed: ${err}`);
  }
}

/**
 * Scale touch coordinates from mobile viewport to Chrome viewport.
 * Mobile sends (x, y) relative to its rendered frame dimensions.
 * Chrome expects coordinates in its actual viewport space.
 */
export function scaleCoordinates(
  mobileX: number,
  mobileY: number,
  mobileWidth: number,
  mobileHeight: number,
  chromeWidth: number,
  chromeHeight: number,
): { x: number; y: number } {
  return {
    x: Math.round((mobileX / mobileWidth) * chromeWidth),
    y: Math.round((mobileY / mobileHeight) * chromeHeight),
  };
}

/** Map common key names to Windows virtual key codes for CDP */
function getVirtualKeyCode(key: string): number {
  const map: Record<string, number> = {
    'Enter': 13, 'Tab': 9, 'Backspace': 8, 'Escape': 27, 'Delete': 46,
    'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
    'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34,
    ' ': 32,
  };
  // Single printable character → its char code
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return map[key] || 0;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/chrome/chrome.input.ts
git commit -m "feat(chrome): add CDP input dispatcher (click, scroll, key)"
```

---

## Task 5: Chrome Tab Watcher

**Files:**
- Create: `server/src/chrome/chrome.tabs.ts`

- [ ] **Step 1: Create the tab watcher**

```typescript
import type CDP from 'chrome-remote-interface';
import { ChromeTab, TAB_POLL_INTERVAL } from './chrome.types';
import { logger } from '../utils/logger';

type TabCallback = (event: TabEvent) => void;

export type TabEvent =
  | { type: 'created'; tab: ChromeTab }
  | { type: 'removed'; targetId: string }
  | { type: 'updated'; targetId: string; title?: string; url?: string };

export class ChromeTabWatcher {
  private knownTabs = new Map<string, ChromeTab>();
  private pollTimer: NodeJS.Timeout | null = null;
  private callback: TabCallback | null = null;

  constructor(private client: CDP.Client) {}

  /** Start polling for tab changes. */
  start(callback: TabCallback): void {
    this.callback = callback;
    this.pollTimer = setInterval(() => this.poll(), TAB_POLL_INTERVAL);
    // Initial poll
    this.poll();
  }

  /** Stop polling. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.callback = null;
    this.knownTabs.clear();
  }

  /** Get current tab list. */
  getTabs(): ChromeTab[] {
    return Array.from(this.knownTabs.values());
  }

  private async poll(): Promise<void> {
    try {
      const targets = await this.client.Target.getTargets();
      const pageTabs = targets.targetInfos.filter(
        (t: any) => t.type === 'page' && !t.url.startsWith('devtools://'),
      );

      const currentIds = new Set<string>();

      for (const target of pageTabs) {
        currentIds.add(target.targetId);
        const existing = this.knownTabs.get(target.targetId);

        if (!existing) {
          // New tab
          const tab: ChromeTab = {
            targetId: target.targetId,
            title: target.title,
            url: target.url,
          };
          this.knownTabs.set(target.targetId, tab);
          this.callback?.({ type: 'created', tab });
        } else {
          // Check for updates
          const titleChanged = existing.title !== target.title;
          const urlChanged = existing.url !== target.url;
          if (titleChanged || urlChanged) {
            existing.title = target.title;
            existing.url = target.url;
            this.callback?.({
              type: 'updated',
              targetId: target.targetId,
              title: titleChanged ? target.title : undefined,
              url: urlChanged ? target.url : undefined,
            });
          }
        }
      }

      // Detect removed tabs
      for (const [targetId] of this.knownTabs) {
        if (!currentIds.has(targetId)) {
          this.knownTabs.delete(targetId);
          this.callback?.({ type: 'removed', targetId });
        }
      }
    } catch (err) {
      logger.warn(`[chrome:tabs] poll failed: ${err}`);
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/chrome/chrome.tabs.ts
git commit -m "feat(chrome): add tab watcher with polling and change detection"
```

---

## Task 6: Chrome Manager

**Files:**
- Create: `server/src/chrome/chrome.manager.ts`

This is the core component — manages the CDP connection, screencast, and coordinates input + tabs.

- [ ] **Step 1: Create the Chrome manager**

```typescript
import CDP from 'chrome-remote-interface';
import * as chromeLauncher from 'chrome-launcher';
import { ChromeSession, QualitySettings, QUALITY_PRESETS, QUALITY_TIMERS, CDP_PORT_MIN, CDP_PORT_MAX } from './chrome.types';
import { ChromeTabWatcher, TabEvent } from './chrome.tabs';
import { dispatchClick, dispatchDoubleClick, dispatchScroll, dispatchKey, scaleCoordinates } from './chrome.input';
import { logger } from '../utils/logger';
import * as net from 'net';

type FrameCallback = (data: string, width: number, height: number, timestamp: number) => void;
type StatusCallback = (state: string, reason?: string) => void;
type TabEventCallback = (event: TabEvent) => void;
type TabsListCallback = (tabs: Array<{ targetId: string; title: string; url: string; faviconUrl?: string }>, activeTargetId?: string) => void;

export class ChromeManager {
  private session: ChromeSession | null = null;
  private tabWatcher: ChromeTabWatcher | null = null;
  private qualityTimer: NodeJS.Timeout | null = null;
  private lastInteraction = 0;
  private qualityState: 'interaction' | 'idle' | 'still' = 'idle';
  private paused = false;

  // Callbacks set by ws.handler
  public onFrame: FrameCallback | null = null;
  public onStatus: StatusCallback | null = null;
  public onTabEvent: TabEventCallback | null = null;
  public onTabsList: TabsListCallback | null = null;

  /** The mobile viewport dimensions (for coordinate scaling) */
  private mobileViewport = { width: 0, height: 0 };

  get isConnected(): boolean {
    return this.session !== null;
  }

  /** Connect to Chrome — auto-detect or launch. */
  async connect(): Promise<void> {
    if (this.session) {
      this.onStatus?.('connected');
      return;
    }

    this.onStatus?.('connecting');

    try {
      // Try to find an already-running Chrome with debug port
      const port = await this.findDebugPort();

      if (port) {
        logger.info(`[chrome] Found existing Chrome on port ${port}`);
        await this.connectToPort(port, false);
      } else {
        logger.info('[chrome] No Chrome with debug port found, launching...');
        const result = await this.launchChrome();
        await this.connectToPort(result.port, true, result.launcher);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[chrome] Connection failed: ${msg}`);
      this.onStatus?.('not-found', msg);
    }
  }

  /** Disconnect from Chrome. Chrome stays open. */
  async disconnect(): Promise<void> {
    await this.stopScreencast();
    this.tabWatcher?.stop();
    this.tabWatcher = null;
    this.stopQualityTimer();

    if (this.session) {
      try {
        await this.session.client.close();
      } catch { /* ignore */ }
      this.session = null;
    }

    this.onStatus?.('disconnected');
    logger.info('[chrome] Disconnected');
  }

  /** Start screencast on the currently active tab. */
  async startScreencast(viewport?: { width: number; height: number }): Promise<void> {
    if (!this.session || this.session.screencastActive) return;

    const { client, quality } = this.session;

    if (viewport) {
      this.session.viewport = viewport;
      await client.Emulation.setDeviceMetricsOverride({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    client.Page.screencastFrame(async (params: any) => {
      if (this.paused) return;

      // Acknowledge frame to keep receiving
      try {
        await client.Page.screencastFrameAck({ sessionId: params.sessionId });
      } catch { /* tab might have closed */ }

      this.onFrame?.(
        params.data,
        params.metadata.pageScaleFactor ? Math.round(params.metadata.deviceWidth) : this.session!.viewport.width,
        params.metadata.pageScaleFactor ? Math.round(params.metadata.deviceHeight) : this.session!.viewport.height,
        Date.now(),
      );
    });

    await client.Page.startScreencast({
      format: 'jpeg',
      quality: quality.quality,
      maxWidth: this.session.viewport.width,
      maxHeight: this.session.viewport.height,
      everyNthFrame: 1,
    });

    this.session.screencastActive = true;
    this.startQualityTimer();
    logger.info(`[chrome] Screencast started (${this.session.viewport.width}x${this.session.viewport.height}, q=${quality.quality})`);
  }

  /** Stop screencast. */
  async stopScreencast(): Promise<void> {
    if (!this.session?.screencastActive) return;
    try {
      await this.session.client.Page.stopScreencast();
    } catch { /* ignore */ }
    this.session.screencastActive = false;
    this.stopQualityTimer();
  }

  /** Pause frame delivery (app backgrounded). */
  pause(): void {
    this.paused = true;
  }

  /** Resume frame delivery (app foregrounded). */
  resume(): void {
    this.paused = false;
  }

  /** Handle input from mobile app. */
  async handleInput(action: string, payload: any): Promise<void> {
    if (!this.session) return;
    const { client } = this.session;

    this.lastInteraction = Date.now();
    this.setQualityState('interaction');

    // Scale coordinates if present
    let x = payload.x ?? 0;
    let y = payload.y ?? 0;
    if (payload.x !== undefined && this.mobileViewport.width > 0) {
      const scaled = scaleCoordinates(
        payload.x, payload.y,
        this.mobileViewport.width, this.mobileViewport.height,
        this.session.viewport.width, this.session.viewport.height,
      );
      x = scaled.x;
      y = scaled.y;
    }

    switch (action) {
      case 'click':
        await dispatchClick(client, x, y);
        break;
      case 'dblclick':
        await dispatchDoubleClick(client, x, y);
        break;
      case 'scroll':
        await dispatchScroll(client, x, y, payload.deltaX ?? 0, payload.deltaY ?? 0);
        break;
      case 'key':
        await dispatchKey(client, payload.key ?? '', payload.code ?? '', payload.text, payload.modifiers);
        break;
    }
  }

  /** Navigate to URL on active tab. */
  async navigate(url: string): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Page.navigate({ url });
    } catch (err) {
      logger.warn(`[chrome] navigate failed: ${err}`);
    }
  }

  /** Go back in history. */
  async goBack(): Promise<void> {
    if (!this.session) return;
    try {
      const { currentIndex, entries } = await this.session.client.Page.getNavigationHistory();
      if (currentIndex > 0) {
        await this.session.client.Page.navigateToHistoryEntry({ entryId: entries[currentIndex - 1].id });
      }
    } catch (err) {
      logger.warn(`[chrome] goBack failed: ${err}`);
    }
  }

  /** Go forward in history. */
  async goForward(): Promise<void> {
    if (!this.session) return;
    try {
      const { currentIndex, entries } = await this.session.client.Page.getNavigationHistory();
      if (currentIndex < entries.length - 1) {
        await this.session.client.Page.navigateToHistoryEntry({ entryId: entries[currentIndex + 1].id });
      }
    } catch (err) {
      logger.warn(`[chrome] goForward failed: ${err}`);
    }
  }

  /** Reload page. */
  async reload(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Page.reload();
    } catch (err) {
      logger.warn(`[chrome] reload failed: ${err}`);
    }
  }

  /** Switch to a different tab. Restarts screencast on the new tab. */
  async switchTab(targetId: string): Promise<void> {
    if (!this.session) return;

    try {
      await this.stopScreencast();

      // Activate tab in Chrome
      await this.session.client.Target.activateTarget({ targetId });

      // Re-attach to the new tab by creating a new CDP client for it
      const newClient = await CDP({ port: this.session.port, target: targetId });
      await this.session.client.close();

      this.session.client = newClient;
      this.session.activeTargetId = targetId;

      // Enable required domains on new client
      await newClient.Page.enable();
      await newClient.Input.enable?.().catch(() => {});

      // Restart screencast
      await this.startScreencast();

      // Send updated tab list
      this.sendTabsList();
    } catch (err) {
      logger.warn(`[chrome] switchTab failed: ${err}`);
    }
  }

  /** Open a new tab. */
  async openTab(url?: string): Promise<void> {
    if (!this.session) return;
    try {
      const { targetId } = await this.session.client.Target.createTarget({
        url: url || 'about:blank',
      });
      // Switch to the new tab
      await this.switchTab(targetId);
    } catch (err) {
      logger.warn(`[chrome] openTab failed: ${err}`);
    }
  }

  /** Close a tab. */
  async closeTab(targetId: string): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Target.closeTarget({ targetId });
      // If we closed the active tab, switch to another
      if (this.session.activeTargetId === targetId) {
        const tabs = this.tabWatcher?.getTabs() ?? [];
        const remaining = tabs.filter(t => t.targetId !== targetId);
        if (remaining.length > 0) {
          await this.switchTab(remaining[0].targetId);
        }
      }
    } catch (err) {
      logger.warn(`[chrome] closeTab failed: ${err}`);
    }
  }

  /** Resize Chrome viewport (Fold open/close). */
  async resize(width: number, height: number): Promise<void> {
    if (!this.session) return;
    this.session.viewport = { width, height };
    try {
      await this.session.client.Emulation.setDeviceMetricsOverride({
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      // Restart screencast with new dimensions
      if (this.session.screencastActive) {
        await this.stopScreencast();
        await this.startScreencast();
      }
    } catch (err) {
      logger.warn(`[chrome] resize failed: ${err}`);
    }
  }

  /** Set the mobile viewport dimensions (for coordinate scaling). */
  setMobileViewport(width: number, height: number): void {
    this.mobileViewport = { width, height };
  }

  /** Override quality settings. */
  async setQuality(quality: number, maxFps: number): Promise<void> {
    if (!this.session) return;
    this.session.quality = { quality, maxFps };
    // Apply by restarting screencast
    if (this.session.screencastActive) {
      await this.stopScreencast();
      await this.startScreencast();
    }
  }

  // ── Private methods ────────────────────────────────────────────

  private async findDebugPort(): Promise<number | null> {
    for (let port = CDP_PORT_MIN; port <= CDP_PORT_MAX; port++) {
      if (await this.isPortOpen(port)) {
        // Verify it's actually a CDP endpoint
        try {
          const info = await CDP.Version({ port });
          if (info['WebSocket-Debugger-Url'] || info.webSocketDebuggerUrl) {
            return port;
          }
        } catch { /* not CDP */ }
      }
    }
    return null;
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, '127.0.0.1');
    });
  }

  private async launchChrome(): Promise<{ port: number; launcher: chromeLauncher.LaunchedChrome }> {
    const port = await this.findFreePort();
    const launcher = await chromeLauncher.launch({
      chromeFlags: [
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      // Don't use headless — user wants real Chrome with their profiles
    });
    // Wait a moment for Chrome to initialize CDP
    await new Promise(r => setTimeout(r, 1000));
    return { port, launcher };
  }

  private async findFreePort(): Promise<number> {
    for (let port = CDP_PORT_MIN; port <= CDP_PORT_MAX; port++) {
      if (!(await this.isPortOpen(port))) return port;
    }
    throw new Error(`All CDP ports ${CDP_PORT_MIN}-${CDP_PORT_MAX} are in use`);
  }

  private async connectToPort(
    port: number,
    launched: boolean,
    launcher?: chromeLauncher.LaunchedChrome,
  ): Promise<void> {
    const targets = await CDP.List({ port });
    const pageTarget = targets.find((t: any) => t.type === 'page');

    if (!pageTarget) {
      throw new Error('No page target found in Chrome');
    }

    const client = await CDP({ port, target: pageTarget.id });

    await client.Page.enable();
    await client.Target.setDiscoverTargets({ discover: true });
    await client.Input.enable?.().catch(() => {});

    this.session = {
      client,
      port,
      launched,
      launcher,
      activeTargetId: pageTarget.id,
      screencastActive: false,
      quality: QUALITY_PRESETS.idle,
      viewport: { width: 900, height: 1200 },
    };

    // Set up tab watcher
    this.tabWatcher = new ChromeTabWatcher(client);
    this.tabWatcher.start((event) => {
      this.onTabEvent?.(event);
    });

    // Handle Chrome disconnect
    client.on('disconnect', () => {
      logger.warn('[chrome] CDP connection lost');
      this.session = null;
      this.tabWatcher?.stop();
      this.tabWatcher = null;
      this.stopQualityTimer();
      this.onStatus?.('disconnected', 'chrome-closed');

      // Try to reconnect after 10s
      setTimeout(async () => {
        if (!this.session) {
          try {
            const newPort = await this.findDebugPort();
            if (newPort) {
              await this.connectToPort(newPort, false);
              this.onStatus?.('connected');
              await this.startScreencast();
              this.sendTabsList();
            }
          } catch { /* give up */ }
        }
      }, 10_000);
    });

    this.onStatus?.('connected');

    // Send initial tab list
    setTimeout(() => this.sendTabsList(), 500);
  }

  private sendTabsList(): void {
    const tabs = this.tabWatcher?.getTabs() ?? [];
    this.onTabsList?.(tabs, this.session?.activeTargetId ?? undefined);
  }

  private startQualityTimer(): void {
    this.stopQualityTimer();
    this.qualityTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastInteraction;

      if (this.qualityState === 'interaction' && elapsed >= QUALITY_TIMERS.idleThreshold) {
        this.setQualityState('idle');
      } else if (this.qualityState === 'idle' && elapsed >= QUALITY_TIMERS.stillThreshold) {
        this.setQualityState('still');
      }
    }, 500);
  }

  private stopQualityTimer(): void {
    if (this.qualityTimer) {
      clearInterval(this.qualityTimer);
      this.qualityTimer = null;
    }
  }

  private async setQualityState(state: 'interaction' | 'idle' | 'still'): Promise<void> {
    if (this.qualityState === state) return;
    this.qualityState = state;

    if (!this.session?.screencastActive) return;

    const preset = QUALITY_PRESETS[state];
    this.session.quality = preset;

    // Restart screencast with new quality
    try {
      await this.session.client.Page.stopScreencast();
      await this.session.client.Page.startScreencast({
        format: 'jpeg',
        quality: preset.quality,
        maxWidth: this.session.viewport.width,
        maxHeight: this.session.viewport.height,
        everyNthFrame: state === 'still' ? 30 : 1, // still = very infrequent
      });
    } catch (err) {
      logger.warn(`[chrome] quality switch failed: ${err}`);
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors (may need to adjust CDP type imports based on actual type definitions)

- [ ] **Step 3: Commit**

```bash
git add server/src/chrome/chrome.manager.ts
git commit -m "feat(chrome): add ChromeManager with CDP screencast, input, and tab management"
```

---

## Task 7: WebSocket Handler Integration

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`

- [ ] **Step 1: Add import**

Add after the existing imports (after line 17):

```typescript
import { ChromeManager } from '../chrome/chrome.manager';
```

- [ ] **Step 2: Add ChromeManager instance and cleanup**

Inside the `handleConnection` function, where `managerService` and other per-connection state is set up, add:

```typescript
const chromeManager = new ChromeManager();
```

And in the connection close handler, add:

```typescript
chromeManager.disconnect();
```

- [ ] **Step 3: Add chrome:* message routing**

Add the following block after the TTS handler (after line 708, before `switch (msg.type)`):

```typescript
    // ── Chrome Remote Control ──────────────────────────────────────
    if (msgType === 'chrome:connect') {
      chromeManager.onFrame = (data, width, height, timestamp) => {
        send(ws, { type: 'chrome:frame', payload: { data, width, height, timestamp } } as any);
      };
      chromeManager.onStatus = (state, reason) => {
        send(ws, { type: 'chrome:status', payload: { state, reason } } as any);
      };
      chromeManager.onTabEvent = (event) => {
        if (event.type === 'created') {
          send(ws, { type: 'chrome:tab:created', payload: event.tab } as any);
        } else if (event.type === 'removed') {
          send(ws, { type: 'chrome:tab:removed', payload: { targetId: event.targetId } } as any);
        } else if (event.type === 'updated') {
          send(ws, { type: 'chrome:tab:updated', payload: { targetId: event.targetId, title: event.title, url: event.url } } as any);
        }
      };
      chromeManager.onTabsList = (tabs, activeTargetId) => {
        send(ws, { type: 'chrome:tabs', payload: { tabs, activeTargetId } } as any);
      };
      chromeManager.connect().then(() => {
        chromeManager.startScreencast();
      });
      return;
    }

    if (msgType === 'chrome:disconnect') {
      chromeManager.disconnect();
      return;
    }

    if (msgType === 'chrome:input') {
      const p = (msg as any).payload ?? {};
      chromeManager.handleInput(p.action, p);
      return;
    }

    if (msgType === 'chrome:navigate') {
      const { url } = (msg as any).payload ?? {};
      if (url && typeof url === 'string') chromeManager.navigate(url);
      return;
    }

    if (msgType === 'chrome:tab:switch') {
      const { targetId } = (msg as any).payload ?? {};
      if (targetId) chromeManager.switchTab(targetId);
      return;
    }

    if (msgType === 'chrome:tab:open') {
      const { url } = (msg as any).payload ?? {};
      chromeManager.openTab(url);
      return;
    }

    if (msgType === 'chrome:tab:close') {
      const { targetId } = (msg as any).payload ?? {};
      if (targetId) chromeManager.closeTab(targetId);
      return;
    }

    if (msgType === 'chrome:quality') {
      const { quality, maxFps } = (msg as any).payload ?? {};
      if (typeof quality === 'number' && typeof maxFps === 'number') {
        chromeManager.setQuality(quality, maxFps);
      }
      return;
    }

    if (msgType === 'chrome:pause') {
      chromeManager.pause();
      return;
    }

    if (msgType === 'chrome:resume') {
      chromeManager.resume();
      return;
    }

    if (msgType === 'chrome:resize') {
      const { width, height } = (msg as any).payload ?? {};
      if (typeof width === 'number' && typeof height === 'number') {
        chromeManager.setMobileViewport(width, height);
        const chromeWidth = width < 400 ? 375 : width < 700 ? 600 : Math.max(900, width);
        const chromeHeight = Math.round(chromeWidth * 1.5);
        chromeManager.resize(chromeWidth, chromeHeight);
      }
      return;
    }

    if (msgType === 'chrome:back') {
      chromeManager.goBack();
      return;
    }

    if (msgType === 'chrome:forward') {
      chromeManager.goForward();
      return;
    }

    if (msgType === 'chrome:reload') {
      chromeManager.reload();
      return;
    }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Test Chrome connection manually**

1. Start Chrome with: `open -a "Google Chrome" --args --remote-debugging-port=9222`
2. Start TMS server: `cd server && npm run dev`
3. Verify server log shows no errors related to chrome imports

- [ ] **Step 6: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(chrome): integrate chrome remote control into WebSocket handler"
```

---

## Task 8: Mobile — Chrome Remote Store

**Files:**
- Create: `mobile/src/store/chromeRemoteStore.ts`

- [ ] **Step 1: Create the Zustand store**

```typescript
import { create } from 'zustand';

export interface ChromeTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

export type ChromeConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'not-found';

interface ChromeRemoteState {
  /** Connection status per server */
  status: Record<string, ChromeConnectionStatus>;
  /** Error message per server */
  error: Record<string, string | null>;
  /** Chrome tabs per server */
  tabs: Record<string, ChromeTab[]>;
  /** Active tab targetId per server */
  activeTargetId: Record<string, string | null>;
  /** Current frame per server (base64 JPEG) */
  frame: Record<string, { data: string; width: number; height: number } | null>;
  /** Quality info per server */
  quality: Record<string, { level: string; value: number; fps: number }>;
  /** Frame latency per server */
  latency: Record<string, number>;

  // Actions
  setStatus: (serverId: string, status: ChromeConnectionStatus, error?: string) => void;
  setTabs: (serverId: string, tabs: ChromeTab[], activeTargetId?: string) => void;
  addTab: (serverId: string, tab: ChromeTab) => void;
  removeTab: (serverId: string, targetId: string) => void;
  updateTab: (serverId: string, targetId: string, updates: Partial<Pick<ChromeTab, 'title' | 'url'>>) => void;
  setActiveTarget: (serverId: string, targetId: string) => void;
  setFrame: (serverId: string, data: string, width: number, height: number) => void;
  setLatency: (serverId: string, latency: number) => void;
  clear: (serverId: string) => void;
}

export const useChromeRemoteStore = create<ChromeRemoteState>((set, get) => ({
  status: {},
  error: {},
  tabs: {},
  activeTargetId: {},
  frame: {},
  quality: {},
  latency: {},

  setStatus(serverId, status, error) {
    const state = get();
    set({
      status: { ...state.status, [serverId]: status },
      error: { ...state.error, [serverId]: error ?? null },
    });
  },

  setTabs(serverId, tabs, activeTargetId) {
    const state = get();
    set({
      tabs: { ...state.tabs, [serverId]: tabs },
      ...(activeTargetId ? { activeTargetId: { ...state.activeTargetId, [serverId]: activeTargetId } } : {}),
    });
  },

  addTab(serverId, tab) {
    const state = get();
    const existing = state.tabs[serverId] ?? [];
    set({ tabs: { ...state.tabs, [serverId]: [...existing, tab] } });
  },

  removeTab(serverId, targetId) {
    const state = get();
    const existing = state.tabs[serverId] ?? [];
    set({ tabs: { ...state.tabs, [serverId]: existing.filter(t => t.targetId !== targetId) } });
  },

  updateTab(serverId, targetId, updates) {
    const state = get();
    const existing = state.tabs[serverId] ?? [];
    set({
      tabs: {
        ...state.tabs,
        [serverId]: existing.map(t => t.targetId === targetId ? { ...t, ...updates } : t),
      },
    });
  },

  setActiveTarget(serverId, targetId) {
    const state = get();
    set({ activeTargetId: { ...state.activeTargetId, [serverId]: targetId } });
  },

  setFrame(serverId, data, width, height) {
    const state = get();
    set({ frame: { ...state.frame, [serverId]: { data, width, height } } });
  },

  setLatency(serverId, latency) {
    const state = get();
    set({ latency: { ...state.latency, [serverId]: latency } });
  },

  clear(serverId) {
    const state = get();
    const { [serverId]: _s, ...restStatus } = state.status;
    const { [serverId]: _e, ...restError } = state.error;
    const { [serverId]: _t, ...restTabs } = state.tabs;
    const { [serverId]: _a, ...restActive } = state.activeTargetId;
    const { [serverId]: _f, ...restFrame } = state.frame;
    const { [serverId]: _q, ...restQuality } = state.quality;
    const { [serverId]: _l, ...restLatency } = state.latency;
    set({
      status: restStatus,
      error: restError,
      tabs: restTabs,
      activeTargetId: restActive,
      frame: restFrame,
      quality: restQuality,
      latency: restLatency,
    });
  },
}));
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add mobile/src/store/chromeRemoteStore.ts
git commit -m "feat(chrome): add Zustand store for Chrome remote state"
```

---

## Task 9: Mobile — ChromeConnectScreen

**Files:**
- Create: `mobile/src/components/ChromeConnectScreen.tsx`

- [ ] **Step 1: Create the connect screen component**

```tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useResponsive } from '../hooks/useResponsive';
import { useChromeRemoteStore, ChromeConnectionStatus } from '../store/chromeRemoteStore';

interface Props {
  serverId: string;
  onConnect: () => void;
}

export function ChromeConnectScreen({ serverId, onConnect }: Props) {
  const { rf, rs } = useResponsive();
  const status = useChromeRemoteStore(s => s.status[serverId] ?? 'disconnected');
  const error = useChromeRemoteStore(s => s.error[serverId]);
  const isConnecting = status === 'connecting';

  return (
    <View style={styles.container}>
      <Text style={[styles.icon, { fontSize: rf(48) }]}>🖥️</Text>
      <Text style={[styles.title, { fontSize: rf(16) }]}>PC Chrome verbinden</Text>
      <Text style={[styles.subtitle, { fontSize: rf(13), marginHorizontal: rs(32) }]}>
        Steuere Google Chrome auf deinem PC direkt von hier aus.
      </Text>

      {error && (
        <View style={[styles.errorBox, { marginTop: rs(12), paddingHorizontal: rs(16), paddingVertical: rs(8) }]}>
          <Text style={[styles.errorText, { fontSize: rf(12) }]}>{error}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, { marginTop: rs(20), paddingHorizontal: rs(24), paddingVertical: rs(10) }]}
        onPress={onConnect}
        disabled={isConnecting}
      >
        {isConnecting ? (
          <ActivityIndicator size="small" color="#000" />
        ) : (
          <Text style={[styles.buttonText, { fontSize: rf(14) }]}>Verbinden</Text>
        )}
      </TouchableOpacity>

      <Text style={[styles.hint, { fontSize: rf(11), marginTop: rs(8) }]}>
        Chrome wird bei Bedarf automatisch gestartet
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a2e',
  },
  icon: {
    marginBottom: 12,
  },
  title: {
    color: '#e0e0e0',
    fontWeight: '500',
    marginBottom: 8,
  },
  subtitle: {
    color: '#778899',
    textAlign: 'center',
    lineHeight: 20,
  },
  errorBox: {
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },
  errorText: {
    color: '#ef4444',
  },
  button: {
    backgroundColor: '#4fc3f7',
    borderRadius: 8,
  },
  buttonText: {
    color: '#000',
    fontWeight: '600',
  },
  hint: {
    color: '#556677',
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/ChromeConnectScreen.tsx
git commit -m "feat(chrome): add ChromeConnectScreen component"
```

---

## Task 10: Mobile — ChromeRemoteView

**Files:**
- Create: `mobile/src/components/ChromeRemoteView.tsx`

This is the main component that renders screencast frames and captures touch input.

- [ ] **Step 1: Create the remote view component**

```tsx
import React, { useCallback, useRef, useMemo } from 'react';
import {
  View,
  Image,
  StyleSheet,
  TextInput,
  GestureResponderEvent,
  LayoutChangeEvent,
  Text,
} from 'react-native';
import { useChromeRemoteStore } from '../store/chromeRemoteStore';
import { useResponsive } from '../hooks/useResponsive';

interface Props {
  serverId: string;
  onInput: (action: string, payload: Record<string, any>) => void;
}

const DOUBLE_TAP_THRESHOLD = 300;
const LONG_PRESS_THRESHOLD = 500;

export function ChromeRemoteView({ serverId, onInput }: Props) {
  const { rf, isCompact } = useResponsive();
  const frame = useChromeRemoteStore(s => s.frame[serverId]);
  const status = useChromeRemoteStore(s => s.status[serverId]);
  const latency = useChromeRemoteStore(s => s.latency[serverId] ?? 0);

  const viewSize = useRef({ width: 0, height: 0 });
  const lastTap = useRef(0);
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const keyboardRef = useRef<TextInput>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewSize.current = { width, height };
  }, []);

  const getRelativeCoords = useCallback((e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    return {
      x: locationX,
      y: locationY,
      viewWidth: viewSize.current.width,
      viewHeight: viewSize.current.height,
    };
  }, []);

  const handleTouchStart = useCallback((e: GestureResponderEvent) => {
    const coords = getRelativeCoords(e);

    // Long press detection
    longPressTimer.current = setTimeout(() => {
      // Long press = right click
      onInput('click', { ...coords, button: 'right' });
      longPressTimer.current = null;
    }, LONG_PRESS_THRESHOLD);
  }, [getRelativeCoords, onInput]);

  const handleTouchEnd = useCallback((e: GestureResponderEvent) => {
    // Cancel long press
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    } else {
      // Long press already fired, don't send click
      return;
    }

    const coords = getRelativeCoords(e);
    const now = Date.now();

    if (now - lastTap.current < DOUBLE_TAP_THRESHOLD) {
      // Double tap
      onInput('dblclick', coords);
      lastTap.current = 0;
    } else {
      // Single tap
      onInput('click', coords);
      lastTap.current = now;
    }

    // Focus keyboard input
    keyboardRef.current?.focus();
  }, [getRelativeCoords, onInput]);

  // Scroll handling via responder
  const scrollStart = useRef({ x: 0, y: 0 });

  const handleMoveStart = useCallback((e: GestureResponderEvent) => {
    // Cancel long press on move
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    scrollStart.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
  }, []);

  const handleMove = useCallback((e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const deltaX = scrollStart.current.x - locationX;
    const deltaY = scrollStart.current.y - locationY;
    scrollStart.current = { x: locationX, y: locationY };

    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      onInput('scroll', {
        x: locationX,
        y: locationY,
        deltaX: deltaX * 2,
        deltaY: deltaY * 2,
        viewWidth: viewSize.current.width,
        viewHeight: viewSize.current.height,
      });
    }
  }, [onInput]);

  // Keyboard input
  const handleKeyInput = useCallback((text: string) => {
    if (!text) return;
    for (const char of text) {
      onInput('key', { key: char, code: `Key${char.toUpperCase()}`, text: char });
    }
  }, [onInput]);

  const handleKeyPress = useCallback((e: any) => {
    const { key } = e.nativeEvent;
    if (key === 'Enter') onInput('key', { key: 'Enter', code: 'Enter' });
    else if (key === 'Backspace') onInput('key', { key: 'Backspace', code: 'Backspace' });
    else if (key === 'Tab') onInput('key', { key: 'Tab', code: 'Tab' });
  }, [onInput]);

  const frameUri = useMemo(() => {
    if (!frame?.data) return null;
    return `data:image/jpeg;base64,${frame.data}`;
  }, [frame?.data]);

  if (status !== 'connected' || !frameUri) {
    return (
      <View style={styles.loading}>
        <Text style={[styles.loadingText, { fontSize: rf(13) }]}>Warte auf Frame...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      <Image
        source={{ uri: frameUri }}
        style={styles.frame}
        resizeMode="contain"
      />

      {/* Touch capture overlay */}
      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={handleTouchStart}
        onResponderMove={handleMove}
        onResponderRelease={handleTouchEnd}
      />

      {/* Hidden keyboard input */}
      <TextInput
        ref={keyboardRef}
        style={styles.hiddenInput}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={handleKeyInput}
        onKeyPress={handleKeyPress}
        value=""
        blurOnSubmit={false}
      />

      {/* Quality/Latency badge */}
      <View style={[styles.badge, isCompact ? styles.badgeCompact : styles.badgeExpanded]}>
        <Text style={[styles.badgeText, { fontSize: rf(isCompact ? 9 : 11) }]}>
          {isCompact ? `${latency}ms` : `HD · ${latency}ms`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  frame: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a2e',
  },
  loadingText: {
    color: '#778899',
  },
  hiddenInput: {
    position: 'absolute',
    top: -100,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
  },
  badgeCompact: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeExpanded: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    color: '#4fc3f7',
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/ChromeRemoteView.tsx
git commit -m "feat(chrome): add ChromeRemoteView with frame rendering and touch input"
```

---

## Task 11: Mobile — BrowserPanel Integration

**Files:**
- Modify: `mobile/src/components/BrowserPanel.tsx`

This task wires ChromeRemoteView and ChromeConnectScreen into the existing BrowserPanel. The exact line numbers depend on the state of BrowserPanel at this point, so this task describes what to change rather than exact line-for-line edits.

- [ ] **Step 1: Add imports**

Add at the top of BrowserPanel.tsx:

```typescript
import { useChromeRemoteStore } from '../store/chromeRemoteStore';
import { ChromeRemoteView } from './ChromeRemoteView';
import { ChromeConnectScreen } from './ChromeConnectScreen';
```

- [ ] **Step 2: Add Chrome state hooks**

Inside the BrowserPanel component, alongside existing store hooks:

```typescript
const chromeStatus = useChromeRemoteStore(s => s.status[serverId] ?? 'disconnected');
const chromeTabs = useChromeRemoteStore(s => s.tabs[serverId] ?? []);
const chromeActiveTarget = useChromeRemoteStore(s => s.activeTargetId[serverId]);
```

- [ ] **Step 3: Add WebSocket message handler for chrome:* messages**

Set up a message listener that routes incoming `chrome:*` messages to the store. Add inside a `useEffect`:

```typescript
useEffect(() => {
  const store = useChromeRemoteStore.getState();
  const unsub = wsService.addMessageListener((msg: any) => {
    if (msg.type === 'chrome:status') {
      store.setStatus(serverId, msg.payload.state, msg.payload.reason);
    } else if (msg.type === 'chrome:frame') {
      store.setFrame(serverId, msg.payload.data, msg.payload.width, msg.payload.height);
      store.setLatency(serverId, Date.now() - msg.payload.timestamp);
    } else if (msg.type === 'chrome:tabs') {
      store.setTabs(serverId, msg.payload.tabs, msg.payload.activeTargetId);
    } else if (msg.type === 'chrome:tab:created') {
      store.addTab(serverId, msg.payload);
    } else if (msg.type === 'chrome:tab:removed') {
      store.removeTab(serverId, msg.payload.targetId);
    } else if (msg.type === 'chrome:tab:updated') {
      store.updateTab(serverId, msg.payload.targetId, msg.payload);
    }
  });
  return unsub;
}, [serverId]);
```

- [ ] **Step 4: Add Chrome tab items to the tab bar**

In the tab bar render section, after the local browser tabs, add remote Chrome tabs:

```tsx
{/* Remote Chrome tabs */}
{chromeTabs.map(tab => (
  <TouchableOpacity
    key={`chrome-${tab.targetId}`}
    style={[
      styles.tab,
      chromeActiveTarget === tab.targetId && activeTab?.id === undefined && styles.tabActive,
    ]}
    onPress={() => {
      wsService.send({ type: 'chrome:tab:switch', payload: { targetId: tab.targetId } } as any);
      useChromeRemoteStore.getState().setActiveTarget(serverId, tab.targetId);
    }}
    onLongPress={() => {
      wsService.send({ type: 'chrome:tab:close', payload: { targetId: tab.targetId } } as any);
    }}
  >
    <Text style={styles.tabIcon}>🖥️</Text>
    <Text style={[styles.tabLabel, { color: '#4fc3f7' }]} numberOfLines={1}>
      {isCompact ? getDomain(tab.url) : `${getDomain(tab.url)} — ${tab.title}`}
    </Text>
  </TouchableOpacity>
))}
```

Helper function (add outside component):

```typescript
function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}
```

- [ ] **Step 5: Render ChromeRemoteView or ChromeConnectScreen**

In the main content area, add a condition: if a Chrome tab is selected, render ChromeRemoteView; if Chrome is disconnected and user wants to connect, show ChromeConnectScreen:

```tsx
{/* Chrome Remote content */}
{chromeActiveTarget && chromeStatus === 'connected' ? (
  <ChromeRemoteView
    serverId={serverId}
    onInput={(action, payload) => {
      wsService.send({ type: 'chrome:input', payload: { action, ...payload } } as any);
    }}
  />
) : chromeStatus !== 'connected' && chromeTabs.length === 0 ? (
  <ChromeConnectScreen
    serverId={serverId}
    onConnect={() => {
      wsService.send({ type: 'chrome:connect' } as any);
    }}
  />
) : null}
```

- [ ] **Step 6: Add resize handler for Fold open/close**

Send `chrome:resize` when screen dimensions change:

```typescript
useEffect(() => {
  if (chromeStatus === 'connected') {
    wsService.send({ type: 'chrome:resize', payload: { width, height } } as any);
  }
}, [width, height, chromeStatus]);
```

- [ ] **Step 7: Add app state handling (pause/resume)**

When app goes to background, pause screencast:

```typescript
useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (chromeStatus !== 'connected') return;
    if (state === 'background' || state === 'inactive') {
      wsService.send({ type: 'chrome:pause' } as any);
    } else if (state === 'active') {
      wsService.send({ type: 'chrome:resume' } as any);
    }
  });
  return () => sub.remove();
}, [chromeStatus]);
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add mobile/src/components/BrowserPanel.tsx
git commit -m "feat(chrome): integrate Chrome remote tabs into BrowserPanel"
```

---

## Task 12: End-to-End Integration Test

- [ ] **Step 1: Start Chrome with debug port**

```bash
open -a "Google Chrome" --args --remote-debugging-port=9222
```

- [ ] **Step 2: Build and start server**

```bash
cd server && npm run build && npm start
```

Verify log: no errors, chrome modules imported successfully.

- [ ] **Step 3: Build mobile app**

```bash
cd mobile && ./deploy.sh
```

Install APK on Fold 7.

- [ ] **Step 4: Test connection flow**

1. Open app → go to Browser panel
2. Tap "PC Chrome verbinden"
3. Verify: Status changes to "connected"
4. Verify: Chrome tabs appear in tab bar with 🖥️ icons
5. Verify: Live screencast frame renders

- [ ] **Step 5: Test interaction**

1. Tap on a link in the screencast → Chrome navigates
2. Scroll by swiping → page scrolls
3. Tap in a text field → keyboard appears → type → text appears in Chrome
4. Long press → right-click context menu appears in Chrome

- [ ] **Step 6: Test tab management**

1. Tap "+" to open new Chrome tab → new tab appears
2. Switch between Chrome tabs → screencast updates
3. Long-press a Chrome tab to close it

- [ ] **Step 7: Test responsive (Fold open/close)**

1. Close the Fold → UI adapts to compact
2. Open the Fold → UI adapts to expanded
3. Verify Chrome viewport resizes accordingly (page re-renders)

- [ ] **Step 8: Test error handling**

1. Close Chrome on PC → App shows "Chrome wurde geschlossen" + reconnect button
2. Disconnect Tailscale briefly → App shows connection lost, recovers on reconnect

- [ ] **Step 9: Final commit and version bump**

```bash
git add -A
git commit -m "feat(chrome): Chrome Remote Control — complete integration"
```

Then use `release.sh` for version bump and GitHub release.
