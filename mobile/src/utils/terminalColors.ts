/**
 * Stable color assignment for terminals.
 *
 * The Manager Chat redesign uses per-terminal accent colors throughout the UI
 * (rail dots, chip-bar pills, mention pills, pane left-borders, group-tab dots).
 * Same sessionId → same color across the whole app, even between renders.
 */

const PALETTE = [
  '#3B82F6', // blue   — dev / general
  '#A78BFA', // violet — build
  '#22C55E', // green  — tests
  '#06B6D4', // cyan   — db
  '#F59E0B', // amber  — deploy / wait
  '#94A3B8', // slate  — logs
  '#EF4444', // red    — prod / danger
  '#14B8A6', // teal   — docker
  '#EC4899', // pink   — redis
  '#8B5CF6', // violet — backup
] as const;

/**
 * Hash a string to a stable index in [0, len).
 * Simple FNV-1a-ish; good enough for distributing 10-20 sessionIds.
 */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

/** Get the accent color for a given terminal sessionId. Stable across renders. */
export function colorForSession(sessionId: string): string {
  if (!sessionId) return PALETTE[0];
  return PALETTE[hash(sessionId) % PALETTE.length];
}

/** Number of colors in the palette (useful for tests or UI hints). */
export const PALETTE_SIZE = PALETTE.length;
