import NetInfo, { NetInfoState, NetInfoStateType } from '@react-native-community/netinfo';
import { WebSocketConfig, ConnectionState } from '../types/websocket.types';

type MessageHandler = (data: unknown) => void;
type StateHandler = (state: ConnectionState) => void;

const RECONNECT_BASE = 500;   // 500ms initial delay (faster recovery on mobile)
const RECONNECT_MAX = 5000;   // cap at 5s (was 30s) — backoff: 500ms, 1s, 2s, 4s, 5s
const PING_INTERVAL = 12000;  // 12s — inside server's 15s heartbeat window
const WATCHDOG_TIMEOUT = 30000; // 30s — 15s margin over server's 15s heartbeat
const RTT_REPORT_INTERVAL = 5; // send RTT to server every 5 pings
const MAX_RECONNECT_ATTEMPTS = 60; // ~5 min at max backoff — stop reconnecting after this

export class WebSocketService {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<MessageHandler>();
  private onStateChange: StateHandler = () => {};
  private _state: ConnectionState = 'disconnected';
  private netInfoUnsub: (() => void) | null = null;
  private lastNetType: NetInfoStateType | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  // RTT tracking
  private pingSentAt: number | null = null;
  private _rtt: number | undefined = undefined;
  private pingCount = 0;
  // Auth failure detection: track quick closes (connection dying within 2s of open)
  private connectTime = 0;
  private quickCloseCount = 0;
  private hasConnectedOnce = false;

  get state(): ConnectionState {
    return this._state;
  }

  /** Current round-trip time in ms (undefined if not yet measured) */
  getRtt(): number | undefined {
    return this._rtt;
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    this.onStateChange(state);
  }

  /** Add a listener; returns an unsubscribe function */
  addMessageListener(handler: MessageHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  setStateHandler(handler: StateHandler): void {
    this.onStateChange = handler;
  }

  connect(cfg: WebSocketConfig): void {
    this.config = cfg;
    this.reconnectAttempts = 0;
    this.subscribeNetInfo();
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.config) return;
    if (this._state === 'connecting') return;

    this.cleanup();
    this.setState('connecting');
    this.connectTime = Date.now();

    // Token in URL query is standard for WebSocket auth (WS API doesn't support custom headers).
    // Connection uses ws:// (not wss://) because the server runs HTTP.
    // Tailscale VPN provides WireGuard encryption for all traffic.
    // The token in the URL is protected by the VPN tunnel, not TLS.
    const url = `ws://${this.config.host}:${this.config.port}?token=${encodeURIComponent(this.config.token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.quickCloseCount = 0;
      this.hasConnectedOnce = true;
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
          this._rtt = Date.now() - this.pingSentAt;
          this.pingSentAt = null;
        }
        this.listeners.forEach((l) => l(data));
      } catch {
        // ignore invalid JSON
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this._state !== 'disconnected') {
        // Detect possible auth failure: connection closes within 2s of opening.
        // Only count quick closes if we've successfully connected before (prevents
        // false triggers during server restart where ECONNREFUSED causes quick closes).
        const wasQuick = this.hasConnectedOnce && Date.now() - this.connectTime < 2000;
        if (wasQuick) {
          this.quickCloseCount++;
          if (this.quickCloseCount >= 3) {
            this.setState('disconnected');
            // Don't retry — likely auth failure
            console.warn('[WS] Possible auth failure — stopping reconnect');
            return;
          }
        }

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

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
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
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded — giving up`);
      this.setState('disconnected');
      return;
    }
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  /** Reset reconnect counter — call when user manually triggers reconnect. */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private startPing(): void {
    this.pingCount = 0;
    this.pingTimer = setInterval(() => {
      this.pingSentAt = Date.now();
      this.send({ type: 'ping' });
      this.pingCount++;
      // Report RTT to server every RTT_REPORT_INTERVAL pings
      if (this.pingCount % RTT_REPORT_INTERVAL === 0 && this._rtt !== undefined) {
        this.send({ type: 'client:rtt', payload: { rtt: this._rtt } } as any);
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Watchdog: force reconnect if no message received in WATCHDOG_TIMEOUT ──

  private resetWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this._state === 'connected' || this._state === 'connecting') {
        // Dead connection detected — force reconnect
        this.reconnectAttempts = 0;
        this.doConnect();
      }
    }, WATCHDOG_TIMEOUT);
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
