import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';
import { buildSkillsSummary } from './skills/skill-registry';
import type { CloudState } from './cloud/cloud.types';
import { createEmptyCloudState } from './cloud/cloud.types';

export const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const MEMORY_FILE = path.join(CONFIG_DIR, 'manager-memory.json');

export const MAX_RECENT_CHAT = 40;
const MAX_INSIGHTS = 200;
const MAX_LEARNED_FACTS = 50;
const MAX_TRAITS = 30;
const MAX_SHARED_HISTORY = 20;
const MAX_PROJECTS = 20;

let _distilling = false;
export function isDistilling(): boolean { return _distilling; }
export function setDistilling(v: boolean): void { _distilling = v; }

export interface MemoryUser {
  name: string;
  role: string;
  techStack: string[];
  preferences: string[];
  learnedFacts: string[];
}

export interface MemoryPersonality {
  agentName: string;
  tone: string;
  detail: string;
  emojis: boolean;
  proactive: boolean;
  traits: string[];
  sharedHistory: string[];
}

export interface MemoryProject {
  name: string;
  path: string;
  type: string;
  notes: string;
}

export interface MemoryInsight {
  date: string;
  text: string;
  source: 'chat' | 'summary' | 'terminal';
}

export interface MemoryChatEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface MemoryStats {
  totalSessions: number;
  firstInteraction: string;
  lastInteraction: string;
  totalMessages: number;
}

export interface MemoryJournalEntry {
  date: string;
  text: string;
}

export interface ManagerMemory {
  user: MemoryUser;
  personality: MemoryPersonality;
  projects: MemoryProject[];
  insights: MemoryInsight[];
  /** Insights older than INSIGHT_ARCHIVE_DAYS — kept for the user's audit trail
   *  but excluded from the AI's system prompt. Bounded by MAX_ARCHIVED_INSIGHTS. */
  archivedInsights: MemoryInsight[];
  journal: MemoryJournalEntry[];
  recentChat: MemoryChatEntry[];
  stats: MemoryStats;
  cloudState: CloudState;  // NEW
}

export function createEmptyMemory(): ManagerMemory {
  return {
    user: {
      name: '',
      role: '',
      techStack: [],
      preferences: [],
      learnedFacts: [],
    },
    personality: {
      agentName: 'Manager',
      tone: 'chill',
      detail: 'balanced',
      emojis: true,
      proactive: true,
      traits: [],
      sharedHistory: [],
    },
    projects: [],
    insights: [],
    archivedInsights: [],
    journal: [],
    recentChat: [],
    stats: {
      totalSessions: 0,
      firstInteraction: '',
      lastInteraction: '',
      totalMessages: 0,
    },
    cloudState: createEmptyCloudState(),  // NEW
  };
}

export function loadMemory(): ManagerMemory {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')) as Partial<ManagerMemory>;
      const empty = createEmptyMemory();
      return {
        user: { ...empty.user, ...parsed.user },
        personality: { ...empty.personality, ...parsed.personality },
        projects: parsed.projects ?? empty.projects,
        insights: parsed.insights ?? empty.insights,
        archivedInsights: parsed.archivedInsights ?? empty.archivedInsights,
        journal: parsed.journal ?? empty.journal,
        recentChat: parsed.recentChat ?? empty.recentChat,
        stats: { ...empty.stats, ...parsed.stats },
        cloudState: parsed.cloudState ?? empty.cloudState,  // NEW
      };
    }
  } catch (err) {
    logger.warn('[memory] Failed to load manager memory, using empty state:', err);
  }
  return createEmptyMemory();
}

export function saveMemory(memory: ManagerMemory): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  enforceLimits(memory);
  const tmpFile = MEMORY_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(memory, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, MEMORY_FILE);
}

// Re-export limit constants for consumers that need to enforce caps
export { MAX_INSIGHTS, MAX_LEARNED_FACTS, MAX_TRAITS, MAX_SHARED_HISTORY, MAX_PROJECTS };

// ---------------------------------------------------------------------------
// Task 2: Size Limits & Memory Update Parser
// ---------------------------------------------------------------------------

export function enforceLimits(memory: ManagerMemory): void {
  if (memory.recentChat.length > MAX_RECENT_CHAT) {
    memory.recentChat = memory.recentChat.slice(-MAX_RECENT_CHAT);
  }
  archiveOldInsights(memory);
  if (memory.insights.length > MAX_INSIGHTS) {
    memory.insights = memory.insights.slice(-MAX_INSIGHTS);
  }
  if (memory.user.learnedFacts.length > MAX_LEARNED_FACTS) {
    memory.user.learnedFacts = memory.user.learnedFacts.slice(-MAX_LEARNED_FACTS);
  }
  if (memory.personality.traits.length > MAX_TRAITS) {
    memory.personality.traits = memory.personality.traits.slice(-MAX_TRAITS);
  }
  if (memory.personality.sharedHistory.length > MAX_SHARED_HISTORY) {
    memory.personality.sharedHistory = memory.personality.sharedHistory.slice(-MAX_SHARED_HISTORY);
  }
  if (memory.projects.length > MAX_PROJECTS) {
    memory.projects = memory.projects.slice(-MAX_PROJECTS);
  }
  // Journal: max 100 entries
  if (memory.journal.length > 100) {
    memory.journal = memory.journal.slice(-100);
  }
}

export interface MemoryUpdate {
  learnedFacts: string[];
  traits: string[];
  projects: MemoryProject[];
  insights: string[];
  journalEntries: string[];
}

// ── Project Validation & Normalization ─────────────────────────────────────
// Background: the AI is instructed to ALWAYS emit a [MEMORY_UPDATE] block,
// which leads it to fabricate "projects" like "Kein Projekt genannt" / "N/A"
// when no real project was discussed. These sentinels filter that garbage out
// and let fuzzy matching merge variants like "TMS Solvado" / "tms Solvado &
// Shoporu" / "Solvado/Shoporu" into one canonical entry.

const JUNK_PROJECT_PATTERNS = [
  /^(keine?\b.*projekte?)/i,
  /^(kein\s+projekt)/i,
  /^(no\s+project)/i,
  /^n\/?a$/i,
  /^unbekannt$/i,
  /^unknown$/i,
  /^-+$/,
  /^—+$/,
  /^\.*$/,
];

function isJunkProjectName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  return JUNK_PROJECT_PATTERNS.some(p => p.test(trimmed));
}

const JUNK_PATH_VALUES = new Set(['', '-', '/', '/-', 'n/a', 'na', '—', '.', './', 'unbekannt', 'unknown']);

function isJunkPath(path: string): boolean {
  return JUNK_PATH_VALUES.has(path.trim().toLowerCase());
}

/** Looks like a real filesystem path (absolute, ~/, or repo-relative with at
 *  least one segment + an extension or recognized parent like Desktop/src). */
function isRealisticPath(path: string): boolean {
  const p = path.trim();
  if (!p || isJunkPath(p)) return false;
  if (p.startsWith('/') && p.length > 4 && !p.startsWith('/-')) return true;
  if (p.startsWith('~/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true; // Windows
  return false;
}

/** Normalize a project name for fuzzy matching. Lowercases, strips separators
 *  ("&", "und", "+", "/", ","), collapses whitespace. "TMS Solvado & Shoporu"
 *  becomes "tms solvado shoporu" — easy to compare via token overlap. */
function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*[&+/,]\s*|\s+und\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns the count of shared significant tokens (length ≥ 4) between a/b.
 *  Ignores generic words like "tms", "und". Two projects match if they share
 *  ≥ 1 distinctive token (e.g. "shoporu", "solvado"). */
function projectNameOverlap(a: string, b: string): number {
  const stop = new Set(['tms', 'und', 'der', 'die', 'das', 'app', 'web', 'ui', 'dev']);
  const tokens = (s: string) =>
    new Set(normalizeProjectName(s).split(' ').filter(t => t.length >= 4 && !stop.has(t)));
  const ta = tokens(a);
  const tb = tokens(b);
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}

// ── Generic Fact / Insight Validation & Deduplication ─────────────────────
// The AI is instructed to ALWAYS emit learned/trait/insight lines, which
// causes the same fact to be rephrased and re-stored dozens of times
// ("Name ist Kadir" → "Der User heißt Kadir" → "User-Name ist Kadir" …).
// Token-Jaccard catches these; junk patterns drop AI placeholders.

const JUNK_FACT_PATTERNS = [
  /^keine?\b.*(fakten|persönlich|daten|info|details|merkmale|extrahier|identifizier)/i,
  /^user\s+hat\s+sich\s+lediglich/i,
  /^kein(e)?\s+(neuen?|weiteren?)/i,
  /^nichts\s+neues/i,
  /^-+$/,
  /^—+$/,
  /^\.+$/,
];

function isJunkFact(text: string): boolean {
  const t = text.trim();
  if (t.length < 5) return true;
  return JUNK_FACT_PATTERNS.some(p => p.test(t));
}

const FACT_STOP_WORDS = new Set([
  'der', 'die', 'das', 'des', 'dem', 'den', 'ein', 'eine', 'einen', 'einer', 'eines',
  'und', 'oder', 'aber', 'als', 'auch', 'nur', 'noch', 'schon', 'sehr', 'bei',
  'ist', 'sind', 'war', 'wird', 'wurde', 'hat', 'hatte', 'haben', 'sein',
  'in', 'im', 'auf', 'mit', 'für', 'von', 'vom', 'zu', 'zur', 'zum', 'aus', 'an', 'am',
  'nach', 'vor', 'über', 'unter', 'durch', 'gegen', 'sich', 'wie', 'so', 'nicht',
  'user', 'agent', 'kadir', 'rem',
]);

/** Token-Jaccard similarity for natural-language facts. Strips punctuation,
 *  drops common stopwords + the user/agent name itself (so "Kadir heißt
 *  Kadir" doesn't trivially match every other fact about Kadir). */
function factSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s.toLowerCase()
        .replace(/[^\w\säöüß]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !FACT_STOP_WORDS.has(t)),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

/** Returns the existing entry that semantically matches `text` (Jaccard ≥ 0.5),
 *  or undefined if none. Used to drop fuzzy duplicates and prefer the longer
 *  / more informative phrasing when a new variant arrives. */
function findFuzzyDuplicate(text: string, existing: string[]): { index: number; existing: string } | undefined {
  for (let i = 0; i < existing.length; i++) {
    if (factSimilarity(text, existing[i]) >= 0.5) {
      return { index: i, existing: existing[i] };
    }
  }
  return undefined;
}

// ── Insight Time-Decay ─────────────────────────────────────────────────────
// Insights age out: only items from the last INSIGHT_ACTIVE_DAYS days are
// shown to the AI. Items older than INSIGHT_ARCHIVE_DAYS are moved out of
// the active list entirely (still kept in archivedInsights for the user's
// audit trail / Memory-Editor view).

const INSIGHT_ACTIVE_DAYS = 14;   // shown in system prompt
const INSIGHT_ARCHIVE_DAYS = 30;  // moved to archivedInsights after this
const MAX_ARCHIVED_INSIGHTS = 500;

function daysAgo(dateStr: string): number {
  if (!dateStr) return Infinity;
  const then = new Date(`${dateStr}T00:00:00`).getTime();
  if (isNaN(then)) return Infinity;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function archiveOldInsights(memory: ManagerMemory): void {
  if (!memory.archivedInsights) memory.archivedInsights = [];
  const stillActive: MemoryInsight[] = [];
  for (const insight of memory.insights) {
    if (daysAgo(insight.date) > INSIGHT_ARCHIVE_DAYS) {
      memory.archivedInsights.push(insight);
    } else {
      stillActive.push(insight);
    }
  }
  memory.insights = stillActive;
  if (memory.archivedInsights.length > MAX_ARCHIVED_INSIGHTS) {
    memory.archivedInsights = memory.archivedInsights.slice(-MAX_ARCHIVED_INSIGHTS);
  }
}

// ── Topic-Slot Conflict Detection ─────────────────────────────────────────
// Some facts are inherently single-valued — the user has exactly ONE name,
// ONE primary device, ONE current job. When a new fact lands in such a slot,
// the previous occupant should be REPLACED, not appended (otherwise we end up
// with "Name ist Kadir" 12 times in different phrasings).
//
// If the user genuinely changes ("ich heiße jetzt Karl"), this also does the
// right thing — the latest fact wins.

const SINGLE_FACT_TOPICS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'user_name', pattern: /\b(heißt|heisst|name\s+ist|nennt\s+sich|benutzername|user-name|name\s+des\s+users)\b/i },
  { name: 'user_device', pattern: /\b(fold\s*\d?|iphone|galaxy|samsung|android|ios)\b/i },
  { name: 'user_location', pattern: /\b(wohnt|lebt|adresse|wohnort)\s+(in|im|bei)\b/i },
  { name: 'user_job', pattern: /\b(arbeitet\s+als|beruf\s+ist|tätig\s+als)\b/i },
];

function detectFactTopic(text: string): string | null {
  for (const { name, pattern } of SINGLE_FACT_TOPICS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/** Insert `fact` into `bucket`, with single-slot semantics for known topics
 *  and fuzzy-dedup as the fallback. Mutates `bucket` in place. */
function upsertFact(bucket: string[], fact: string): void {
  const topic = detectFactTopic(fact);
  if (topic) {
    const slotIdx = bucket.findIndex(f => detectFactTopic(f) === topic);
    if (slotIdx !== -1) {
      bucket[slotIdx] = fact;
      return;
    }
  }
  const dup = findFuzzyDuplicate(fact, bucket);
  if (!dup) {
    bucket.push(fact);
  } else if (fact.length > dup.existing.length * 1.3) {
    bucket[dup.index] = fact;
  }
}

export function parseMemoryUpdate(text: string): MemoryUpdate | null {
  const match = text.match(/\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/);
  if (!match) return null;

  const block = match[1];
  const update: MemoryUpdate = { learnedFacts: [], traits: [], projects: [], insights: [], journalEntries: [] };

  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('learned:')) {
      const fact = line.slice('learned:'.length).trim();
      if (fact && !isJunkFact(fact)) update.learnedFacts.push(fact);
    } else if (line.startsWith('trait:')) {
      const trait = line.slice('trait:'.length).trim();
      if (trait && !isJunkFact(trait)) update.traits.push(trait);
    } else if (line.startsWith('project:')) {
      const raw2 = line.slice('project:'.length).trim();
      const parts = raw2.split('|').map((p) => p.trim());
      const name = parts[0] ?? '';
      const path = parts[1] ?? '';
      // Drop AI-fabricated placeholders like "Kein Projekt genannt | | |".
      // Require either a non-junk name OR a realistic path — preferably both.
      if (name && !isJunkProjectName(name)) {
        update.projects.push({
          name,
          path: isJunkPath(path) ? '' : path,
          type: parts[2] ?? '',
          notes: parts[3] ?? '',
        });
      }
    } else if (line.startsWith('insight:')) {
      const insight = line.slice('insight:'.length).trim();
      if (insight && !isJunkFact(insight)) update.insights.push(insight);
    } else if (line.startsWith('journal:')) {
      const entry = line.slice('journal:'.length).trim();
      if (entry) update.journalEntries.push(entry);
    }
  }

  const hasEntries =
    update.learnedFacts.length > 0 ||
    update.traits.length > 0 ||
    update.projects.length > 0 ||
    update.insights.length > 0 ||
    update.journalEntries.length > 0;

  return hasEntries ? update : null;
}

export function applyMemoryUpdate(memory: ManagerMemory, update: MemoryUpdate): void {
  for (const fact of update.learnedFacts) upsertFact(memory.user.learnedFacts, fact);
  for (const trait of update.traits) upsertFact(memory.personality.traits, trait);

  for (const proj of update.projects) {
    // Match priority: exact path > exact name > fuzzy name overlap (≥ 1 distinctive token).
    // This fuses "TMS Solvado", "tms Solvado & Shoporu", "Solvado/Shoporu" into one entry.
    const existing =
      memory.projects.find(p => proj.path && isRealisticPath(proj.path) && p.path === proj.path)
      ?? memory.projects.find(p => p.name.toLowerCase() === proj.name.toLowerCase())
      ?? memory.projects.find(p => projectNameOverlap(p.name, proj.name) >= 1);

    if (existing) {
      // Prefer the cleaner / more specific name (longer + contains real letters wins).
      if (proj.name.length > existing.name.length && /[a-zA-Z]{3,}/.test(proj.name)) {
        existing.name = proj.name;
      }
      // Path: only overwrite with a realistic path. Never replace a real path with junk.
      if (isRealisticPath(proj.path) && !isRealisticPath(existing.path)) {
        existing.path = proj.path;
      } else if (proj.path && !existing.path) {
        existing.path = proj.path;
      }
      if (proj.type && proj.type !== '/') existing.type = proj.type;
      if (proj.notes) existing.notes = proj.notes;
    } else {
      memory.projects.push(proj);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  // Only de-dup against the most-recent window the AI actually sees in its
  // context (last 30 — matches buildMemoryContext slicing). Older near-duplicates
  // stay as historical record; they fall out of context anyway.
  const recentInsightTexts = memory.insights.slice(-30).map(i => i.text);
  for (const text of update.insights) {
    if (!findFuzzyDuplicate(text, recentInsightTexts)) {
      memory.insights.push({ date: today, text, source: 'chat' });
      recentInsightTexts.push(text);
    }
  }

  for (const text of update.journalEntries) {
    memory.journal.push({ date: today, text });
  }

  enforceLimits(memory);
}

export function stripMemoryTags(text: string): string {
  return text.replace(/\[MEMORY_UPDATE\][\s\S]*?\[\/MEMORY_UPDATE\]/g, '').trim();
}

export function updateMemorySection(section: string, data: unknown): void {
  const memory = loadMemory();
  if (section === 'user' && typeof data === 'object' && data) {
    memory.user = { ...memory.user, ...(data as Partial<MemoryUser>) };
  } else if (section === 'personality' && typeof data === 'object' && data) {
    memory.personality = { ...memory.personality, ...(data as Partial<MemoryPersonality>) };
  } else if (section === 'projects' && Array.isArray(data)) {
    memory.projects = data as MemoryProject[];
  } else if (section === 'insights' && Array.isArray(data)) {
    memory.insights = data as MemoryInsight[];
  } else if (section === 'journal' && Array.isArray(data)) {
    memory.journal = data as MemoryJournalEntry[];
  }
  enforceLimits(memory);
  saveMemory(memory);
}

// ---------------------------------------------------------------------------
// Task 3: Memory Context Block Builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(memory: ManagerMemory): string {
  const sections: string[] = ['## Dein Gedächtnis'];

  // --- Über den User ---
  const userLines: string[] = [];
  if (memory.user.name) userLines.push(`Name: ${memory.user.name}`);
  if (memory.user.role) userLines.push(`Rolle: ${memory.user.role}`);
  if (memory.user.techStack.length > 0) userLines.push(`Tech-Stack: ${memory.user.techStack.join(', ')}`);
  if (memory.user.preferences.length > 0) userLines.push(`Präferenzen: ${memory.user.preferences.join(', ')}`);
  if (memory.user.learnedFacts.length > 0) {
    userLines.push('Gelernte Fakten:');
    for (const f of memory.user.learnedFacts) userLines.push(`- ${f}`);
  }
  if (userLines.length > 0) {
    sections.push('### Über den User');
    sections.push(userLines.join('\n'));
  }

  // --- Deine Persönlichkeit ---
  const personalityLines: string[] = [];
  if (memory.personality.traits.length > 0) {
    personalityLines.push('Traits:');
    for (const t of memory.personality.traits) personalityLines.push(`- ${t}`);
  }
  if (memory.personality.sharedHistory.length > 0) {
    personalityLines.push('Gemeinsame Geschichte:');
    for (const h of memory.personality.sharedHistory) personalityLines.push(`- ${h}`);
  }
  if (personalityLines.length > 0) {
    sections.push('### Deine Persönlichkeit');
    sections.push(personalityLines.join('\n'));
  }

  // --- Aktive Projekte ---
  if (memory.projects.length > 0) {
    sections.push('### Aktive Projekte');
    const projectLines = memory.projects.map((p) => {
      let line = `- **${p.name}** (${p.type || 'unbekannt'}) — ${p.path || '—'}`;
      if (p.notes) line += ` — ${p.notes}`;
      return line;
    });
    sections.push(projectLines.join('\n'));
  }

  // --- Skills ---
  const skillsSummary = buildSkillsSummary();
  if (skillsSummary) {
    sections.push(skillsSummary);
  }

  // --- Journal (letzte 20) ---
  if (memory.journal.length > 0) {
    sections.push('### Tagebuch (letzte Einträge)');
    const lastJournal = memory.journal.slice(-20);
    sections.push(lastJournal.map((j) => `- [${j.date}] ${j.text}`).join('\n'));
  }

  // --- Erkenntnisse ---
  // Time-decayed: only insights from the last INSIGHT_ACTIVE_DAYS make it
  // into the prompt. Older ones are still in memory.insights / archivedInsights
  // for the Memory-Editor, just not shown to the AI on every request.
  if (memory.insights.length > 0) {
    const active = memory.insights.filter(i => daysAgo(i.date) <= INSIGHT_ACTIVE_DAYS);
    if (active.length > 0) {
      sections.push(`### Aktuelle Erkenntnisse (letzte ${INSIGHT_ACTIVE_DAYS} Tage)`);
      sections.push(active.slice(-30).map((i) => `- [${i.date}] ${i.text}`).join('\n'));
    }
  }

  // --- Statistik ---
  const { totalSessions, firstInteraction, lastInteraction, totalMessages } = memory.stats;
  const statsLines: string[] = [];
  if (totalSessions) statsLines.push(`Sessions: ${totalSessions}`);
  if (firstInteraction) statsLines.push(`Erste Interaktion: ${firstInteraction}`);
  if (lastInteraction) statsLines.push(`Letzte Interaktion: ${lastInteraction}`);
  if (totalMessages) statsLines.push(`Nachrichten gesamt: ${totalMessages}`);
  if (statsLines.length > 0) {
    sections.push('### Statistik');
    sections.push(statsLines.join('\n'));
  }

  return sections.join('\n\n');
}

export const MEMORY_UPDATE_INSTRUCTION = `
## Gedächtnis aktualisieren (optional)

Wenn du im aktuellen Turn etwas Neues über den User, ein Projekt oder die Arbeitsweise gelernt hast, hänge am Ende deiner Antwort einen [MEMORY_UPDATE]-Block an. Der User sieht diesen Block NICHT.

**Wenn nichts Neues passiert ist: lass den Block KOMPLETT WEG.** Lieber kein Eintrag als ein erfundener.

### Format (jede Zeile ist optional)

[MEMORY_UPDATE]
learned: <Fakt über den User — z.B. "Nutzt primär TypeScript">
trait: <Persönlichkeit/Beziehung — z.B. "Mag direkte Antworten">
project: Projektname | /echter/filesystem/pfad | Typ | Notizen zum Stand
insight: <Erkenntnis für die Zukunft — z.B. "User testet sofort auf echtem Gerät">
journal: <Was Wichtiges besprochen wurde — Meilenstein, Entscheidung, Konflikt>
[/MEMORY_UPDATE]

### Regeln pro Zeilentyp

- **learned:** NUR bei wirklich neuer Info (Name, Vorliebe, Tool, Arbeitsstil). Wenn schon bekannt: weglassen.
- **trait:** NUR bei neuer Erkenntnis über Kommunikationsstil/Beziehung. Routine-Interaktion = kein Eintrag.
- **project:** NUR wenn ein konkretes Projekt mit echtem Namen UND echtem Pfad (\`/\`, \`~/\`, Laufwerksbuchstabe) genannt wurde. NIEMALS Platzhalter wie "Kein Projekt", "N/A", "—", "/admin".
- **insight:** NUR bei genuin neuer Erkenntnis, die in zukünftigen Sessions relevant ist.
- **journal:** NUR bei erwähnenswerten Ereignissen (Feature fertig, Bug gefixt, neue Richtung). Smalltalk, "Hi", Routine-Frage = KEIN Journal-Eintrag.

### Beim Onboarding (erstes Gespräch)

Halte ALLES fest, was der User über sich preisgibt:
- Wie angesprochen werden, welchen Namen du bekommst, Tonpräferenzen, Hauptprojekte, Arbeitsweise.

### Hard-Regeln

- Einträge kurz (max. 1 Satz pro Zeile).
- Mehrere Zeilen desselben Typs erlaubt.
- KEIN Pflicht-Block. Wenn nichts Neues: kein Block.
- KEINE Platzhalter-Einträge ("Nichts neues", "Keine Info", "Heute war ein Tag", "—") — die werden eh rausgefiltert und verschmutzen Logs.
`.trim();

// ---------------------------------------------------------------------------
// Task 4: Distillation Logic
// ---------------------------------------------------------------------------

export function buildDistillationPrompt(recentChat: MemoryChatEntry[]): string {
  const lines: string[] = [];
  for (const entry of recentChat) {
    const prefix = entry.role === 'user' ? 'User' : 'Agent';
    lines.push(`${prefix}: ${entry.text}`);
  }
  const conversation = lines.join('\n');

  return `Du bist ein Gedächtnis-Extraktionssystem. Analysiere das folgende Gespräch und extrahiere wichtige Informationen über den User, die Persönlichkeit des Agenten, Projekte und Erkenntnisse.

Gib deine Extraktion ausschließlich als [MEMORY_UPDATE]-Block zurück:

[MEMORY_UPDATE]
learned: <Fakt über den User>
trait: <Eigenschaft oder Beziehungsaspekt>
project: Projektname | /echter/filesystem/pfad | Typ | Notiz
insight: <Wichtige Erkenntnis aus dem Gespräch>
[/MEMORY_UPDATE]

KRITISCH:
- Nur echte neue Informationen. Keine Erfindungen.
- Einzelne Felder weglassen, wenn nichts Konkretes da ist (eine leere project-Zeile ist BESSER als "project: Kein Projekt | | |").
- project: NUR wenn ein konkretes Projekt mit echtem Namen UND möglichst echtem Pfad (\`~/...\` oder \`/...\`) genannt wurde. Sonst die project-Zeile KOMPLETT weglassen.
- Wenn das Gespräch keine Projekt-Info enthält → keine project-Zeile, auch nicht als Platzhalter.

--- Gespräch ---
${conversation}`;
}

export function finalizeDistillation(memory: ManagerMemory): void {
  const today = new Date().toISOString().slice(0, 10);

  memory.recentChat = [];
  memory.stats.totalSessions++;
  memory.stats.lastInteraction = today;
  if (!memory.stats.firstInteraction) {
    memory.stats.firstInteraction = today;
  }

  enforceLimits(memory);
}
