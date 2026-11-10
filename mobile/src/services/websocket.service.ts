import { RttWindow } from './rtt.core.mjs';
import { pingPlan, nextPingDelay, type PingMode } from '../season2/attention.core.mjs';
import NetInfo, { NetInfoState, NetInfoStateType } from '@react-native-community/netinfo';
import { WebSocketConfig, ConnectionState } from '../types/websocket.types';

type MessageHandler = (data: unknown) => void;
type StateHandler = (state: ConnectionState) => void;

const RECONNECT_BASE = 500;   // 500ms initial delay (faster recovery on mobile)
const RECONNECT_MAX = 5000;   // cap at 5s (was 30s) — backoff: 500ms, 1s, 2s, 4s, 5s
// Ehrlicher Ping: alle 3 s messen (früher 12 s) — die Anzeige soll den echten
// Pfad zeigen (Heimnetz direkt ≈10 ms, Tailscale-Relais 80–450 ms).
const PING_INTERVAL_NORMAL = 3000;
const PING_INTERVAL_FAST = 3000;
const WATCHDOG_TIMEOUT = 30000; // 30s — 15s margin over server's 15s heartbeat
const RTT_REPORT_INTERVAL = 5; // send RTT to server every 5 pings
// No max reconnect cap: a server restart can take arbitrarily long, and the
// client must always be able to win the connection back on its own. Backoff is
// bounded by RECONNECT_MAX so endless idle retries stay cheap.

// RTT quality thresholds
const RTT_GOOD = 80;          // <80ms = good (green)
const RTT_FAIR = 200;         // <200ms = fair (yellow)
const RTT_POOR = 500;         // <500ms = poor (orange), >=500ms = bad (red)

// Payloads above this size (dictation audio, file uploads) saturate the socket
// for many seconds — queued pings/pongs stall BEHIND them in the ordered
// stream. The watchdog must not treat that silence as a dead connection, or it
// kills the client's own upload mid-flight.
const LARGE_SEND_THRESHOLD = 256 * 1024;
const LARGE_SEND_GRACE_MS = 120_000;

// EMA smoothing factor: lower = smoother (less reactive to spikes)
const EMA_ALPHA = 0.3;
// Jitter EMA smoothing factor
const JITTER_ALPHA = 0.2;

export type ConnectionQuality = 'good' | 'fair' | 'poor' | 'bad';

export class WebSocketService {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<MessageHandler>();
  private persistentHandler: MessageHandler | null = null;
  private onStateChange: StateHandler = () => {};
  private stateListeners = new Set<StateHandler>();
  private _state: ConnectionState = 'disconnected';
  private netInfoUnsub: (() => void) | null = null;
  private lastNetType: NetInfoStateType | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  // RTT tracking
  private pingSentAt: number | null = null;
  private _rawRtt: number | undefined = undefined;     // last raw sample
  private _smoothedRtt: number | undefined = undefined; // EMA-smoothed RTT (Qualität/Jitter)
  /** Anzeige-Ping: Median der letzten 5 Rohwerte. */
  private rttWindow = new RttWindow(5);
  private _jitter: number = 0;                          // EMA-smoothed jitter
  private _quality: ConnectionQuality = 'good';
  private pingCount = 0;
  private currentPingInterval = PING_INTERVAL_NORMAL;
  private consecutivePoorCount = 0;                     // track sustained poor RTT
  private largeTransferUntil = 0;                       // watchdog grace window during big uploads
  /** Wie oft gepingt wird (attention.core.mjs pingPlan): live | calm | quiet. */
  private pingMode: PingMode = 'live';

  /**
   * Ping-Takt nach Bedarf. Jeder Ping weckt das Funkmodul — bisher alle 3 s,
   * auch wenn nirgends ein Ping-Wert zu sehen war oder die App im Hintergrund
   * lag. Zurück auf `live` wird sofort gemessen: so fällt eine inzwischen tote
   * Leitung gleich auf und die Anzeige ist frisch.
   */
  setPingMode(mode: PingMode): void {
    if (mode === this.pingMode) return;
    this.pingMode = mode;
    if (!this.pingTimer) return; // nicht verbunden: gilt ab dem nächsten Aufbau
    this.schedulePing();
    this.resetWatchdog();
    if (mode === 'live') this.doPing();
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Ping für die Anzeige: Median der letzten 5 Messungen (undefined vor der ersten). */
  getRtt(): number | undefined {
    return this.rttWindow.median();
  }

  /** Raw (unsmoothed) last RTT sample */
  getRawRtt(): number | undefined {
    return this._rawRtt;
  }

  /** Current jitter estimate in ms (EMA of absolute RTT differences) */
  getJitter(): number {
    return Math.round(this._jitter);
  }

  /** Connection quality based on smoothed RTT + jitter */
  getQuality(): ConnectionQuality {
    return this._quality;
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    this.onStateChange(state);
    for (const l of this.stateListeners) {
      try { l(state); } catch { /* a listener must not break the socket */ }
    }
  }

  /** Additional state listener (setStateHandler has a single owner); returns unsubscribe. */
  addStateListener(handler: StateHandler): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  /** Add a listener; returns an unsubscribe function */
  addMessageListener(handler: MessageHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  setStateHandler(handler: StateHandler): void {
    this.onStateChange = handler;
  }

  /**
   * Set a persistent message handler that survives screen unmount.
   * Unlike addMessageListener, this handler is never removed — it's replaced
   * on each call. Used for manager:* messages that must be processed even
   * when the chat screen is not mounted.
   */
  setPersistentHandler(handler: MessageHandler): void {
    this.persistentHandler = handler;
  }

  connect(cfg: WebSocketConfig): void {
    this.config = cfg;
    // If a healthy socket already exists, don't tear it down. The foreground
    // app-state check (TerminalScreen) calls connect() defensively; resetting
    // and reopening a live connection would re-run the on-connect effect and
    // reattach every tab — a needless reattach storm that corrupts the display.
    if (this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeNetInfo();
      return;
    }
    this.reconnectAttempts = 0;
    this.subscribeNetInfo();
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.config) return;
    if (this._state === 'connecting') return;

    this.cleanup();
    this.setState('connecting');

    // Token in URL query is standard for WebSocket auth (WS API doesn't support custom headers).
    // Connection uses ws:// (not wss://) because the server runs HTTP.
    // Tailscale VPN provides WireGuard encryption for all traffic.
    // The token in the URL is protected by the VPN tunnel, not TLS.
    const url = `ws://${this.config.host}:${this.config.port}?token=${encodeURIComponent(this.config.token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.consecutivePoorCount = 0;
      this.largeTransferUntil = 0;
      this.setState('connected');
      this.startPing();
      this.resetWatchdog();
    };

    this.ws.onmessage = (event) => {
      this.resetWatchdog();
      try {
        const data = JSON.parse(event.data as string);
        // RTT: measure on pong responses
        if ((data as { type?: string }).type === 'pong' && this.pingSentAt !== null) {
          const rawRtt = Date.now() - this.pingSentAt;
          this.pingSentAt = null;
          // A pong made it through — any large upload has drained, normal
          // watchdog policing resumes. Skip the RTT sample for this round:
          // it measured the upload backlog, not the network.
          if (this.largeTransferUntil > 0) {
            this.largeTransferUntil = 0;
          } else {
            this.updateRttMetrics(rawRtt);
          }
        }
        // Persistent handler runs first (survives screen unmount)
        this.persistentHandler?.(data);
        // Regular listeners (may be empty if screen unmounted)
        this.listeners.forEach((l) => l(data));
      } catch {
        // ignore invalid JSON
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this._state !== 'disconnected') {
        // A server restart (ECONNREFUSED, quick close) and a genuine auth failure
        // look identical here, so we never give up on our own — a restarted server
        // must always be able to win the client back. Reconnection stops ONLY when
        // the app calls disconnect() explicitly (which sets state 'disconnected').
        this.setState('error');
        // First reconnect attempt is immediate (0ms delay) for fast recovery
        if (this.reconnectAttempts === 0) {
          this.reconnectAttempts++;
          this.doConnect();
        } else {
          this.scheduleReconnect();
        }
      }
    };

    this.ws.onerror = () => {
      // onclose will follow
    };
  }

  /** Returns false when the socket is not open and the message was dropped. */
  send(msg: object): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(msg);
      if (data.length > LARGE_SEND_THRESHOLD) {
        this.largeTransferUntil = Date.now() + LARGE_SEND_GRACE_MS;
      }
      this.ws.send(data);
      return true;
    }
    return false;
  }

  disconnect(): void {
    this.setState('disconnected');
    this.cleanup();
    this.unsubscribeNetInfo();
    this.config = null;
  }

  private cleanup(): void {
    this.stopPing();
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    // Never give up. Backoff grows to RECONNECT_MAX and then stays there, so a
    // server that is down for minutes or hours is retried forever at a cheap,
    // fixed interval. The exponent is clamped so Math.pow can't overflow.
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, Math.min(this.reconnectAttempts, 10)), RECONNECT_MAX);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  /** Reset reconnect counter — call when user manually triggers reconnect. */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  // ── RTT metrics: EMA smoothing, jitter, quality, adaptive ping ──

  private updateRttMetrics(rawRtt: number): void {
    this._rawRtt = rawRtt;
    this.rttWindow.push(rawRtt);

    // EMA-smoothed RTT: smooth out spikes while staying responsive
    if (this._smoothedRtt === undefined) {
      this._smoothedRtt = rawRtt;
    } else {
      this._smoothedRtt = EMA_ALPHA * rawRtt + (1 - EMA_ALPHA) * this._smoothedRtt;
    }

    // Jitter: EMA of absolute difference between raw and smoothed
    const diff = Math.abs(rawRtt - this._smoothedRtt);
    this._jitter = JITTER_ALPHA * diff + (1 - JITTER_ALPHA) * this._jitter;

    // Connection quality from smoothed RTT
    const rtt = this._smoothedRtt;
    if (rtt < RTT_GOOD) {
      this._quality = 'good';
      this.consecutivePoorCount = 0;
    } else if (rtt < RTT_FAIR) {
      this._quality = 'fair';
      this.consecutivePoorCount = 0;
    } else if (rtt < RTT_POOR) {
      this._quality = 'poor';
      this.consecutivePoorCount++;
    } else {
      this._quality = 'bad';
      this.consecutivePoorCount++;
    }

    // Adaptive ping: switch to fast interval when unstable, normal when stable
    const shouldBeFast = this._quality === 'poor' || this._quality === 'bad' || this._jitter > 80;
    const targetInterval = shouldBeFast ? PING_INTERVAL_FAST : PING_INTERVAL_NORMAL;
    if (targetInterval !== this.currentPingInterval) {
      this.currentPingInterval = targetInterval;
      this.restartPingWithInterval(targetInterval);
    }

    // NOTE: There used to be a forced reconnect here when smoothed RTT stayed
    // above 800ms for 5 pings. Removed: high RTT is a property of the path
    // (Tailscale DERP relay, cellular) that a reconnect cannot fix — but each
    // teardown detached every session server-side and triggered a reattach
    // storm, which is what actually froze terminals. Truly dead connections
    // are caught by the 30s watchdog below.
  }

  private startPing(): void {
    this.pingCount = 0;
    this.currentPingInterval = PING_INTERVAL_NORMAL;
    this.schedulePing();
  }

  /** Eine Kette aus Einzel-Zeitgebern statt eines Intervalls: seltene Pings
   *  lassen sich so auf eine gemeinsame Uhr-Marke legen (alle Geräte wecken
   *  das Funkmodul dann im selben Moment statt nacheinander). */
  private schedulePing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    const plan = pingPlan(this.pingMode);
    const every = this.pingMode === 'live' ? this.currentPingInterval : plan.pingMs;
    this.pingTimer = setTimeout(() => {
      this.doPing();
      this.schedulePing();
    }, nextPingDelay(every, plan.aligned, Date.now()));
  }

  private doPing(): void {
    this.pingSentAt = Date.now();
    this.send({ type: 'ping' });
    this.pingCount++;
    // Report smoothed RTT to server every RTT_REPORT_INTERVAL pings
    if (this.pingCount % RTT_REPORT_INTERVAL === 0 && this._smoothedRtt !== undefined) {
      this.send({ type: 'client:rtt', payload: { rtt: Math.round(this._smoothedRtt) } } as any);
    }
  }

  private restartPingWithInterval(_intervalMs: number): void {
    if (this.pingTimer) this.schedulePing();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Watchdog: force reconnect if no message received in WATCHDOG_TIMEOUT ──

  private resetWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setTimeout(() => {
      // A large upload is (or just was) in flight — server replies stall
      // behind it in the ordered stream, so silence is expected. Re-arm
      // instead of killing our own transfer.
      if (Date.now() < this.largeTransferUntil) {
        this.resetWatchdog();
        return;
      }
      if (this._state === 'connected' || this._state === 'connecting') {
        // Dead connection detected — force reconnect
        this.reconnectAttempts = 0;
        this.doConnect();
      }
    }, Math.max(WATCHDOG_TIMEOUT, pingPlan(this.pingMode).watchdogMs));
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // ── Network change detection ──

  private subscribeNetInfo(): void {
    this.unsubscribeNetInfo();
    this.netInfoUnsub = NetInfo.addEventListener((state: NetInfoState) => {
      const newType = state.type;
      if (
        this.lastNetType !== null &&
        this.lastNetType !== newType &&
        state.isConnected &&
        (newType === NetInfoStateType.wifi || newType === NetInfoStateType.cellular)
      ) {
        // Force-close if we're mid-handshake on the old network
        if (this.ws && this._state === 'connecting') {
          this.ws.close();
          this._state = 'disconnected';
        }
        // Network type changed (wifi↔cellular) — proactively reconnect
        // Reset RTT metrics since network characteristics change
        this._smoothedRtt = undefined;
        this._jitter = 0;
        this._quality = 'good';
        this.consecutivePoorCount = 0;
        this.reconnectAttempts = 0;
        this.doConnect();
      }
      this.lastNetType = newType;
    });
  }

  private unsubscribeNetInfo(): void {
    if (this.netInfoUnsub) {
      this.netInfoUnsub();
      this.netInfoUnsub = null;
    }
  }
}

// ── Global Connection Pool ──────────────────────────────────────────
// Singleton WebSocket instances per serverId that persist across screen
// mount/unmount cycles. This ensures the connection stays alive when
// TerminalScreen unmounts (navigating away) or the activity is recreated
// (app swiped away but foreground service keeps process alive).

const connectionPool = new Map<string, WebSocketService>();

/**
 * Get or create a WebSocket connection for a server.
 * If a connection already exists and is not explicitly disconnected, reuse it.
 */
export function getConnection(serverId: string): WebSocketService {
  const existing = connectionPool.get(serverId);
  if (existing) return existing;

  const ws = new WebSocketService();
  ws.setPingMode(poolPingMode);
  connectionPool.set(serverId, ws);
  return ws;
}

/** Ping-Takt für alle Verbindungen — auch für später angelegte. */
let poolPingMode: PingMode = 'live';
export function setConnectionsPingMode(mode: PingMode): void {
  poolPingMode = mode;
  for (const ws of connectionPool.values()) ws.setPingMode(mode);
}

/**
 * Explicitly remove a connection from the pool (e.g. when persistent mode is off).
 */
export function removeConnection(serverId: string): void {
  const ws = connectionPool.get(serverId);
  if (ws) {
    ws.disconnect();
    connectionPool.delete(serverId);
  }
}
