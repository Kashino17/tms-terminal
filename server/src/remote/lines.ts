/**
 * A `data` event can split a line anywhere, including mid-JSON or mid-number —
 * buffer the tail and only hand back lines once a `\n` has actually arrived.
 *
 * Shared between the macOS and Windows capture backends (and anything else
 * that reads newline-delimited status lines from a child process's stdout or
 * stderr): a status line torn across two `data` events must not be silently
 * dropped, or a caller waiting on it — like `ScreenCapture.start()` waiting
 * for the reported screen size — would hang forever. This exact bug was once
 * fixed only for macOS and then re-introduced for Windows via copy-paste of
 * the pre-fix version, which is why there is now a single implementation
 * instead of one per platform.
 */
export function splitLines(buffered: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffered + chunk;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}
