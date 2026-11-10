/**
 * Watches the Mac's pasteboard through the helper's `--clipboard` mode (see
 * TmsRemoteHelper.swift) and puts text there (process handling: line.watcher.ts).
 */
import * as fs from 'node:fs';
import { helperBinaryPath } from '../remote/paths';
import { logger } from '../utils/logger';
import { startLineWatcher, type ClipboardWatcher } from './line.watcher';

export { parseClipLine } from './line.watcher';

/** The stdin line that puts `text` on the Mac's pasteboard. JSON keeps newlines and quotes intact. */
export function setLine(text: string): string {
  return JSON.stringify({ set: text }) + '\n';
}

export type MacClipboardWatcher = ClipboardWatcher;

export function startMacClipboardWatcher(onCopy: (text: string) => void): ClipboardWatcher | null {
  const bin = helperBinaryPath();
  if (!fs.existsSync(bin)) {
    logger.warn('Zwischenablage: Mac-Helfer fehlt — Kopien vom Mac erscheinen nicht im Verlauf');
    return null;
  }
  return startLineWatcher({ cmd: bin, args: ['--clipboard'], options: { stdio: ['pipe', 'ignore', 'pipe'] }, setLine }, onCopy);
}
