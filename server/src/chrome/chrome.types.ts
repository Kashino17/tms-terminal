export interface ChromeSession {
  client: any;
  port: number;
  launched: boolean;
  launcher?: any;
  activeTargetId: string | null;
  screencastActive: boolean;
  quality: QualitySettings;
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

export const QUALITY_PRESETS = {
  interaction: { quality: 40, maxFps: 20 } as QualitySettings,
  idle:        { quality: 80, maxFps: 5 }  as QualitySettings,
  still:       { quality: 95, maxFps: 1 }  as QualitySettings,
  slow:        { quality: 30, maxFps: 10 } as QualitySettings,
} as const;

export const QUALITY_TIMERS = {
  idleThreshold: 1500,
  stillThreshold: 3000,
} as const;

export const CDP_PORT_MIN = 9222;
export const CDP_PORT_MAX = 9232;
export const TAB_POLL_INTERVAL = 2000;
