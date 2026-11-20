/**
 * Runs a clipboard helper process (Mac: Swift helper `--clipboard`, Windows:
 * clipboard-helper.ps1), reads its stderr status lines and writes "set" lines
 * to its stdin. Restarts the helper if it dies, with a growing pause so a
 * helper that can't start doesn't spin.
 */
import { spawn, ChildProcess, SpawnOptions } from 'node:child_process';
import { splitLines } from '../remote/lines';

/** One helper status line → the copied text, or null for anything else. */
export function parseClipLine(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { clip?: { text?: unknown } };
    const text = obj?.clip?.text;
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export interface ClipboardWatcher { set(text: string): void; stop(): void }

export interface HelperSpec {
  cmd: string;
  args: string[];
  options: SpawnOptions;
  /** One stdin line (incl. newline) that puts `text` on this computer's clipboard. */
  setLine(text: string): string;
}

export function startLineWatcher(spec: HelperSpec, onCopy: (text: string) => void): ClipboardWatcher {
  let child: ChildProcess | null = null;
  let stopped = false;
  let backoffMs = 1000;
  let restartTimer: NodeJS.Timeout | null = null;

  const launch = (): void => {
    const p = spawn(spec.cmd, spec.args, spec.options);
    child = p;
    const startedAt = Date.now();
    let rest = '';
    p.stdin?.on('error', () => {});
    p.stderr?.setEncoding('utf8'); // multi-byte characters may be split across chunks
    p.stderr?.on('data', (chunk: string) => {
      const r = splitLines(rest, chunk);
      rest = r.rest;
      for (const line of r.lines) {
        const text = parseClipLine(line);
        if (text !== null) onCopy(text);
      }
    });
    p.on('error', () => {});
    p.on('exit', () => {
      if (child === p) child = null;
      if (stopped) return;
      // Ran for a while = a one-off crash, start over quickly; else back off.
      backoffMs = Date.now() - startedAt > 60_000 ? 1000 : Math.min(backoffMs * 2, 60_000);
      restartTimer = setTimeout(launch, backoffMs);
      restartTimer.unref();
    });
  };
  launch();

  return {
    set(text: string): void {
      if (child?.stdin?.writable) child.stdin.write(spec.setLine(text));
    },
    stop(): void {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.stdin?.end();
      child?.kill();
      child = null;
    },
  };
}
