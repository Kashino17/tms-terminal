/**
 * AsyncStorage plus a file copy, for the few keys that must never be lost.
 *
 * Why: on Android, AsyncStorage deleted its WHOLE database whenever opening it
 * failed once (ReactDatabaseSupplier.ensureDatabase) — triggered by unfolding
 * the Galaxy Fold, which recreated the Activity and closed the database under
 * in-flight writes. Servers, settings (Season 2 switched back off) and terminal
 * tabs were gone, permanently. The native side is patched now
 * (patches/@react-native-async-storage+async-storage+*.patch); this is the
 * second line of defense against any other wipe.
 *
 * Plain JavaScript (not TS) so scripts/durable-storage.test.mjs can run it
 * under node:test; types live in durableStorage.core.d.mts.
 *
 * Rules:
 *  - Reads come from AsyncStorage. Only when it returns nothing or throws does
 *    the file copy answer — and it is written back to heal AsyncStorage.
 *  - Writes go to both. One failing side is fine as long as the other holds the
 *    value; only when both fail does the caller see the error.
 *  - Removes go to both, so a deleted value never comes back.
 *  - The first read of a key per app start copies AsyncStorage's value to the
 *    file, so data from before this existed (rarely rewritten — the server
 *    list) is covered without waiting for its next write.
 *  - File writes per key run one at a time and coalesce: a burst of writes ends
 *    with the newest value on disk without writing every step.
 */

const REMOVE = Symbol('remove');

/**
 * @param {{getItem(k:string):Promise<string|null>, setItem(k:string,v:string):Promise<void>, removeItem(k:string):Promise<void>}} primary
 * @param {{read(k:string):Promise<string|null>, write(k:string,v:string):Promise<void>, remove(k:string):Promise<void>}} mirror
 */
export function createDurableStorage(primary, mirror) {
  /** @type {Map<string, {next: any, hasNext: boolean, running: Promise<boolean> | null}>} */
  const slots = new Map();
  /** Keys whose file copy is current for this app start (read-seeded or written). */
  const seeded = new Set();

  /** Queue a file write/remove for `key`; resolves true when the newest value landed. */
  function toMirror(key, value) {
    let slot = slots.get(key);
    if (!slot) {
      slot = { next: undefined, hasNext: false, running: null };
      slots.set(key, slot);
    }
    slot.next = value;
    slot.hasNext = true;
    if (!slot.running) slot.running = drain(key, slot);
    return slot.running;
  }

  async function drain(key, slot) {
    let ok = true;
    try {
      while (slot.hasNext) {
        const value = slot.next;
        slot.hasNext = false;
        try {
          if (value === REMOVE) await mirror.remove(key);
          else await mirror.write(key, value);
          ok = true;
        } catch {
          ok = false;
        }
      }
    } finally {
      slot.running = null;
    }
    return ok;
  }

  return {
    async getItem(key) {
      let value = null;
      try {
        value = await primary.getItem(key);
      } catch {
        value = null;
      }
      if (value != null) {
        if (!seeded.has(key)) {
          seeded.add(key);
          toMirror(key, value).catch(() => {});
        }
        return value;
      }

      let backup = null;
      try {
        backup = await mirror.read(key);
      } catch {
        return null;
      }
      if (backup == null) return null;
      primary.setItem(key, backup).catch(() => {});
      return backup;
    },

    async setItem(key, value) {
      seeded.add(key);
      const [p, m] = await Promise.allSettled([primary.setItem(key, value), toMirror(key, value)]);
      const mirrored = m.status === 'fulfilled' && m.value === true;
      if (p.status === 'rejected' && !mirrored) throw p.reason;
    },

    async removeItem(key) {
      seeded.add(key);
      await Promise.allSettled([primary.removeItem(key), toMirror(key, REMOVE)]);
    },
  };
}
