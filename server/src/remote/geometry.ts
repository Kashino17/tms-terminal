/**
 * Coordinate conversion between the captured image and the two input APIs.
 *
 * Capture happens in pixels. macOS CGEvent wants logical points (half of that
 * on Retina displays), Windows SendInput wants 0..65535 across the virtual
 * screen. Getting this wrong puts the pointer at half or double the distance,
 * which looks like a broken trackpad rather than a unit bug — hence the tests.
 */
export interface CaptureGeometry { width: number; height: number; scale: number }

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function toLogicalPoint(nx: number, ny: number, g: CaptureGeometry): { x: number; y: number } {
  const scale = g.scale > 0 ? g.scale : 1;
  return {
    x: Math.round((clamp01(nx) * g.width) / scale),
    y: Math.round((clamp01(ny) * g.height) / scale),
  };
}

export function toWindowsAbsolute(nx: number, ny: number): { x: number; y: number } {
  return { x: Math.round(clamp01(nx) * 65535), y: Math.round(clamp01(ny) * 65535) };
}
