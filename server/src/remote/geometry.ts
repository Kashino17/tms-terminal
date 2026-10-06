/**
 * Small numeric helpers shared by the input backends.
 *
 * Absolute pointer positions travel normalised (0..1) across the captured
 * screen; each platform spreads that range to what its input API expects.
 * Relative motion is passed through unscaled on both platforms — the app's
 * dx/dy already come from its own gesture handling (finger travel times the
 * phone's own pointer acceleration), not from the captured image's pixel
 * grid, so there is nothing here to convert. Dividing by the capture scale
 * would be wrong: it would make the same swipe move the pointer a different
 * distance depending on which quality preset happens to be selected (see
 * input.darwin.ts).
 */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function toWindowsAbsolute(nx: number, ny: number): { x: number; y: number } {
  return { x: Math.round(clamp01(nx) * 65535), y: Math.round(clamp01(ny) * 65535) };
}
