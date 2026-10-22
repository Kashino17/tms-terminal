import type { RemoteGesture } from '../../../../shared/protocol';

export interface Mods { s: boolean; c: boolean; a: boolean; m: boolean }

/** Turns remote input events into real system input. Platform backends implement this. */
export interface InputInjector {
  /**
   * Resolves once the backend's helper process has actually confirmed it is
   * reading input, or rejects if it never gets there (permission denied,
   * crashed, timed out). Both platform backends have this startup race
   * (macOS: framework loading + the Accessibility check; Windows: Add-Type
   * compiling the embedded C# on first run — I11 in the Schlussprüfung
   * found the interface here still claimed otherwise) and both wait on it
   * via the shared input/ready.ts. Typed optional only because a future
   * backend without such a race is allowed to skip it entirely.
   * `remote.socket.ts` awaits this (inside its existing try/catch, so a
   * rejection reaches the client as `remote:error` instead of hanging the
   * connection) before replying `remote:started`, so the app's first burst
   * of input can never arrive while the helper is still starting up and
   * silently vanish.
   */
  ready?: Promise<void>;
  moveRelative(dx: number, dy: number): void;
  /** Normalised 0..1 across the captured screen. */
  moveAbsolute(nx: number, ny: number): void;
  button(which: 'left' | 'right' | 'middle', down: boolean): void;
  scroll(dx: number, dy: number): void;
  /** `code` is a DOM KeyboardEvent.code — the key's position, not its character. */
  key(code: string, down: boolean, mods: Mods): void;
  text(s: string): void;
  /** Multi-finger trackpad gesture → the platform's own action (see gestures.ts). */
  gesture(g: RemoteGesture): void;
  stop(): Promise<void>;
}
