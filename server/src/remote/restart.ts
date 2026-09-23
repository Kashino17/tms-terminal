/**
 * How often and how fast a dead capture helper is brought back.
 *
 * Same answer covers two cases: a crashed helper, and a display whose resolution
 * changed underneath the running capture — both need a fresh capture and fresh
 * dimensions sent to the app.
 */
export const RESTART_DELAYS_MS = [500, 1000, 2000] as const;

export function nextRestartDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return attempt < RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[attempt] : null;
}
