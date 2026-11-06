/**
 * Android dictation bubble (native, com.tms.terminal.bubble). The app hands it
 * the main server + token so it can stream dictations on its own, and the
 * Season-2 settings show/toggle it. No-op on iOS / when the module is missing.
 */
import { NativeModules, Platform } from 'react-native';

export interface BubbleStatus {
  serviceOn: boolean;
  enabled: boolean;
  snoozedUntil: number;
}

interface NativeBubble {
  configure(host: string, port: number, token: string, enhance: boolean): void;
  getStatus(): Promise<BubbleStatus>;
  openAccessibilitySettings(): void;
  setEnabled(enabled: boolean): void;
  wake(): void;
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
};
