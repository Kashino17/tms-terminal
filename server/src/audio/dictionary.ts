/**
 * The dictation dictionary: terms the speaker uses and the ways they get
 * misheard. It works in two places and costs no waiting time:
 *
 *  - the terms are handed to Whisper as its prompt, so they are heard right;
 *  - known mishearings are replaced in the transcript — plain search and
 *    replace on whole words, never inside a word.
 *
 * Kept on the machine that transcribes, in ~/.tms-terminal/dictionary.json
 * (atomic write, owner-only). The user sees and edits every entry in the app.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface DictEntry {
  id: string;
  /** The right spelling. */
  term: string;
  /** Ways it has been misheard; each is replaced by `term`. */
  heard: string[];
  /** 'seed' = shipped, 'manual' = added by the user, 'learned' = picked up from a correction. */
  source: 'seed' | 'manual' | 'learned';
  /** How often a mishearing of it was replaced. */
  uses: number;
  createdAt: number;
  /** Set by `list()`: the term fits into what Whisper is told to listen for. */
  inPrompt?: boolean;
}

const MAX_LEN = 60;
/**
 * Whisper only reads about 220 tokens of its prompt and keeps the END when it
 * is longer. 480 characters stay safely below that (measured: 508 characters
 * of mixed German/technical terms are 188 tokens).
 */
const PROMPT_MAX_CHARS = 480;
const MAX_ENTRIES = 500;
const MAX_HEARD = 20;

/** What the fixed prompt and the rewriter's correction list held before the dictionary existed. */
export const DICTIONARY_SEED: Array<{ term: string; heard?: string[] }> = [
  { term: 'TMS Terminal' }, { term: 'TMS', heard: ['T M S'] }, { term: 'Claude Code', heard: ['Cloud Code'] },
  { term: 'Fernzugriff' }, { term: 'TypeScript' }, { term: 'React Native', heard: ['React Nativ'] }, { term: 'Expo' },
  { term: 'WebView', heard: ['Web View'] }, { term: 'Tailscale', heard: ['Tail Scale'] }, { term: 'Git' }, { term: 'Commit' },
  { term: 'Branch' }, { term: 'Worktree', heard: ['Work Tree'] }, { term: 'Server' }, { term: 'Terminal' }, { term: 'Prompt' },
  { term: 'Refactoring' }, { term: 'Build' }, { term: 'Release' }, { term: 'APK' }, { term: 'Hook' }, { term: 'Store' },
  { term: 'Component' }, { term: 'API' }, { term: 'WebSocket' }, { term: 'ptyd', heard: ['P T Y D'] }, { term: 'MLX' },
  { term: 'Whisper' }, { term: 'sudo' }, { term: 'macOS' }, { term: 'Keychain' }, { term: 'Touch ID' }, { term: 'Galaxy Fold' },
];

/** Trimmed, control characters removed, inner whitespace collapsed, at most 60 characters. */
function clean(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN).trim();
}
const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
/** A mishearing must hold something that can be heard: at least one letter or digit. */
const audible = (s: string) => /[\p{L}\p{N}]/u.test(s);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces every known mishearing by its term: whole words / word sequences
 * only, any capitalisation, the longest mishearing first. `hits` counts the
 * replacements per entry id.
 */
export function applyDictionary(text: string, entries: DictEntry[]): { text: string; hits: Record<string, number> } {
  const byHeard = new Map<string, DictEntry>();
  for (const e of entries) for (const h of e.heard) if (h && !byHeard.has(key(h))) byHeard.set(key(h), e);
  const hits: Record<string, number> = {};
  if (byHeard.size === 0 || !text) return { text, hits };
  // A single word joined to a letter by a hyphen is part of a compound
  // ("Stock-Foto", "E-Mail") and is left alone; a phrase may be followed by one
  // ("Cloud Code-Sitzung").
  const alternatives = [...byHeard.keys()].sort((a, b) => b.length - a.length).map((h) => {
    const words = h.split(' ').map(escapeRegExp);
    return words.length > 1 ? words.join('\\s+') : `(?<![\\p{L}\\p{N}]-)${words[0]}(?!-[\\p{L}\\p{N}])`;
  });
  // A word boundary that knows umlauts: no letter or digit right before or after.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const out = text.replace(re, (m) => {
    const e = byHeard.get(key(m));
    if (!e) return m;
    hits[e.id] = (hits[e.id] ?? 0) + 1;
    return e.term;
  });
  return { text: out, hits };
}

/**
 * The entries Whisper is told to listen for, in order: the user's own terms
 * first (newest first), then the shipped ones in their shipped order — and only
 * as many as fit into `maxChars`. (Not ranked by `uses`: that only counts
 * replaced mishearings, so a term that is heard right thanks to the prompt
 * would never rise.)
 */
export function promptEntries(entries: DictEntry[], maxChars = PROMPT_MAX_CHARS): DictEntry[] {
  const mine = entries.filter((e) => e.source !== 'seed').sort((a, b) => b.createdAt - a.createdAt);
  const shipped = entries.filter((e) => e.source === 'seed').sort((a, b) => a.createdAt - b.createdAt);
  const out: DictEntry[] = [];
  let len = 1;                                             // the closing full stop
  for (const e of [...mine, ...shipped]) {
    const add = e.term.length + (out.length ? 2 : 0);
    if (len + add > maxChars) break;
    out.push(e);
    len += add;
  }
  return out;
}

/** The terms as a prompt for Whisper (see promptEntries). */
export function whisperPrompt(entries: DictEntry[], maxChars = PROMPT_MAX_CHARS): string {
  const terms = promptEntries(entries, maxChars).map((e) => e.term);
  return terms.length ? `${terms.join(', ')}.` : '';
}

export class DictionaryStore {
  private entries: DictEntry[] = [];
  /** The file exists but could not be read: work in memory, never write over it. */
  private frozen = false;

  /**
   * @param seed  what a dictionary starts with when there is no file yet (default: the shipped vocabulary).
   * @param log   told once when the file cannot be read or written.
   */
  constructor(private readonly file: string, seed: Array<{ term: string; heard?: string[] }> = DICTIONARY_SEED, private readonly log: (msg: string) => void = () => {}) {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // Only "there is no file yet" may start from the seed. Anything else
      // (permissions, I/O) leaves the user's dictionary on disk alone.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.frozen = true;
        this.log(`[dictionary] ${file} cannot be read (${(err as Error).message}); using the shipped terms, changes are not saved`);
      }
    }
    if (raw !== null) {
      try {
        const data = JSON.parse(raw) as { entries?: unknown };
        if (!Array.isArray(data.entries)) throw new Error('no entries array');
        this.entries = (data.entries as DictEntry[]).filter((e) => e && typeof e.id === 'string' && clean(e.term))
          .map((e) => ({
            id: e.id, term: clean(e.term), heard: Array.isArray(e.heard) ? e.heard.map(clean).filter(audible).slice(0, MAX_HEARD) : [],
            source: e.source === 'manual' || e.source === 'learned' ? e.source : 'seed',
            uses: Number.isFinite(e.uses) ? e.uses : 0, createdAt: Number.isFinite(e.createdAt) ? e.createdAt : 0,
          }));
        return;
      } catch {
        // Unreadable: keep it for inspection, never overwrite it silently.
        try { fs.renameSync(file, file + '.bad'); } catch { /* best effort */ }
      }
    }
    const now = Date.now();
    this.entries = seed.map((s, i) => ({
      id: this.newId(), term: clean(s.term), heard: (s.heard ?? []).map(clean).filter(audible), source: 'seed' as const, uses: 0, createdAt: now - (seed.length - i),
    })).filter((e) => e.term);
  }

  list(): DictEntry[] {
    const told = new Set(promptEntries(this.entries).map((e) => e.id));
    return this.entries.map((e) => ({ ...e, heard: [...e.heard], inPrompt: told.has(e.id) }));
  }

  /** Null if the term is empty or already there (whatever its capitalisation). */
  add(term: string): DictEntry | null {
    const t = clean(term);
    if (!t || this.entries.length >= MAX_ENTRIES || this.entries.some((e) => key(e.term) === key(t))) return null;
    const e: DictEntry = { id: this.newId(), term: t, heard: [], source: 'manual', uses: 0, createdAt: Date.now() };
    this.entries.unshift(e);
    this.save();
    return { ...e, heard: [] };
  }

  update(id: string, patch: { term?: string; heard?: string[] }): DictEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    if (patch.term !== undefined) {
      const t = clean(patch.term);
      if (t && !this.entries.some((x) => x !== e && key(x.term) === key(t))) e.term = t;
    }
    if (Array.isArray(patch.heard)) {
      // A mishearing that is itself a term would replace a correct word.
      const terms = new Set(this.entries.map((x) => key(x.term)));
      const seen = new Set<string>();
      e.heard = patch.heard.map(clean).filter((h) => {
        if (!h || !audible(h) || terms.has(key(h)) || seen.has(key(h))) return false;
        seen.add(key(h));
        return true;
      }).slice(0, MAX_HEARD);
    }
    this.save();
    return { ...e, heard: [...e.heard] };
  }

  remove(id: string): boolean {
    const i = this.entries.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    this.save();
    return true;
  }

  /** Replaces known mishearings and counts the uses. */
  fix(text: string): string {
    const { text: out, hits } = applyDictionary(text, this.entries);
    const ids = Object.keys(hits);
    if (ids.length === 0) return out;
    for (const e of this.entries) if (hits[e.id]) e.uses += hits[e.id];
    this.save();
    return out;
  }

  /** What Whisper is told to listen for. */
  prompt(): string { return whisperPrompt(this.entries); }


  private newId(): string { return randomBytes(6).toString('hex'); }

  private save(): void {
    if (this.frozen) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // A full disk must not break dictation — but it should be visible in the log.
      this.log(`[dictionary] could not save ${this.file}: ${(err as Error).message}`);
    }
  }
}
