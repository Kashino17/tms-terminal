import { spawn, ChildProcess } from 'node:child_process';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector, Mods } from './input.types';
import { helperBinaryPath } from '../capture/capture.darwin';
import { toMacKeyCode } from '../keymap';
import { clamp01 } from '../geometry';
import { splitLines } from '../lines';

/** Modifier bit field shared with the Swift side. */
const SHIFT = 1, CONTROL = 2, OPTION = 4, COMMAND = 8;

function modBits(m: Mods): number {
  return (m.s ? SHIFT : 0) | (m.c ? CONTROL : 0) | (m.a ? OPTION : 0) | (m.m ? COMMAND : 0);
}

/**
 * One remote input event → one helper command line, or null if it makes no sense.
 *
 * Relative motion is passed through unscaled and on purpose: dx/dy come from
 * the app's own gesture handling, not from the captured image's pixel grid,
 * so the capture quality preset must not affect it. Dividing by `scale` here
 * (an earlier version of this function did) would make the same swipe move
 * the pointer a different distance depending on which preset happens to be
 * selected — a bug nobody would think to blame on capture quality.
 */
export function toHelperLine(ev: RemoteInputEvent): string | null {
  switch (ev?.t) {
    case 'd':
      return `rel ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'm':
      return `abs ${clamp01(ev.x)} ${clamp01(ev.y)}`;
    case 'b':
      return `btn ${ev.b} ${ev.d ? 1 : 0}`;
    case 's':
      return `scroll ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'k': {
      const code = toMacKeyCode(ev.c);
      return code === null ? null : `key ${code} ${ev.d ? 1 : 0} ${modBits(ev.mods)}`;
    }
    case 'x':
      return `text ${ev.s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`;
    default:
      return null;
  }
}

export type InputReadyLine =
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/** Shape of the --input helper's stderr line, loosely — re-checked before use. */
interface InputReadyPayload {
  ready?: { input?: boolean };
  error?: { code?: string; message?: string };
}

/**
 * The --input helper writes one JSON object per stderr line, same as capture
 * mode — but its `ready` payload is `{"input":true}`, not the capture mode's
 * `{width,height,scale}`, so capture.darwin.ts's parseHelperLine (which
 * requires `ready.width` to be a number) never matches it. Hence this
 * narrower cousin instead of a second call site for that one.
 */
export function parseInputReadyLine(line: string): InputReadyLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: InputReadyPayload;
  try { obj = JSON.parse(trimmed) as InputReadyPayload; } catch { return null; }
  if (obj.ready?.input === true) return { kind: 'ready' };
  if (obj.error && typeof obj.error.code === 'string') {
    return { kind: 'error', message: String(obj.error.message ?? obj.error.code) };
  }
  return null;
}

/** Same budget as capture.darwin.ts's START_TIMEOUT_MS, for the same reason:
 *  a helper that never speaks up must not hang the session forever. */
const READY_TIMEOUT_MS = 10_000;

/**
 * Resolves once the helper's `{"ready":{"input":true}}` line arrives on
 * stderr, rejects on a reported error, an early exit, or the timeout above.
 *
 * Without this, the caller could start relaying input before the helper's
 * read loop is actually running: the process has been spawned but is still
 * loading (framework dyld loading, the Accessibility permission check) —
 * measured on a real device as the first ~100ms of pointer motion silently
 * vanishing.
 */
function waitForReady(proc: ChildProcess): Promise<void> {
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
        if (parsed.kind === 'ready') resolve(); else reject(new Error(parsed.message));
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

export function createDarwinInput(): InputInjector {
  const proc: ChildProcess = spawn(helperBinaryPath(), ['--input'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let child: ChildProcess | null = proc;
  proc.on('exit', () => { child = null; });

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };
  // Every event goes through toHelperLine — the single, tested source of the
  // wire format. Do not format command lines here again: a second formatting
  // path is exactly how the relative-motion scale bug went unnoticed through
  // three review rounds (toHelperLine was tested, this second path wasn't).
  const send = (ev: RemoteInputEvent) => write(toHelperLine(ev));

  return {
    ready: waitForReady(proc),
    moveRelative: (dx, dy) => send({ t: 'd', dx, dy }),
    moveAbsolute: (nx, ny) => send({ t: 'm', x: nx, y: ny }),
    button: (which, down) => send({ t: 'b', b: which[0] as 'l' | 'r' | 'm', d: down }),
    scroll: (dx, dy) => send({ t: 's', dx, dy }),
    key: (code, down, mods) => send({ t: 'k', c: code, d: down, mods }),
    text: (s) => send({ t: 'x', s }),

    async stop() {
      const p = child;
      child = null;
      if (!p) return;
      p.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 300);
        p.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
