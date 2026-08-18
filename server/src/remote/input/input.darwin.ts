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
 * `scale` matters for relative motion only: the app computes deltas in captured
 * pixels, while CGEvent moves the pointer in logical points.
 */
export function toHelperLine(ev: RemoteInputEvent, scale: number): string | null {
  const s = scale > 0 ? scale : 1;
  switch (ev?.t) {
    case 'd':
      return `rel ${Math.round(ev.dx / s)} ${Math.round(ev.dy / s)}`;
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

  return {
    moveRelative: (dx, dy) => write(`rel ${Math.round(dx)} ${Math.round(dy)}`),
    moveAbsolute: (nx, ny) => write(`abs ${clamp01(nx)} ${clamp01(ny)}`),
    button: (which, down) => write(`btn ${which[0]} ${down ? 1 : 0}`),
    scroll: (dx, dy) => write(`scroll ${Math.round(dx)} ${Math.round(dy)}`),
    key: (code, down, mods) => write(
      toMacKeyCode(code) === null ? null : `key ${toMacKeyCode(code)} ${down ? 1 : 0} ${modBits(mods)}`),
    text: (s) => write(`text ${s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`),

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
