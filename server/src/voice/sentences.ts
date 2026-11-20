/**
 * Splits text into pieces the voice speaks one at a time.
 *
 * Each piece is one call to the voice model (~1.2–1.5 s on the Mac whatever
 * the length up to a sentence), so: real sentences, very short ones joined to
 * a neighbour, overlong ones cut at a comma.
 */
export const MAX_SENTENCE = 240;
const MIN_SENTENCE = 28;

/** A full stop after these does not end a sentence. */
const ABBREVIATIONS = new Set(['z', 'b', 'd', 'h', 'u', 'a', 'ca', 'bzw', 'nr', 'vgl', 'ggf', 'evtl', 'inkl', 'usw', 'etc', 'min', 'std', 'sek', 'max', 'mind', 'vs', 'dr', 'e', 'g', 'i']);

function cutLong(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE);
    // Prefer the last comma/semicolon in the second half, else the last space.
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
    if (cut < MAX_SENTENCE / 3) cut = window.lastIndexOf(' ') - 1;
    if (cut < 1) cut = MAX_SENTENCE - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const raw: string[] = [];
  let start = 0;
  const re = /[.!?…]+["”“)\]]?\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const end = m.index + m[0].length;
    if (m[0].trimEnd().startsWith('.')) {
      const before = clean.slice(start, m.index);
      const word = (before.match(/([A-Za-zÄÖÜäöüß]+|\d+)$/) || ['', ''])[1];
      // "z. B.", "ca.", "3. November", "v1.149.0 …": not the end of a sentence.
      if (/^\d+$/.test(word) || ABBREVIATIONS.has(word.toLowerCase())) continue;
    }
    raw.push(clean.slice(start, end).trim());
    start = end;
  }
  if (start < clean.length) raw.push(clean.slice(start).trim());

  // A very short sentence waits for the next one; a short one at the very end
  // joins the one before.
  const joined: string[] = [];
  let buf = '';
  for (const s of raw) {
    buf = buf ? buf + ' ' + s : s;
    if (buf.length >= MIN_SENTENCE) { joined.push(buf); buf = ''; }
  }
  if (buf) {
    const last = joined[joined.length - 1];
    if (last !== undefined && last.length + 1 + buf.length <= MAX_SENTENCE) joined[joined.length - 1] = last + ' ' + buf;
    else joined.push(buf);
  }
  return joined.flatMap(cutLong);
}
