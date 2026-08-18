import { spawn, ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';
import { RemoteCaptureError, KNOWN_REMOTE_ERROR_CODES } from './capture.types';
import { helperBinaryPath, macBuildScriptPath } from '../paths';
import { splitLines } from '../lines';

// Re-exported so input.darwin.ts (and this file's tests) can keep importing
// helperBinaryPath from here — the actual root-finding lives in paths.ts,
// there's no second lookup implementation.
export { helperBinaryPath };
// Re-exported for the same reason: this file's test imports splitLines from
// here, and the actual line-buffering lives in lines.ts, shared with Windows.
export { splitLines };

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
    const code = KNOWN_REMOTE_ERROR_CODES.includes(obj.error.code as RemoteErrorCode)
      ? (obj.error.code as RemoteErrorCode)
      : 'capture_unavailable';
    return { kind: 'error', code, message: String(obj.error.message ?? '') };
  }
  return null;
}

/** The helper must speak up within this long, or `start()` rejects instead of
 *  hanging forever — a helper that says nothing must not freeze the session. */
const START_TIMEOUT_MS = 10_000;

/**
 * Existing installs that never re-ran the interactive setup wizard (the only
 * place that used to build the helper) never got a binary — every session
 * hit a bare ENOENT from `spawn()` with no indication what to do. Build it
 * once, lazily, right before the first session that actually needs it —
 * this way server startup stays fast for anyone who never opens remote
 * access, and a failed build still leaves a clear, actionable message (the
 * exact command from setup.ts) instead of a raw spawn error.
 */
/**
 * N4 (Nachprüfung): async, not execFileSync — a synchronous build blocked
 * the ENTIRE Node event loop for however long `swiftc -O` takes (real
 * seconds), stalling every terminal session and the connection heartbeat
 * along with it, for the one-time cost of building a helper an existing
 * install never got. `execFile`'s callback never rejects the returned
 * promise: a failed build is handled by the existence re-check in start()
 * below, not by this function throwing.
 */
function ensureHelperBuilt(): Promise<void> {
  if (fs.existsSync(helperBinaryPath())) return Promise.resolve();
  return new Promise<void>((resolve) => {
    execFile('bash', [macBuildScriptPath()], () => resolve());
  });
}

export function createDarwinCapture(): ScreenCapture {
  let child: ChildProcess | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  // Without this flag, a planned shutdown reports itself as a crash — and the
  // restart logic from Task 18 would start the just-stopped session again.
  let stopping = false;

  return {
    async start(opts) {
      await ensureHelperBuilt();
      if (!fs.existsSync(helperBinaryPath())) {
        throw new RemoteCaptureError('capture_unavailable',
          'Fernzugriffs-Helfer fehlt und konnte nicht automatisch gebaut werden. '
          + `Einmalig einrichten mit:  bash ${macBuildScriptPath()}`);
      }
      return new Promise<CaptureInfo>((resolve, reject) => {
        const proc = spawn(helperBinaryPath(), buildHelperArgs(opts), { stdio: ['pipe', 'pipe', 'pipe'] });
        child = proc;
        // Task 18: `stop()` (and requestKeyframe/setBitrate, which can be
        // invoked right up to the moment a crash is detected) write to this
        // pipe without checking liveness first. Once the helper is gone —
        // exactly the case a restart is reacting to — that write can throw
        // an EPIPE with no listener on the stream, which Node treats as an
        // uncaught exception and takes the whole server down with it. Same
        // fix as `ws.on('error')` above: never let this particular pipe be
        // able to crash the process.
        proc.stdin?.on('error', () => {});
        let settled = false;
        let stderrTail = '';
        let stderrRest = '';

        const settle = () => {
          settled = true;
          clearTimeout(startTimeout);
        };

        const startTimeout = setTimeout(() => {
          if (settled) return;
          settle();
          proc.kill('SIGKILL');
          reject(new Error('Helfer antwortet nicht (Zeitlimit ueberschritten)'));
        }, START_TIMEOUT_MS);

        proc.stdout.on('data', (b: Buffer) => onData(b));

        proc.stderr.on('data', (b: Buffer) => {
          const text = b.toString();
          stderrTail = (stderrTail + text).slice(-4096);
          const { lines, rest } = splitLines(stderrRest, text);
          stderrRest = rest;
          for (const line of lines) {
            const evt = parseHelperLine(line);
            if (!evt) continue;
            if (evt.kind === 'ready' && !settled) { settle(); resolve(evt.info); }
            else if (evt.kind === 'error') {
              // RemoteCaptureError, not a plain Error: without the code
              // attached here, remote.socket.ts's catch has nothing but a
              // message to go on and used to report every startup failure —
              // including permission_screen/permission_input/display_asleep
              // — as the generic capture_unavailable, burying the guided
              // permission screens those specific codes exist for.
              if (!settled) { settle(); reject(new RemoteCaptureError(evt.code, evt.message)); }
              else onError(evt.code, evt.message);
            }
          }
        });

        proc.on('exit', (code) => {
          child = null;
          if (stopping) return;                      // planned shutdown
          if (!settled) {
            settle();
            reject(new Error(`Helfer beendet (${code}): ${stderrTail.slice(-200)}`));
          } else {
            onError('helper_crashed', `Helfer beendet (${code})`);
          }
        });

        proc.on('error', (e) => {
          if (!settled) { settle(); reject(e); }
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
