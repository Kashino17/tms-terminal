/**
 * Watches the Mac's pasteboard through the helper's `--clipboard` mode (see
 * TmsRemoteHelper.swift) and puts text there. Restarts the helper if it dies,
 * with a growing pause so a helper that can't start doesn't spin.
 */
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { helperBinaryPath } from '../remote/paths';
import { splitLines } from '../remote/lines';
import { logger } from '../utils/logger';

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

/** The stdin line that puts `text` on the Mac's pasteboard. JSON keeps newlines and quotes intact. */
export function setLine(text: string): string {
  return JSON.stringify({ set: text }) + '\n';
}

export interface MacClipboardWatcher { set(text: string): void; stop(): void }

export function startMacClipboardWatcher(onCopy: (text: string) => void): MacClipboardWatcher | null {
  const bin = helperBinaryPath();
  if (!fs.existsSync(bin)) {
    logger.warn('Zwischenablage: Mac-Helfer fehlt — Kopien vom Mac erscheinen nicht im Verlauf');
    return null;
  }
  let child: ChildProcess | null = null;
  let stopped = false;
  let backoffMs = 1000;
  let restartTimer: NodeJS.Timeout | null = null;

  const launch = (): void => {
    const p = spawn(bin, ['--clipboard'], { stdio: ['pipe', 'ignore', 'pipe'] });
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
      if (child?.stdin?.writable) child.stdin.write(setLine(text));
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
