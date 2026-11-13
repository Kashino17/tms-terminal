/** Typen für attention.core.mjs (siehe dort). */
export declare function focusOf(s: {
  terminalsVisible: boolean; remote: boolean; overview: boolean; listView: boolean; compact: boolean;
  activeSession: string | null;
}): string | null;
export declare function planAttention(
  devices: Array<{ id: string; connected: boolean }>,
  sent: Record<string, string>,
  foreground: boolean,
  focus: string | null,
): { send: string[]; sent: Record<string, string> };
export type PingMode = 'live' | 'calm' | 'quiet';
export declare function pingPlan(mode: PingMode): { pingMs: number; watchdogMs: number; aligned: boolean };
export declare function nextPingDelay(pingMs: number, aligned: boolean, now: number): number;
export declare function pingMode(appVisible: boolean, latencyVisible: boolean): PingMode;
