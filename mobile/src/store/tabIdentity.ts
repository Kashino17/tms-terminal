/**
 * Identity rules for stored terminal tabs.
 *
 * A tab is identified by the server's sessionId — stable across app restarts,
 * server restarts (terminal keeper) and devices. Season 2 used to store the
 * page's card id (t1, t2, …) as the tab id, but that counter restarts at t1 on
 * every app start: a new card re-used an id an older stored tab still had.
 * addTab appended a duplicate, and since updateTab/removeTab act on EVERY tab
 * with that id, renaming one terminal renamed the other (titles "swapped" or
 * "duplicated"), and closing one deleted the other's stored title.
 *
 * Pure functions, no React Native imports — tested with node --test
 * (scripts/tab-identity.test.mjs).
 */
import type { TerminalTab } from '../types/terminal.types';

/** Insert, or replace a tab with the same id OR the same sessionId. Never duplicates. */
export function upsertTab(list: TerminalTab[], tab: TerminalTab): TerminalTab[] {
  const same = (t: TerminalTab) => t.id === tab.id || (!!tab.sessionId && t.sessionId === tab.sessionId);
  if (!list.some(same)) return [...list, tab];
  let placed = false;
  const out: TerminalTab[] = [];
  for (const t of list) {
    if (!same(t)) { out.push(t); continue; }
    if (!placed) { out.push(tab); placed = true; }       // replace in place, drop further matches
  }
  return out;
}

/**
 * One-time repair of already stored tabs: id := sessionId where known, one tab
 * per session (a user-named one wins over an auto-named one, otherwise the
 * later entry), and unique ids for tabs that have no session yet.
 */
export function repairTabs(list: TerminalTab[]): TerminalTab[] {
  const bySession = new Map<string, number>();
  const out: TerminalTab[] = [];
  for (const t of list) {
    if (!t.sessionId) { out.push(t); continue; }
    const fixed = t.id === t.sessionId ? t : { ...t, id: t.sessionId };
    const at = bySession.get(t.sessionId);
    if (at === undefined) { bySession.set(t.sessionId, out.length); out.push(fixed); continue; }
    const kept = out[at];
    if (!kept.customTitle || fixed.customTitle) out[at] = fixed;
  }
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    let id = out[i].id;
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}~${n}`)) n++;
      id = `${id}~${n}`;
      out[i] = { ...out[i], id };
    }
    seen.add(id);
  }
  return out;
}
