import { spawn, ChildProcess } from 'node:child_process';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector, Mods } from './input.types';
import { helperBinaryPath } from '../capture/capture.darwin';
import { toMacKeyCode } from '../keymap';
import { clamp01 } from '../geometry';
import { waitForReady, parseInputReadyLine, type InputReadyLine } from './ready';
import { createHeldState } from './held';
import { MAC_GESTURE_HOTKEY, isRemoteGesture } from '../gestures';

// Re-exported so this file's own test (and anything else that used to reach
// them here) keeps working — the actual implementations moved to ready.ts,
// shared with the Windows backend (I11: it has the exact same Add-Type
// startup race the Swift helper does).
export { parseInputReadyLine, type InputReadyLine };

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
    case 'g':
      return isRemoteGesture(ev.g) ? `hotkey ${MAC_GESTURE_HOTKEY[ev.g]}` : null;
    default:
      return null;
  }
}

export function createDarwinInput(): InputInjector {
  const proc: ChildProcess = spawn(helperBinaryPath(), ['--input'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let child: ChildProcess | null = proc;
  proc.on('exit', () => { child = null; });
  // Task 18: a restart (or a real `pkill -f tms-remote-helper`, which matches
  // both the capture and input helper by name) can tear this process's pipe
  // down out from under a still-pending write — most commonly the `quit`
  // below, sent while `stop()` is racing the helper's own exit. Node throws
  // synchronously for a stream 'error' event with no listener, which — same
  // as the bare WebSocket in remote.socket.ts — lands in the process-wide
  // uncaughtException handler and kills the whole server. Swallow it here;
  // a write that fails because the process is already gone needs no handling.
  proc.stdin?.on('error', () => {});

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };
  // Every event goes through toHelperLine — the single, tested source of the
  // wire format. Do not format command lines here again: a second formatting
  // path is exactly how the relative-motion scale bug went unnoticed through
  // three review rounds (toHelperLine was tested, this second path wasn't).
  const send = (ev: RemoteInputEvent) => write(toHelperLine(ev));

  // I5: track exactly what the helper was actually told to hold down, so
  // stop() can let go of it before killing the process — see held.ts for why
  // this has to live on the server (the client can't be trusted to still be
  // around to ask for a release).
  const held = createHeldState();

  return {
    ready: waitForReady(proc),
    moveRelative: (dx, dy) => send({ t: 'd', dx, dy }),
    moveAbsolute: (nx, ny) => send({ t: 'm', x: nx, y: ny }),
    button: (which, down) => {
      held.trackButton(which, down);
      send({ t: 'b', b: which[0] as 'l' | 'r' | 'm', d: down });
    },
    scroll: (dx, dy) => send({ t: 's', dx, dy }),
    key: (code, down, mods) => {
      held.trackKey(code, down, mods);
      send({ t: 'k', c: code, d: down, mods });
    },
    text: (s) => send({ t: 'x', s }),
    gesture: (g) => send({ t: 'g', g }),

    async stop() {
      const p = child;
      if (!p) { child = null; return; }
      // Release everything still held before the `quit` below — a helper
      // that gets killed with Cmd or a mouse button down leaves that press
      // stuck on the Mac, and unlike a client-side release, this one can't
      // be skipped just because nobody reconnects afterwards. Uses `send()`
      // (still valid: `child` isn't cleared until right after this), not a
      // second formatting path.
      const stuck = held.held();
      stuck.buttons.forEach((b) => send({ t: 'b', b: b[0] as 'l' | 'r' | 'm', d: false }));
      stuck.keys.forEach(({ code, mods }) => send({ t: 'k', c: code, d: false, mods }));
      child = null;
      p.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 300);
        p.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
