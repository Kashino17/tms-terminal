export interface Mods { s: boolean; c: boolean; a: boolean; m: boolean }

/** Turns remote input events into real system input. Platform backends implement this. */
export interface InputInjector {
  moveRelative(dx: number, dy: number): void;
  /** Normalised 0..1 across the captured screen. */
  moveAbsolute(nx: number, ny: number): void;
  button(which: 'left' | 'right' | 'middle', down: boolean): void;
  scroll(dx: number, dy: number): void;
  /** `code` is a DOM KeyboardEvent.code — the key's position, not its character. */
  key(code: string, down: boolean, mods: Mods): void;
  text(s: string): void;
  stop(): Promise<void>;
}
