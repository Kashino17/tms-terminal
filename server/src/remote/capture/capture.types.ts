import type { RemoteErrorCode } from '../../../../shared/protocol';

export interface CaptureOptions {
  fps: number; maxWidth: number; bitrateKbps: number;
  /** Leave the pointer out of the video and report its position instead
   *  (onCursor) — the app draws it locally. Backends without onCursor ignore it. */
  localCursor?: boolean;
}
export interface CaptureInfo { width: number; height: number; scale: number }

/**
 * Carries a known `RemoteErrorCode` through a rejected `start()` (capture or
 * input). A plain `Error` only has `.message` — remote.socket.ts's catch
 * handler has no other way to learn what actually went wrong and used to
 * fall back to reporting every startup failure as `capture_unavailable`,
 * including `permission_screen` / `permission_input` / `display_asleep`.
 * On macOS that buried the guided permission screens entirely and showed a
 * Windows-only "install ffmpeg" message instead. A rejection with no known
 * code (a timeout, an unexpected exit) should stay a plain `Error` — the
 * catch handler falls back to `capture_unavailable` for those, same as before.
 */
export class RemoteCaptureError extends Error {
  constructor(public readonly code: RemoteErrorCode, message: string) {
    super(message);
    this.name = 'RemoteCaptureError';
  }
}

/** Every code a helper is allowed to report — shared by the capture and
 *  input backends' JSON-line parsers so an unrecognised string from a
 *  helper (garbage, a typo, a future code an older server doesn't know
 *  about yet) never gets forwarded to the client as-is; it falls back to
 *  `capture_unavailable`, same as an error with no code at all. */
export const KNOWN_REMOTE_ERROR_CODES: RemoteErrorCode[] = [
  'permission_screen', 'permission_input', 'capture_unavailable',
  'helper_crashed', 'disabled', 'unsupported_platform', 'display_asleep',
];

/** One screen capture, encoding straight to H.264. Platform backends implement this. */
export interface ScreenCapture {
  start(opts: CaptureOptions): Promise<CaptureInfo>;
  onData(cb: (chunk: Buffer) => void): void;
  onError(cb: (code: RemoteErrorCode, message: string) => void): void;
  requestKeyframe(): void;
  setBitrate(kbps: number): void;
  /** Pointer position (normalized 0..1 to the captured display), only with
   *  `localCursor`. Optional: Windows keeps the pointer in the video. */
  onCursor?(cb: (x: number, y: number) => void): void;
  stop(): Promise<void>;
}
