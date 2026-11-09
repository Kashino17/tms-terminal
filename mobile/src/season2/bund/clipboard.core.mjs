/**
 * Zwischenablage-Verlauf auf dem Handy (Bund). Jedes Gerät meldet seine Kopien,
 * das Handy hält den Verlauf. Reine Funktionen, unter node:test geprüft
 * (scripts/bund-clipboard.test.mjs).
 *
 * Eintrag: { id, text, src: 'phone' | <serverId>, at, pinned }
 */
export const CLIP_LIMIT = 200;

let seq = 0;
const newId = (at) => `c${at.toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Neu oben; gleicher Text rückt nach oben (neue Quelle/Zeit, Anheften bleibt). */
export function addClip(list, { text, src, at }) {
  if (typeof text !== 'string' || !text.trim()) return list;
  const prev = list.find((c) => c.text === text);
  const rest = list.filter((c) => c.text !== text);
  const item = prev ? { ...prev, src, at } : { id: newId(at), text, src, at, pinned: false };
  const next = [item, ...rest];
  let unpinned = 0;
  return next.filter((c) => c.pinned || ++unpinned <= CLIP_LIMIT);
}

export function togglePin(list, id) {
  return list.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c));
}

export function removeClip(list, id) {
  return list.filter((c) => c.id !== id);
}

export function clearUnpinned(list) {
  return list.filter((c) => c.pinned);
}
