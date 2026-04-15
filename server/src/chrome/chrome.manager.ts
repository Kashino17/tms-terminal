import * as net from 'net';
import * as chromeLauncher from 'chrome-launcher';
import { logger } from '../utils/logger';
import {
  ChromeSession,
  ChromeTab,
  QUALITY_PRESETS,
  QUALITY_TIMERS,
  CDP_PORT_MIN,
  CDP_PORT_MAX,
} from './chrome.types';
import {
  dispatchClick,
  dispatchDoubleClick,
  dispatchRightClick,
  dispatchScroll,
  dispatchKey,
  scaleCoordinates,
} from './chrome.input';
import { ChromeTabWatcher, TabEvent } from './chrome.tabs';

// chrome-remote-interface has no TypeScript types — use require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CDP = require('chrome-remote-interface');

const RECONNECT_DELAY_MS = 10_000;
const QUALITY_CHECK_INTERVAL_MS = 500;

export class ChromeManager {
  // ── State ──────────────────────────────────────────────────────────────
  private session: ChromeSession | null = null;
  private tabWatcher: ChromeTabWatcher | null = null;
  private qualityTimer: NodeJS.Timeout | null = null;
  private lastInteraction = 0;
  private qualityState: 'interaction' | 'idle' | 'still' = 'idle';
  private paused = false;
  private mobileViewport = { width: 0, height: 0 };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  // ── Callbacks ──────────────────────────────────────────────────────────
  public onFrame: ((data: string, width: number, height: number, timestamp: number) => void) | null = null;
  public onStatus: ((state: string, reason?: string) => void) | null = null;
  public onTabEvent: ((event: TabEvent) => void) | null = null;
  public onTabsList: ((tabs: ChromeTab[], activeTargetId?: string) => void) | null = null;

  // ── Public API ─────────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this.session !== null;
  }

  /**
   * Connect to Chrome: auto-detect debug port or launch via chrome-launcher.
   */
  async connect(): Promise<void> {
    if (this.session) {
      logger.warn('[chrome] connect() called while already connected — ignoring');
      return;
    }
    this.destroyed = false;

    let port: number | null = null;
    let launched = false;
    let launcher: any = null;

    // 1. Try to find a running Chrome with a debug port
    port = await this.findDebugPort();

    // 2. If not found, launch Chrome
    if (port === null) {
      logger.info('[chrome] No running debug Chrome found — launching via chrome-launcher');
      const freePort = await this.pickFreePort();
      try {
        launcher = await chromeLauncher.launch({
          chromeFlags: [
            `--remote-debugging-port=${freePort}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-translate',
            '--disable-extensions',
          ],
        });
        port = freePort;
        launched = true;
        logger.success(`[chrome] Chrome launched on port ${port} (pid ${launcher.pid})`);
      } catch (err) {
        logger.error(`[chrome] Failed to launch Chrome: ${err}`);
        throw err;
      }
    } else {
      logger.success(`[chrome] Found Chrome debug port: ${port}`);
    }

    // 3. Get target list & connect CDP
    let targets: any[];
    try {
      targets = await CDP.List({ port });
    } catch (err) {
      logger.error(`[chrome] CDP.List failed on port ${port}: ${err}`);
      if (launcher) await launcher.kill();
      throw err;
    }

    const pageTarget = targets.find((t: any) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (!pageTarget) {
      logger.error('[chrome] No page target found');
      if (launcher) await launcher.kill();
      throw new Error('No Chrome page target available');
    }

    let client: any;
    try {
      client = await CDP({ target: pageTarget.webSocketDebuggerUrl ?? pageTarget, port });
    } catch (err) {
      logger.error(`[chrome] CDP connect failed: ${err}`);
      if (launcher) await launcher.kill();
      throw err;
    }

    // 4. Enable domains
    await client.Page.enable();
    await client.Target.enable();
    try { await client.Input.enable?.(); } catch { /* optional */ }

    // 5. Build session
    this.session = {
      client,
      port,
      launched,
      launcher,
      activeTargetId: pageTarget.id ?? null,
      screencastActive: false,
      quality: { ...QUALITY_PRESETS.idle },
      viewport: { width: 1280, height: 800 },
    };

    // 6. Start tab watcher
    this.tabWatcher = new ChromeTabWatcher(client);
    this.tabWatcher.start((event: TabEvent) => {
      this.onTabEvent?.(event);
      this.emitTabsList();
    });

    // 7. Disconnect handler → schedule reconnect
    client.on('disconnect', () => {
      logger.warn('[chrome] CDP disconnected');
      this.session = null;
      this.stopQualityTimer();
      this.tabWatcher?.stop();
      this.tabWatcher = null;
      this.onStatus?.('disconnected');
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    logger.success('[chrome] Connected');
    this.onStatus?.('connected');
    this.emitTabsList();
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.stopQualityTimer();
    this.clearReconnectTimer();

    this.tabWatcher?.stop();
    this.tabWatcher = null;

    if (this.session) {
      try { await this.stopScreencast(); } catch { /* ignore */ }
      try { await this.session.client.close(); } catch { /* ignore */ }
      if (this.session.launched && this.session.launcher) {
        try { await this.session.launcher.kill(); } catch { /* ignore */ }
      }
      this.session = null;
    }

    this.onStatus?.('disconnected');
    logger.info('[chrome] Disconnected');
  }

  /**
   * Start screencast. Optionally set viewport first.
   */
  async startScreencast(viewport?: { width: number; height: number }): Promise<void> {
    if (!this.session) throw new Error('Not connected');

    // Set viewport if provided
    if (viewport && (viewport.width > 0 && viewport.height > 0)) {
      await this.applyViewport(viewport.width, viewport.height);
    }

    const { client } = this.session;
    const quality = this.session.quality;

    // Register frame handler
    client.Page.screencastFrame(async (params: any) => {
      if (this.paused) {
        // Still ack to keep Chrome happy, but don't forward
        try { await client.Page.screencastFrameAck({ sessionId: params.sessionId }); } catch { /* ignore */ }
        return;
      }
      // Ack immediately
      try { await client.Page.screencastFrameAck({ sessionId: params.sessionId }); } catch { /* ignore */ }

      const { data, metadata } = params;
      const w = metadata?.deviceWidth ?? this.session?.viewport.width ?? 0;
      const h = metadata?.deviceHeight ?? this.session?.viewport.height ?? 0;
      const ts = metadata?.timestamp ?? Date.now() / 1000;
      this.onFrame?.(data, w, h, ts);
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
    logger.info('[chrome] Screencast started');
  }

  async stopScreencast(): Promise<void> {
    if (!this.session?.screencastActive) return;
    this.stopQualityTimer();
    try {
      await this.session.client.Page.stopScreencast();
    } catch (err) {
      logger.warn(`[chrome] stopScreencast error: ${err}`);
    }
    this.session.screencastActive = false;
    logger.info('[chrome] Screencast stopped');
  }

  pause(): void {
    this.paused = true;
    logger.info('[chrome] Screencast paused');
  }

  resume(): void {
    this.paused = false;
    logger.info('[chrome] Screencast resumed');
  }

  /**
   * Handle input events from mobile app.
   * action: 'click' | 'dblclick' | 'rightclick' | 'scroll' | 'key' | 'mousemove' | 'mousedown' | 'mouseup' | 'type'
   */
  async handleInput(action: string, payload: any): Promise<void> {
    if (!this.session) return;

    // Bump interaction for adaptive quality
    this.lastInteraction = Date.now();
    if (this.qualityState !== 'interaction') {
      await this.applyQualityState('interaction');
    }

    const { client, viewport } = this.session;
    const mw = this.mobileViewport.width || viewport.width;
    const mh = this.mobileViewport.height || viewport.height;

    try {
      switch (action) {
        case 'click': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          await dispatchClick(client, x, y);
          break;
        }
        case 'dblclick': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          await dispatchDoubleClick(client, x, y);
          break;
        }
        case 'rightclick': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          await dispatchRightClick(client, x, y);
          break;
        }
        case 'scroll': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          await dispatchScroll(client, x, y, payload.deltaX ?? 0, payload.deltaY ?? 0);
          break;
        }
        case 'key': {
          await dispatchKey(client, payload.key, payload.code, payload.text, payload.modifiers);
          break;
        }
        case 'type': {
          // Dispatch each character as a key event
          const text: string = payload.text ?? '';
          for (const ch of text) {
            await dispatchKey(client, ch, `Key${ch.toUpperCase()}`, ch);
          }
          break;
        }
        case 'mousemove': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          try {
            await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
          } catch (err) {
            logger.warn(`[chrome:input] mousemove failed: ${err}`);
          }
          break;
        }
        case 'mousedown': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          try {
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: payload.button ?? 'left', clickCount: 1 });
          } catch (err) {
            logger.warn(`[chrome:input] mousedown failed: ${err}`);
          }
          break;
        }
        case 'mouseup': {
          const { x, y } = scaleCoordinates(payload.x, payload.y, mw, mh, viewport.width, viewport.height);
          try {
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: payload.button ?? 'left', clickCount: 1 });
          } catch (err) {
            logger.warn(`[chrome:input] mouseup failed: ${err}`);
          }
          break;
        }
        default:
          logger.warn(`[chrome] Unknown input action: ${action}`);
      }
    } catch (err) {
      logger.warn(`[chrome] handleInput(${action}) error: ${err}`);
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Page.navigate({ url });
    } catch (err) {
      logger.warn(`[chrome] navigate failed: ${err}`);
    }
  }

  async goBack(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Runtime.evaluate({ expression: 'window.history.back()' });
    } catch (err) {
      logger.warn(`[chrome] goBack failed: ${err}`);
    }
  }

  async goForward(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Runtime.evaluate({ expression: 'window.history.forward()' });
    } catch (err) {
      logger.warn(`[chrome] goForward failed: ${err}`);
    }
  }

  async reload(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Page.reload({});
    } catch (err) {
      logger.warn(`[chrome] reload failed: ${err}`);
    }
  }

  async switchTab(targetId: string): Promise<void> {
    if (!this.session) return;

    const wasScreencasting = this.session.screencastActive;

    // Stop screencast on current tab
    if (wasScreencasting) {
      await this.stopScreencast();
    }

    const { client: oldClient, port } = this.session;

    // Activate the target in Chrome
    try {
      await oldClient.Target.activateTarget({ targetId });
    } catch (err) {
      logger.warn(`[chrome] activateTarget failed: ${err}`);
    }

    // Get fresh target list to find the debugger URL
    let targets: any[];
    try {
      targets = await CDP.List({ port });
    } catch (err) {
      logger.error(`[chrome] CDP.List failed during switchTab: ${err}`);
      return;
    }

    const target = targets.find((t: any) => t.id === targetId);
    if (!target) {
      logger.warn(`[chrome] switchTab: target ${targetId} not found`);
      return;
    }

    // Create new CDP client for the new target
    let newClient: any;
    try {
      newClient = await CDP({ target: target.webSocketDebuggerUrl ?? target, port });
    } catch (err) {
      logger.error(`[chrome] CDP connect for tab ${targetId} failed: ${err}`);
      return;
    }

    // Enable domains on new client
    await newClient.Page.enable();
    await newClient.Target.enable();
    try { await newClient.Input.enable?.(); } catch { /* optional */ }

    // Re-attach disconnect handler
    newClient.on('disconnect', () => {
      logger.warn('[chrome] CDP disconnected (after tab switch)');
      this.session = null;
      this.stopQualityTimer();
      this.tabWatcher?.stop();
      this.tabWatcher = null;
      this.onStatus?.('disconnected');
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    // Close old client
    try { await oldClient.close(); } catch { /* ignore */ }

    // Update session
    this.session.client = newClient;
    this.session.activeTargetId = targetId;
    this.session.screencastActive = false;

    // Restart tab watcher with new client
    this.tabWatcher?.stop();
    this.tabWatcher = new ChromeTabWatcher(newClient);
    this.tabWatcher.start((event: TabEvent) => {
      this.onTabEvent?.(event);
      this.emitTabsList();
    });

    // Restart screencast if it was running
    if (wasScreencasting) {
      await this.startScreencast();
    }

    // Emit updated tab list
    this.emitTabsList();
    logger.success(`[chrome] Switched to tab ${targetId}`);
  }

  async openTab(url?: string): Promise<void> {
    if (!this.session) return;
    try {
      const result = await this.session.client.Target.createTarget({
        url: url ?? 'about:blank',
      });
      // Switch to newly created tab
      if (result?.targetId) {
        // Give Chrome a moment to set up the target
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        await this.switchTab(result.targetId);
      }
    } catch (err) {
      logger.warn(`[chrome] openTab failed: ${err}`);
    }
  }

  async closeTab(targetId: string): Promise<void> {
    if (!this.session) return;
    try {
      // If we're closing the active tab, switch to another one first
      if (this.session.activeTargetId === targetId) {
        const tabs = this.tabWatcher?.getTabs() ?? [];
        const other = tabs.find(t => t.targetId !== targetId);
        if (other) {
          await this.switchTab(other.targetId);
        }
      }
      await this.session.client.Target.closeTarget({ targetId });
    } catch (err) {
      logger.warn(`[chrome] closeTab ${targetId} failed: ${err}`);
    }
  }

  /**
   * Resize Chrome viewport — used when Fold 7 opens/closes.
   */
  async resize(width: number, height: number): Promise<void> {
    if (!this.session) return;
    await this.applyViewport(width, height);

    // If screencast is active, restart it so dimensions update
    if (this.session.screencastActive) {
      try {
        await this.session.client.Page.stopScreencast();
        this.session.screencastActive = false;
        await this.startScreencast();
      } catch (err) {
        logger.warn(`[chrome] resize restart screencast failed: ${err}`);
      }
    }
  }

  /**
   * Store the mobile display dimensions used for coordinate scaling.
   */
  setMobileViewport(width: number, height: number): void {
    this.mobileViewport = { width, height };
  }

  /**
   * Manually override quality settings and restart screencast.
   */
  async setQuality(quality: number, maxFps: number): Promise<void> {
    if (!this.session) return;
    this.session.quality = { quality, maxFps };

    if (this.session.screencastActive) {
      try {
        await this.session.client.Page.stopScreencast();
        await this.session.client.Page.startScreencast({
          format: 'jpeg',
          quality,
          maxWidth: this.session.viewport.width,
          maxHeight: this.session.viewport.height,
          everyNthFrame: 1,
        });
      } catch (err) {
        logger.warn(`[chrome] setQuality restart screencast failed: ${err}`);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async findDebugPort(): Promise<number | null> {
    for (let port = CDP_PORT_MIN; port <= CDP_PORT_MAX; port++) {
      const open = await this.isPortOpen('localhost', port);
      if (!open) continue;

      // Confirm it's a CDP endpoint
      try {
        await CDP.Version({ port });
        return port;
      } catch {
        // Not a CDP endpoint — keep scanning
      }
    }
    return null;
  }

  private isPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket();
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(300);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
      socket.connect(port, host);
    });
  }

  private async pickFreePort(): Promise<number> {
    // Try ports from CDP_PORT_MIN; fall back to any free port
    for (let port = CDP_PORT_MIN; port <= CDP_PORT_MAX; port++) {
      const inUse = await this.isPortOpen('localhost', port);
      if (!inUse) return port;
    }
    // All known ports taken — ask OS for a free one
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        srv.close(() => {
          if (addr && typeof addr === 'object') resolve(addr.port);
          else reject(new Error('Could not get free port'));
        });
      });
    });
  }

  private async applyViewport(width: number, height: number): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.client.Emulation.setDeviceMetricsOverride({
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      this.session.viewport = { width, height };
      logger.info(`[chrome] Viewport set to ${width}x${height}`);
    } catch (err) {
      logger.warn(`[chrome] setDeviceMetricsOverride failed: ${err}`);
    }
  }

  /** Quality timer: runs every 500ms, transitions interaction → idle → still */
  private startQualityTimer(): void {
    this.stopQualityTimer();
    this.qualityTimer = setInterval(async () => {
      if (!this.session?.screencastActive) return;

      const elapsed = Date.now() - this.lastInteraction;

      if (elapsed < QUALITY_TIMERS.idleThreshold) {
        // Already in interaction mode — nothing to change
        return;
      }

      if (elapsed < QUALITY_TIMERS.stillThreshold) {
        if (this.qualityState !== 'idle') {
          await this.applyQualityState('idle');
        }
      } else {
        if (this.qualityState !== 'still') {
          await this.applyQualityState('still');
        }
      }
    }, QUALITY_CHECK_INTERVAL_MS);
  }

  private stopQualityTimer(): void {
    if (this.qualityTimer) {
      clearInterval(this.qualityTimer);
      this.qualityTimer = null;
    }
  }

  private async applyQualityState(state: 'interaction' | 'idle' | 'still'): Promise<void> {
    if (!this.session) return;
    this.qualityState = state;
    const preset = QUALITY_PRESETS[state];
    await this.setQuality(preset.quality, preset.maxFps);
    logger.info(`[chrome] Quality → ${state} (q=${preset.quality}, fps=${preset.maxFps})`);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    logger.info(`[chrome] Will attempt reconnect in ${RECONNECT_DELAY_MS / 1000}s`);
    this.reconnectTimer = setTimeout(async () => {
      if (this.destroyed || this.session) return;
      logger.info('[chrome] Attempting reconnect…');
      try {
        await this.connect();
        if (this.session) {
          await this.startScreencast();
        }
      } catch (err) {
        logger.warn(`[chrome] Reconnect failed: ${err}`);
        // Will retry again on next disconnect event (if any) or manual reconnect
      }
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emitTabsList(): void {
    if (!this.tabWatcher) return;
    const tabs = this.tabWatcher.getTabs();
    this.onTabsList?.(tabs, this.session?.activeTargetId ?? undefined);
  }
}
