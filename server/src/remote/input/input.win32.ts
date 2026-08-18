import { spawn, ChildProcess } from 'node:child_process';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector } from './input.types';
import { toWinVirtualKey } from '../keymap';
import { toWindowsAbsolute } from '../geometry';
import { winInputScriptPath } from '../paths';

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
    default:
      return null;
  }
}

export function createWin32Input(): InputInjector {
  let child: ChildProcess | null = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winInputScriptPath()],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  child.on('exit', () => { child = null; });
  // Task 18: same fix as input.darwin.ts. A restart (or the process dying out
  // from under us for any other reason) can leave a write — most likely the
  // `quit` below in `stop()` — racing the pipe's own teardown. Node throws
  // synchronously for a stream 'error' event with no listener, which — same
  // as the bare WebSocket in remote.socket.ts — lands in the process-wide
  // uncaughtException handler and kills the whole server. Swallow it here;
  // a write that fails because the process is already gone needs no handling.
  child.stdin?.on('error', () => {});

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };
  const send = (ev: RemoteInputEvent) => write(toWinLine(ev));

  return {
    moveRelative: (dx, dy) => send({ t: 'd', dx, dy }),
    moveAbsolute: (nx, ny) => send({ t: 'm', x: nx, y: ny }),
    button: (which, down) => send({ t: 'b', b: which[0] as 'l' | 'r' | 'm', d: down }),
    scroll: (dx, dy) => send({ t: 's', dx, dy }),
    key: (code, down, mods) => send({ t: 'k', c: code, d: down, mods }),
    text: (s) => send({ t: 'x', s }),

    async stop() {
      const proc = child;
      child = null;
      if (!proc) return;
      proc.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill(); resolve(); }, 300);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
