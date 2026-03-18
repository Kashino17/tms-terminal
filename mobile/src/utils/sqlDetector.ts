import { ANSI_RE, stripAnsi as _stripAnsiUtil } from './stripAnsi';

// Rolling detection buffers per session (module-level, survives component unmounts)
const SQL_BUFFER_MAX = 200_000; // 200 KB per session
const detectionBuffers = new Map<string, string>();

// Content hashes of already-extracted SQL, per session (avoids duplicates)
const seenHashes = new Map<string, Set<string>>();
const MAX_SEEN_HASHES = 1000;

// ── Pattern 1: markdown SQL code blocks ──────────────────────────────────────
const CODE_BLOCK_RE = /```(?:sql|postgresql|postgres|pgsql|mysql|sqlite|plpgsql)[^\n]*\n([\s\S]*?)```/gi;

// ── Pattern 2: raw SQL statements (not in code blocks) ───────────────────────
// No line-start anchor — Claude Code indents output with spaces/bullet chars,
// so we match SQL keywords anywhere in the text.
const PLAIN_SQL_RE = /((?:SELECT|INSERT\s+INTO?|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|OR\s+REPLACE\s+VIEW|INDEX|VIEW|DATABASE|SCHEMA)|DROP\s+(?:TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE)\b[\s\S]*?;)/gim;

// ── Helpers ───────────────────────────────────────────────────────────────────
function contentHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function hashKey(s: string): string {
  // Normalize whitespace so the same SQL with different formatting deduplicates
  const normalized = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return contentHash(normalized).toString(36);
}

export function stripAnsi(raw: string): string {
  return _stripAnsiUtil(raw);
}

/**
 * Appends a raw terminal output chunk to the per-session rolling buffer,
 * scans for SQL (markdown code blocks AND plain statements), and returns
 * any newly detected SQL strings.
 *
 * Deduplicates by content hash so the same block is never returned twice.
 */
export function appendAndExtract(sessionId: string, rawChunk: string): string[] {
  // Store RAW data in the buffer so that ANSI escape sequences spanning chunk
  // boundaries are preserved intact, then strip the whole combined buffer once.
  const prev = detectionBuffers.get(sessionId) ?? '';
  const combined = prev + rawChunk;
  const capped =
    combined.length > SQL_BUFFER_MAX
      ? combined.slice(combined.length - SQL_BUFFER_MAX)
      : combined;
  detectionBuffers.set(sessionId, capped);

  // Strip ANSI codes from the whole buffer at once, then normalize line endings
  const clean = stripAnsi(capped).replace(/\r\n?/g, '\n');

  if (!seenHashes.has(sessionId)) seenHashes.set(sessionId, new Set());
  const seen = seenHashes.get(sessionId)!;

  // Prevent unbounded growth of the seen-hashes set
  if (seen.size > MAX_SEEN_HASHES) seen.clear();

  const newBlocks: string[] = [];

  // ── 1. Markdown code blocks ───────────────────────────────────────────────
  // After extracting, mask those regions so plain SQL scanner skips them
  let cleanForPlain = clean;
  CODE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_BLOCK_RE.exec(clean)) !== null) {
    const sql = m[1].trim();
    if (!sql) continue;
    const h = hashKey(sql);
    if (!seen.has(h)) {
      seen.add(h);
      newBlocks.push(sql);
    }
    // Mask this code block with spaces so plain SQL won't re-detect it
    cleanForPlain =
      cleanForPlain.slice(0, m.index) +
      ' '.repeat(m[0].length) +
      cleanForPlain.slice(m.index + m[0].length);
  }

  // ── 2. Plain SQL statements (only outside code blocks) ──────────────────
  PLAIN_SQL_RE.lastIndex = 0;
  while ((m = PLAIN_SQL_RE.exec(cleanForPlain)) !== null) {
    const sql = m[1].trim();
    // Minimum quality: must span multiple lines OR be > 30 chars
    if (!sql || (sql.length <= 30 && !sql.includes('\n'))) continue;
    const h = hashKey(sql);
    if (!seen.has(h)) {
      seen.add(h);
      newBlocks.push(sql);
    }
  }

  return newBlocks;
}

/** Call when a terminal session is permanently closed. */
export function clearDetectionBuffer(sessionId: string): void {
  detectionBuffers.delete(sessionId);
  seenHashes.delete(sessionId);
}
