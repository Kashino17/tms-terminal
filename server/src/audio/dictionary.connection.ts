// Messages of the dictation dictionary. The settings page of the app shows and
// edits the dictionary of the machine that transcribes:
//
//   dict:get {}                          → dict:state to the asker
//   dict:add { term }                    ┐
//   dict:update { id, term?, heard? }    ├ → dict:state to every connected app
//   dict:remove { id }                   ┘   (to the asker only if nothing changed)
//
// dict:state carries the entries and the speed of the last dictations
// (numbers only) — everything the page's "Diktat & Sprache" needs.

import type { DictionaryStore, DictEntry } from './dictionary';
import type { DictationStatsStore, DictationSummary } from './dictation.stats';

export interface DictStateMessage { type: 'dict:state'; payload: { entries: DictEntry[]; speed: DictationSummary } }

/** Handles a `dict:*` message. Returns false for anything else. */
export function handleDictionaryMessage(
  store: DictionaryStore,
  stats: DictationStatsStore,
  msg: { type?: unknown; payload?: unknown },
  reply: (m: DictStateMessage) => void,
  broadcast: (m: DictStateMessage) => void,
): boolean {
  const type = msg.type;
  if (type !== 'dict:get' && type !== 'dict:add' && type !== 'dict:update' && type !== 'dict:remove') return false;
  const p = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>;
  const state = (): DictStateMessage => ({ type: 'dict:state', payload: { entries: store.list(), speed: stats.summary() } });
  let changed = false;
  if (type === 'dict:add') {
    changed = typeof p.term === 'string' && store.add(p.term) !== null;
  } else if (type === 'dict:update') {
    if (typeof p.id === 'string') {
      const patch: { term?: string; heard?: string[] } = {};
      if (typeof p.term === 'string') patch.term = p.term;
      if (Array.isArray(p.heard)) patch.heard = p.heard.filter((h): h is string => typeof h === 'string');
      changed = (patch.term !== undefined || patch.heard !== undefined) && store.update(p.id, patch) !== null;
    }
  } else if (type === 'dict:remove') {
    changed = typeof p.id === 'string' && store.remove(p.id);
  }
  if (changed) broadcast(state()); else reply(state());
  return true;
}
