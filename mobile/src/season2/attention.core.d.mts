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
export declare function pingPlan(quiet: boolean): { pingMs: number; watchdogMs: number };
