/**
 * Terminal titles arrive as OSC escape sequences inside the ordinary output
 * stream. manager.service.ts strips them (ANSI_STRIP), so this must run BEFORE
 * that strip or there is nothing left to read.
 *
 * Verified on 2026-07-28 with scripts/probe-osc.ts: Claude Code really does emit
 * `ESC ] 0 ; ✳ Claude Code BEL` into the pty, and node-pty passes it through.
 */

// OSC 0/1/2 set the title. OSC 7 (cwd) and OSC 8 (hyperlinks) also occur in the
// stream and are deliberately excluded.
const TITLE_RE = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Longest partial sequence we are willing to hold while waiting for a terminator. */
const MAX_PARTIAL = 4096;

export function extractOscTitles(chunk: string): string[] {
  const titles: string[] = [];
  TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TITLE_RE.exec(chunk)) !== null) {
    // The shell clears the title with a bare `ESC ] 0 ; BEL` — not a real topic.
    if (m[1] !== '') titles.push(m[1]);
  }
  return titles;
}

export class OscTitleTracker {
  private titles = new Map<string, string>();
  private partials = new Map<string, string>();

  /** Returns the new title when it changed, otherwise null. */
  feed(sessionId: string, chunk: string): string | null {
    const combined = (this.partials.get(sessionId) ?? '') + chunk;
    const found = extractOscTitles(combined);

    // Keep whatever follows the last complete sequence, in case a new one is
    // half-arrived. Without this, a title split across two reads is lost.
    const lastEnd = this.lastSequenceEnd(combined);
    let rest = lastEnd >= 0 ? combined.slice(lastEnd) : combined;
    const openIdx = rest.lastIndexOf('\x1b]');
    rest = openIdx >= 0 ? rest.slice(openIdx) : '';
    this.partials.set(sessionId, rest.length <= MAX_PARTIAL ? rest : '');

    if (found.length === 0) return null;
    const latest = found[found.length - 1];
    if (this.titles.get(sessionId) === latest) return null;
    this.titles.set(sessionId, latest);
    return latest;
  }

  getTitle(sessionId: string): string | undefined {
    return this.titles.get(sessionId);
  }

  clear(sessionId: string): void {
    this.titles.delete(sessionId);
    this.partials.delete(sessionId);
  }

  private lastSequenceEnd(s: string): number {
    TITLE_RE.lastIndex = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = TITLE_RE.exec(s)) !== null) end = m.index + m[0].length;
    return end;
  }
}
