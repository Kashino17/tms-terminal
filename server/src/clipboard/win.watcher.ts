/**
 * Windows side of the shared clipboard: clipboard-helper.ps1 listens for
 * copies (AddClipboardFormatListener) and puts text from the phone there.
 */
import * as fs from 'node:fs';
import { winClipboardScriptPath } from '../remote/paths';
import { logger } from '../utils/logger';
import { startLineWatcher, type ClipboardWatcher } from './line.watcher';

/** stdin line for the helper: Base64 keeps newlines, quotes and non-ASCII intact. */
export function winSetLine(text: string): string {
  return 'set ' + Buffer.from(text, 'utf8').toString('base64') + '\n';
}

export function startWinClipboardWatcher(onCopy: (text: string) => void): ClipboardWatcher | null {
  const script = winClipboardScriptPath();
  if (!fs.existsSync(script)) {
    logger.warn('Zwischenablage: Windows-Helfer fehlt — Kopien vom PC erscheinen nicht im Verlauf');
    return null;
  }
  return startLineWatcher({
    cmd: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    options: { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    setLine: winSetLine,
  }, onCopy);
}
