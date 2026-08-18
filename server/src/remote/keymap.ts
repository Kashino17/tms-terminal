/**
 * DOM KeyboardEvent.code → platform key codes.
 *
 * The app sends the key's *position*, never its character: the target system
 * applies its own layout. Sending characters would make a German keyboard on the
 * phone type Y where the Mac expects Z.
 */
const MAC: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23,
  Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29,
  BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35,
  Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42,
  Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49,
  Backquote: 50, Backspace: 51, Escape: 53,
  MetaLeft: 55, MetaRight: 55, ShiftLeft: 56, ShiftRight: 56, CapsLock: 57,
  AltLeft: 58, AltRight: 58, ControlLeft: 59, ControlRight: 59,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,
  Home: 115, PageUp: 116, Delete: 117, End: 119, PageDown: 121,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

const WIN_NAMED: Record<string, number> = {
  Enter: 0x0d, Backspace: 0x08, Tab: 0x09, Escape: 0x1b, Space: 0x20,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5b, MetaRight: 0x5c, CapsLock: 0x14,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Delete: 0x2e, Insert: 0x2d,
  Minus: 0xbd, Equal: 0xbb, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
  Semicolon: 0xba, Quote: 0xde, BracketLeft: 0xdb, BracketRight: 0xdd,
  Backslash: 0xdc, Backquote: 0xc0,
};

export function toMacKeyCode(code: string): number | null {
  return code in MAC ? MAC[code] : null;
}

export function toWinVirtualKey(code: string): number | null {
  if (!code) return null;
  if (code in WIN_NAMED) return WIN_NAMED[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].charCodeAt(0);            // 'A' = 0x41
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return 0x30 + Number(digit[1]);
  const fkey = /^F([1-9]|1[0-2])$/.exec(code);
  if (fkey) return 0x6f + Number(fkey[1]);               // F1 = 0x70
  return null;
}
