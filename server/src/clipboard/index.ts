/**
 * The server's one shared clipboard: history store + Mac pasteboard watcher,
 * and whoever wants to hear about changes (the WebSocket handler broadcasts
 * them to every connected app).
 */
import * as path from 'node:path';
import { config, loadServerConfig } from '../config';
import { getPlatform } from '../utils/platform';
import { ClipboardStore, type ClipChange, type ClipItem } from './clipboard.store';
import { startMacClipboardWatcher } from './mac.watcher';
import { startWinClipboardWatcher } from './win.watcher';
import type { ClipboardWatcher } from './line.watcher';

export type ClipEvent =
  | { kind: 'added'; change: ClipChange }
  | { kind: 'removed'; ids: string[] };

const store = new ClipboardStore(path.join(config.configDir, 'clipboard.json'));
const listeners = new Set<(ev: ClipEvent) => void>();
let watcher: ClipboardWatcher | null = null;

function emit(ev: ClipEvent): void {
  for (const fn of listeners) { try { fn(ev); } catch { /* one bad listener must not stop the rest */ } }
}

/** Off only when `clipboardSync: false` is in ~/.tms-terminal/config.json. */
export function isClipboardSyncEnabled(): boolean {
  return loadServerConfig().clipboardSync !== false;
}

export const clipboardHub = {
  start(): void {
    if (watcher || !isClipboardSyncEnabled()) return;
    // 'mac' = "copied on this computer" (also on Windows; the app files it under the device).
    const onCopy = (text: string): void => {
      const change = store.add(text, 'mac');
      if (change) emit({ kind: 'added', change });
    };
    const platform = getPlatform();
    if (platform === 'darwin') watcher = startMacClipboardWatcher(onCopy);
    else if (platform === 'win32') watcher = startWinClipboardWatcher(onCopy);
  },
  stop(): void {
    watcher?.stop();
    watcher = null;
    void store.flush();
  },
  onChange(fn: (ev: ClipEvent) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  list(): ClipItem[] { return store.list(); },
  /** Copied on the phone: into the history and onto this computer's clipboard (⌘V / Strg+V). */
  addFromPhone(text: string): void {
    const change = store.add(text, 'phone');
    if (!change) return;
    watcher?.set(text);
    emit({ kind: 'added', change });
  },
  /** An older entry picked again: back on top and onto the Mac's pasteboard. */
  use(id: string): void {
    const item = store.list().find((x) => x.id === id);
    if (!item) return;
    watcher?.set(item.text);
    const change = store.add(item.text, item.source);
    if (change) emit({ kind: 'added', change });
  },
  remove(id: string): void {
    if (store.remove(id)) emit({ kind: 'removed', ids: [id] });
  },
  clear(): void {
    const ids = store.clear();
    if (ids.length) emit({ kind: 'removed', ids });
  },
};
