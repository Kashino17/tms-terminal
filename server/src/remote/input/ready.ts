import type { ChildProcess } from 'node:child_process';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import { RemoteCaptureError, KNOWN_REMOTE_ERROR_CODES } from '../capture/capture.types';
import { splitLines } from '../lines';

export type InputReadyLine =
  | { kind: 'ready' }
  | { kind: 'error'; code: RemoteErrorCode; message: string };

/** Shape of an --input helper's stderr line, loosely — re-checked before use. */
interface InputReadyPayload {
  ready?: { input?: boolean };
  error?: { code?: string; message?: string };
}

/**
 * An --input helper writes one JSON object per stderr line, same shape on
 * both platforms: `{"ready":{"input":true}}` once its read loop is actually
 * running, or `{"error":{...}}` if it can't get there. Narrower than
 * capture.darwin.ts's parseHelperLine (which requires `ready.width` to be a
 * number) on purpose — this is the input-mode cousin, not a second call site
 * for the same thing.
 */
export function parseInputReadyLine(line: string): InputReadyLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: InputReadyPayload;
  try { obj = JSON.parse(trimmed) as InputReadyPayload; } catch { return null; }
  if (obj.ready?.input === true) return { kind: 'ready' };
  if (obj.error && typeof obj.error.code === 'string') {
    // Same fallback as capture.darwin.ts's parseHelperLine: an unrecognised
    // code must not reach the client verbatim.
    const code = KNOWN_REMOTE_ERROR_CODES.includes(obj.error.code as RemoteErrorCode)
      ? (obj.error.code as RemoteErrorCode)
      : 'capture_unavailable';
    return { kind: 'error', code, message: String(obj.error.message ?? obj.error.code) };
  }
  return null;
}

/** A helper that never speaks up must not hang the session forever. */
const READY_TIMEOUT_MS = 10_000;

/**
 * Resolves once an --input helper's `{"ready":{"input":true}}` line arrives
 * on stderr, rejects on a reported error, an early exit, or the timeout
 * above.
 *
 * Shared between macOS and Windows (I11: the Windows PowerShell helper has
 * the exact same startup race the macOS Swift helper does — `Add-Type`
 * compiles the embedded C# on first run, which takes real time — so both
 * platforms need the same "wait for readiness before relaying input" guard,
 * not just macOS. A second, divergent implementation is exactly the pattern
 * that has bitten this project three times already (the line-buffering
 * fix that stayed macOS-only, the NVENC-only encoder flags, the EPIPE
 * listener that stayed macOS-only) — so this lives in one place, imported by
 * both backends, instead of being copied.
 *
 * Without this, the caller could start relaying input before the helper's
 * read loop is actually running — the process has been spawned but is still
 * loading — measured on macOS as the first ~100ms of pointer motion silently
 * vanishing.
 */
export function waitForReady(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffered = '';

    const settle = () => { settled = true; clearTimeout(timeout); };

    const timeout = setTimeout(() => {
      if (settled) return;
      settle();
      reject(new Error('Eingabe-Helfer antwortet nicht (Zeitlimit ueberschritten)'));
    }, READY_TIMEOUT_MS);

    proc.stderr?.on('data', (b: Buffer) => {
      if (settled) return;
      const { lines, rest } = splitLines(buffered, b.toString());
      buffered = rest;
      for (const line of lines) {
        const parsed = parseInputReadyLine(line);
        if (!parsed) continue;
        settle();
        // RemoteCaptureError (C1), not a plain Error: without the code
        // attached, remote.socket.ts's catch had no way to tell
        // permission_input apart from any other startup failure and always
        // reported the generic capture_unavailable — burying the guided
        // "Bedienungshilfen" screen this specific code exists for.
        if (parsed.kind === 'ready') resolve(); else reject(new RemoteCaptureError(parsed.code, parsed.message));
        return;
      }
    });

    proc.on('exit', (code) => {
      if (settled) return;
      settle();
      reject(new Error(`Eingabe-Helfer beendet (${code})`));
    });

    proc.on('error', (e) => {
      if (settled) return;
      settle();
      reject(e);
    });
  });
}
