import { WebSocketConfig, ConnectionState } from '../types/websocket.types';

type MessageHandler = (data: unknown) => void;
type StateHandler = (state: ConnectionState) => void;

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
const PING_INTERVAL = 25000;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<MessageHandler>();
  private onStateChange: StateHandler = () => {};
  private _state: ConnectionState = 'disconnected';

  get state(): ConnectionState {
    return this._state;
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
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.config) return;

    this.cleanup();
    this.setState('connecting');

    // Token in URL query is standard for WebSocket auth (WS API doesn't support custom headers).
    // WSS encryption protects the token in transit. Server should avoid logging full URLs.
    const url = `ws://${this.config.host}:${this.config.port}?token=${encodeURIComponent(this.config.token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState('connected');
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.listeners.forEach((l) => l(data));
      } catch {
        // ignore invalid JSON
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this._state !== 'disconnected') {
        this.setState('error');
        this.scheduleReconnect();
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
    this.config = null;
  }

  private cleanup(): void {
    this.stopPing();
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
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
