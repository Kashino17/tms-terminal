/**
 * Android dictation bubble (native, com.tms.terminal.bubble). The app hands it
 * the main server + token so it can stream dictations on its own, and the
 * Season-2 settings show/toggle it. No-op on iOS / when the module is missing.
 */
import { NativeModules, Platform } from 'react-native';

export interface BubbleStatus {
  serviceOn: boolean;
  /** Actually bound by Android. false while serviceOn = "stopped": switched on but dead
   *  (after "Stopp" in "Aktive Apps" / force stop) — only toggling the switch revives it. */
  bound?: boolean;
  enabled: boolean;
  snoozedUntil: number;
  /** Keep-alive foreground service running (missing on older native builds). */
  keepAlive?: boolean;
  /** Its "Diktat-Bubble bereit" notification is allowed to show. */
  notifications?: boolean;
  /** Last time Android ended the bubble's process (not counting updates), and why. */
  lastExitAt?: number;
  lastExit?: string;
  /** The bubble's last show/hide decision in words, and when it was made. */
  lastCheckAt?: number;
  lastCheck?: string;
}

interface NativeBubble {
  configure(host: string, port: number, token: string, enhance: boolean): void;
  getStatus(): Promise<BubbleStatus>;
  openAccessibilitySettings(): void;
  setEnabled(enabled: boolean): void;
  wake(): void;
  startKeepAlive?(): void;
  openNotificationSettings?(): void;
}

const native: NativeBubble | null =
  Platform.OS === 'android' ? ((NativeModules.DictationBubble as NativeBubble | undefined) ?? null) : null;

export const dictationBubble = {
  available: native !== null,
  configure(host: string, port: number, token: string, enhance: boolean): void {
    native?.configure(host, port, token, enhance);
  },
  async status(): Promise<BubbleStatus | null> {
    if (!native) return null;
    try { return await native.getStatus(); } catch { return null; }
  },
  openSettings(): void { native?.openAccessibilitySettings(); },
  setEnabled(enabled: boolean): void { native?.setEnabled(enabled); },
  wake(): void { native?.wake(); },
  startKeepAlive(): void { native?.startKeepAlive?.(); },
  openNotificationSettings(): void { native?.openNotificationSettings?.(); },
};
