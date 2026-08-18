import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';

const KNOWN_CODES: RemoteErrorCode[] = [
  'permission_screen', 'permission_input', 'capture_unavailable',
  'helper_crashed', 'disabled', 'unsupported_platform', 'display_asleep',
];

/** `server/bin/tms-remote-helper`, next to the compiled output. */
export function helperBinaryPath(): string {
  return path.resolve(__dirname, '../../../bin/tms-remote-helper');
}

export function buildHelperArgs(opts: CaptureOptions): string[] {
  return [
    '--capture',
    '--max-width', String(opts.maxWidth),
    '--fps', String(opts.fps),
    '--bitrate', String(opts.bitrateKbps),
  ];
}

export type HelperLine =
  | { kind: 'ready'; info: CaptureInfo }
  | { kind: 'error'; code: RemoteErrorCode; message: string };

/** Shape of a helper stderr line, loosely — fields are re-checked before use. */
interface HelperLinePayload {
  ready?: { width: number; height: number; scale: number };
  error?: { code: string; message?: string };
}

/** The helper writes one JSON object per stderr line; everything else is noise. */
export function parseHelperLine(line: string): HelperLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: HelperLinePayload;
  try { obj = JSON.parse(trimmed) as HelperLinePayload; } catch { return null; }

  if (obj.ready && typeof obj.ready.width === 'number') {
    return {
      kind: 'ready',
      info: {
        width: obj.ready.width,
        height: obj.ready.height,
        scale: obj.ready.scale > 0 ? obj.ready.scale : 1,
      },
    };
  }
  if (obj.error && typeof obj.error.code === 'string') {
    const code = KNOWN_CODES.includes(obj.error.code as RemoteErrorCode)
      ? (obj.error.code as RemoteErrorCode)
      : 'capture_unavailable';
    return { kind: 'error', code, message: String(obj.error.message ?? '') };
  }
  return null;
}

export function createDarwinCapture(): ScreenCapture {
  let child: ChildProcess | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  // Ohne dieses Merkmal meldet das planmaessige Beenden sich als Absturz — und
  // die Neustart-Logik aus Aufgabe 18 startet die gerade beendete Sitzung wieder.
  let stopping = false;

  return {
    start(opts) {
      return new Promise<CaptureInfo>((resolve, reject) => {
        const proc = spawn(helperBinaryPath(), buildHelperArgs(opts), { stdio: ['pipe', 'pipe', 'pipe'] });
        child = proc;
        let settled = false;
        let stderrTail = '';

        proc.stdout.on('data', (b: Buffer) => onData(b));

        proc.stderr.on('data', (b: Buffer) => {
          stderrTail = (stderrTail + b.toString()).slice(-4096);
          for (const line of b.toString().split('\n')) {
            const evt = parseHelperLine(line);
            if (!evt) continue;
            if (evt.kind === 'ready' && !settled) { settled = true; resolve(evt.info); }
            else if (evt.kind === 'error') {
              if (!settled) { settled = true; reject(new Error(evt.message)); }
              else onError(evt.code, evt.message);
            }
          }
        });

        proc.on('exit', (code) => {
          child = null;
          if (stopping) return;                      // planmaessig beendet
          if (!settled) {
            settled = true;
            reject(new Error(`Helfer beendet (${code}): ${stderrTail.slice(-200)}`));
          } else {
            onError('helper_crashed', `Helfer beendet (${code})`);
          }
        });

        proc.on('error', (e) => {
          if (!settled) { settled = true; reject(e); }
        });
      });
    },

    onData(cb) { onData = cb; },
    onError(cb) { onError = cb; },
    requestKeyframe() { child?.stdin?.write('keyframe\n'); },
    setBitrate(kbps) { child?.stdin?.write(`bitrate ${Math.round(kbps)}\n`); },

    async stop() {
      const proc = child;
      stopping = true;
      child = null;
      if (!proc) return;
      proc.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 500);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
