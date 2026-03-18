export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  token?: string;
  certFingerprint?: string;
  createdAt: number;
  /** Local file URI of the server's profile picture. */
  avatar?: string;
}

export interface ServerStatus {
  connected: boolean;
  latency?: number;
}
