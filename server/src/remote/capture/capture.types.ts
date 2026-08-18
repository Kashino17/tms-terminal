import type { RemoteErrorCode } from '../../../../shared/protocol';

export interface CaptureOptions { fps: number; maxWidth: number; bitrateKbps: number }
export interface CaptureInfo { width: number; height: number; scale: number }

/** One screen capture, encoding straight to H.264. Platform backends implement this. */
export interface ScreenCapture {
  start(opts: CaptureOptions): Promise<CaptureInfo>;
  onData(cb: (chunk: Buffer) => void): void;
  onError(cb: (code: RemoteErrorCode, message: string) => void): void;
  requestKeyframe(): void;
  setBitrate(kbps: number): void;
  stop(): Promise<void>;
}
