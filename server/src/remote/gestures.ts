import type { RemoteGesture } from '../../../shared/protocol';

/**
 * Multi-finger gestures from the app's trackpad → the platform's own action.
 *
 * The directions follow a real Mac trackpad: fingers swiping LEFT pull in the
 * space on the RIGHT. Pinching in (five fingers together) opens the search —
 * the user asked for Spotlight there instead of Launchpad; spreading out shows
 * the desktop, like the real four-finger spread.
 */

/**
 * macOS symbolic hot key IDs (the WindowServer's names for the shortcuts in
 * System Settings › Keyboard › Shortcuts). The helper fires them directly, so
 * they work even when the user switched the key combination itself off.
 */
export const MAC_GESTURE_HOTKEY: Record<RemoteGesture, number> = {
  'swipe-left': 81,   // move one space right
  'swipe-right': 79,  // move one space left
  'swipe-up': 32,     // Mission Control
  'swipe-down': 33,   // application windows (App Exposé)
  'pinch-in': 64,     // Spotlight
  'pinch-out': 36,    // show desktop
};

/**
 * Windows key combos (DOM codes, pressed in order, released in reverse).
 * Windows has no hidden "shortcut switched off" state for these, so plain
 * key presses are enough.
 */
export const WIN_GESTURE_KEYS: Record<RemoteGesture, string[]> = {
  'swipe-left': ['ControlLeft', 'MetaLeft', 'ArrowRight'], // next virtual desktop
  'swipe-right': ['ControlLeft', 'MetaLeft', 'ArrowLeft'], // previous virtual desktop
  'swipe-up': ['MetaLeft', 'Tab'],                         // Task View
  'swipe-down': ['MetaLeft', 'KeyD'],                      // show desktop
  'pinch-in': ['MetaLeft', 'KeyS'],                        // search
  'pinch-out': ['MetaLeft', 'KeyD'],                       // show desktop
};

export function isRemoteGesture(g: unknown): g is RemoteGesture {
  return typeof g === 'string' && Object.prototype.hasOwnProperty.call(MAC_GESTURE_HOTKEY, g);
}
