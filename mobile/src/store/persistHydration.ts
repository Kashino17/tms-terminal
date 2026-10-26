/**
 * Tracks when a zustand persist store has finished hydrating.
 *
 * zustand's own `onFinishHydration` only fires on success; if reading storage
 * throws, the app would wait forever. `onRehydrateStorage` runs in both cases,
 * so the stores call `complete()` from there.
 */
export interface PersistHydration {
  readonly isDone: boolean;
  complete: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPersistHydration(): PersistHydration {
  let done = false;
  const listeners = new Set<() => void>();

  return {
    get isDone() {
      return done;
    },
    complete() {
      if (done) return;
      done = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
    subscribe(listener) {
      if (done) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
