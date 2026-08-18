import { spawn, ChildProcess } from 'node:child_process';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector, Mods } from './input.types';
import { helperBinaryPath } from '../capture/capture.darwin';
import { toMacKeyCode } from '../keymap';
import { clamp01 } from '../geometry';

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

export function createDarwinInput(): InputInjector {
  let child: ChildProcess | null = spawn(helperBinaryPath(), ['--input'], { stdio: ['pipe', 'ignore', 'pipe'] });
  child.on('exit', () => { child = null; });

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };
  // Every event goes through toHelperLine — the single, tested source of the
  // wire format. Do not format command lines here again: a second formatting
  // path is exactly how the relative-motion scale bug went unnoticed through
  // three review rounds (toHelperLine was tested, this second path wasn't).
  const send = (ev: RemoteInputEvent) => write(toHelperLine(ev));

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
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 300);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
