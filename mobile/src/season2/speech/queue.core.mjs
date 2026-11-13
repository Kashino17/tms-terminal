/**
 * Plays spoken pieces in order as they arrive (reader "Vorlesen" in the cloned
 * voice). Pieces come one sentence at a time while earlier ones are already
 * playing; each is prepared the moment it arrives, so the next sentence starts
 * without a loading gap.
 *
 * Pure sequencing — the sound itself comes from `load` (expo-av in the app, a
 * fake in the tests):
 *   load(chunk) → Promise<{ play(onEnd): void, unload(): void }>
 */
export function createSpeechQueue({ load, onPart, onPlayed, onDone, onError }) {
  const chunks = new Map();   // seq → chunk
  const loaded = new Map();   // seq → Promise<player | null>
  let next = 0;
  let playing = false;
  let stopped = false;
  let current = null;

  function finish(error) {
    if (stopped) return;
    stopped = true;
    for (const p of loaded.values()) p.then((pl) => { if (pl && pl !== current) pl.unload(); }, () => {});
    if (current) { current.unload(); current = null; }
    loaded.clear(); chunks.clear();
    if (error) onError(error); else onDone();
  }

  async function pump() {
    if (playing || stopped) return;
    const chunk = chunks.get(next);
    if (!chunk) return; // not here yet — the voice is still working on it
    playing = true;
    let player = null;
    try { player = await loaded.get(next); } catch (e) { finish(String((e && e.message) || e || 'Ton ließ sich nicht laden')); return; }
    if (stopped) { if (player) player.unload(); return; }
    const seq = next;
    const ended = () => {
      if (stopped) return;
      if (player) player.unload();
      current = null;
      loaded.delete(seq); chunks.delete(seq);
      playing = false;
      next = seq + 1;
      if (chunk.last) finish(null); else pump();
    };
    onPlayed(seq);
    if (chunk.first) onPart(chunk.index);
    if (!player) { ended(); return; } // nothing to hear in this piece
    current = player;
    player.play(ended);
  }

  return {
    push(chunk) {
      if (stopped || chunks.has(chunk.seq) || chunk.seq < next) return;
      chunks.set(chunk.seq, chunk);
      loaded.set(chunk.seq, chunk.audio ? load(chunk) : Promise.resolve(null));
      loaded.get(chunk.seq).catch(() => {}); // reported when its turn comes
      pump();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const p of loaded.values()) p.then((pl) => { if (pl && pl !== current) pl.unload(); }, () => {});
      if (current) { current.unload(); current = null; }
      loaded.clear(); chunks.clear();
    },
    get stopped() { return stopped; },
  };
}
