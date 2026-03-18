export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WebSocketConfig {
  host: string;
  port: number;
  token: string;
}
