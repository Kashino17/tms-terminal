import type { Mods } from './input.types';

/**
 * Tracks which keys and mouse buttons a backend has actually told the OS are
 * currently down, so `stop()` can release exactly those before killing the
 * helper process (I5).
 *
 * Without this, a helper killed while a key or mouse button is held —
 * network dropping mid-drag, a locked Cmd key, the process crashing — leaves
 * that press physically stuck on the PC, and it is *unrecoverable*: a
 * reconnect spins up a brand new helper with an empty state of its own, and
 * the client side (bridge.js's releaseAllSticky/releaseHardwareInput) is
 * gone too if the page itself reloaded. The server is the one place that can
 * still know what it told the OS to hold down, so it has to be the one that
 * lets go.
 */
export interface HeldState {
  /** Call this on every key() the backend actually sends to the helper. */
  trackKey(code: string, down: boolean, mods: Mods): void;
  /** Call this on every button() the backend actually sends to the helper. */
  trackButton(which: 'left' | 'right' | 'middle', down: boolean): void;
  /** Everything currently tracked as down. */
  held(): { keys: Array<{ code: string; mods: Mods }>; buttons: Array<'left' | 'right' | 'middle'> };
}

export function createHeldState(): HeldState {
  const keys = new Map<string, Mods>();
  const buttons = new Set<'left' | 'right' | 'middle'>();
  return {
    trackKey(code, down, mods) {
      if (down) keys.set(code, mods); else keys.delete(code);
    },
    trackButton(which, down) {
      if (down) buttons.add(which); else buttons.delete(which);
    },
    held() {
      return {
        keys: Array.from(keys, ([code, mods]) => ({ code, mods })),
        buttons: Array.from(buttons),
      };
    },
  };
}
