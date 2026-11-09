// Zwischenablage-Verlauf des Bunds — liegt auf dem Handy (durableStorage:
// überlebt APK-Updates und den Fold-Neubau). Regeln: clipboard.core.mjs.
import { durableStorage } from '../../services/durableStorage';
import { addClip, togglePin, removeClip, clearUnpinned } from './clipboard.core.mjs';
import type { Clip } from './clipboard.core.mjs';

const KEY = 'tms-bund-clipboard';
const IMPORTED_KEY = 'tms-bund-clip-imported';

let list: Clip[] = [];
let loading: Promise<void> | null = null;
const subs = new Set<(l: Clip[]) => void>();

function commit(next: Clip[]): void {
  list = next;
  durableStorage.setItem(KEY, JSON.stringify(list)).catch(() => {});
  subs.forEach((fn) => fn(list));
}

export const clipStore = {
  load(): Promise<void> {
    if (!loading) {
      loading = durableStorage.getItem(KEY)
        .then((raw) => { if (raw) list = JSON.parse(raw) as Clip[]; })
        .catch(() => {})
        .then(() => subs.forEach((fn) => fn(list)));
    }
    return loading;
  },
  get(): Clip[] { return list; },
  subscribe(fn: (l: Clip[]) => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  add(entry: { text: string; src: string; at: number }): void { commit(addClip(list, entry)); },
  pin(id: string): void { commit(togglePin(list, id)); },
  remove(id: string): void { commit(removeClip(list, id)); },
  clear(): void { commit(clearUnpinned(list)); },
  /** Einmalig: den bisherigen Server-Verlauf (vom ersten Gerät) übernehmen. */
  async importOnce(srvId: string, items: Array<{ text?: string; source?: string; at?: number }>): Promise<void> {
    await clipStore.load();
    if (await durableStorage.getItem(IMPORTED_KEY).catch(() => null)) return;
    let next = list;
    [...items].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).forEach((it) => {
      if (typeof it.text === 'string') next = addClip(next, { text: it.text, src: it.source === 'phone' ? 'phone' : srvId, at: it.at ?? Date.now() });
    });
    commit(next);
    await durableStorage.setItem(IMPORTED_KEY, '1').catch(() => {});
  },
};

/** Für die bisherige Seite (clipboardSet erwartet das Server-Format). */
export function toLegacyItems(l: Clip[]): Array<{ id: string; text: string; source: 'phone' | 'mac'; at: number }> {
  return l.map((c) => ({ id: c.id, text: c.text, source: c.src === 'phone' ? 'phone' : 'mac', at: c.at }));
}
