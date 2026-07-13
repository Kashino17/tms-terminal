export interface ByteRange { start: number; end: number; }

/**
 * Parse an HTTP Range header against a file size.
 * Returns null when the header should be ignored (serve full 200),
 * 'unsatisfiable' for syntactically valid but unservable ranges (416),
 * or an inclusive byte window.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;                      // malformed or multi-range: ignore
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {                    // suffix: last N bytes
    const n = parseInt(rawEnd, 10);
    if (n <= 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = parseInt(rawStart, 10);
  const end = rawEnd === '' ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
