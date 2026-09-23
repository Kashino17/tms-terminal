import { spawn, ChildProcess } from 'node:child_process';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector } from './input.types';
import { toWinVirtualKey } from '../keymap';
import { toWindowsAbsolute } from '../geometry';
import { winInputScriptPath } from '../paths';
import { waitForReady } from './ready';
import { createHeldState } from './held';
import { WIN_GESTURE_KEYS, isRemoteGesture } from '../gestures';

/**
 * One remote input event → one helper line.
 *
 * Unlike macOS, SendInput carries no modifier flag field: Shift and friends are
 * ordinary key events. The app already sends press and release for its sticky
 * modifiers, so nothing extra is needed here.
 */
export function toWinLine(ev: RemoteInputEvent): string | null {
  switch (ev?.t) {
    case 'm': {
      const p = toWindowsAbsolute(ev.x, ev.y);
      return `abs ${p.x} ${p.y}`;
    }
    case 'd':
      return `rel ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'b':
      return `btn ${ev.b} ${ev.d ? 1 : 0}`;
    case 's':
      return `scroll ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'k': {
      const vk = toWinVirtualKey(ev.c);
      return vk === null ? null : `key ${vk} ${ev.d ? 1 : 0}`;
    }
    case 'x':
      return `text ${ev.s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`;
    case 'g': {
      // A whole press-and-release chord as several helper lines in one write:
      // down in order, up in reverse — nothing is left held in between.
      if (!isRemoteGesture(ev.g)) return null;
      const vks = WIN_GESTURE_KEYS[ev.g].map(toWinVirtualKey);
      if (vks.some((vk) => vk === null)) return null;
      return [...vks.map((vk) => `key ${vk} 1`), ...[...vks].reverse().map((vk) => `key ${vk} 0`)].join('\n');
    }
    default:
      return null;
  }
}

export function createWin32Input(): InputInjector {
  const proc: ChildProcess = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winInputScriptPath()],
    // stderr piped, not ignored: I11's readiness line (and any reported
    // error) travels on stderr, same as the macOS helper.
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let child: ChildProcess | null = proc;
  proc.on('exit', () => { child = null; });
  // Task 18: same fix as input.darwin.ts. A restart (or the process dying out
  // from under us for any other reason) can leave a write — most likely the
  // `quit` below in `stop()` — racing the pipe's own teardown. Node throws
  // synchronously for a stream 'error' event with no listener, which — same
  // as the bare WebSocket in remote.socket.ts — lands in the process-wide
  // uncaughtException handler and kills the whole server. Swallow it here;
  // a write that fails because the process is already gone needs no handling.
  proc.stdin?.on('error', () => {});

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };
  const send = (ev: RemoteInputEvent) => write(toWinLine(ev));

  // I5: same tracking as the macOS backend — stop() releases exactly what
  // was actually sent down before killing the helper (see held.ts).
  const held = createHeldState();

  return {
    // I11: the interface description claimed Windows has no startup race —
    // wrong. Add-Type compiles the embedded C# on first run, which takes
    // real time, and the script only prints its readiness line (below,
    // input-helper.ps1) once that's done. Without waiting for it, the first
    // burst of input after a session starts can arrive before the read loop
    // is running and vanish silently — exactly the bug fixed on macOS.
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
      // Release everything still held before the `quit` below — same reason
      // as the macOS backend (I5): a helper killed with a key or mouse
      // button down otherwise leaves it stuck on the PC, unrecoverable once
      // the client is gone too.
      const stuck = held.held();
      stuck.buttons.forEach((b) => send({ t: 'b', b: b[0] as 'l' | 'r' | 'm', d: false }));
      stuck.keys.forEach(({ code, mods }) => send({ t: 'k', c: code, d: false, mods }));
      child = null;
      p.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { p.kill(); resolve(); }, 300);
        p.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
