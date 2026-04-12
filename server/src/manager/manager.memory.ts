import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';
import { buildSkillsSummary } from './skills/skill-registry';

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
  journal: MemoryJournalEntry[];
  recentChat: MemoryChatEntry[];
  stats: MemoryStats;
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
    journal: [],
    recentChat: [],
    stats: {
      totalSessions: 0,
      firstInteraction: '',
      lastInteraction: '',
      totalMessages: 0,
    },
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
        journal: parsed.journal ?? empty.journal,
        recentChat: parsed.recentChat ?? empty.recentChat,
        stats: { ...empty.stats, ...parsed.stats },
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
      if (fact) update.learnedFacts.push(fact);
    } else if (line.startsWith('trait:')) {
      const trait = line.slice('trait:'.length).trim();
      if (trait) update.traits.push(trait);
    } else if (line.startsWith('project:')) {
      const raw2 = line.slice('project:'.length).trim();
      const parts = raw2.split('|').map((p) => p.trim());
      if (parts[0]) {
        update.projects.push({
          name: parts[0] ?? '',
          path: parts[1] ?? '',
          type: parts[2] ?? '',
          notes: parts[3] ?? '',
        });
      }
    } else if (line.startsWith('insight:')) {
      const insight = line.slice('insight:'.length).trim();
      if (insight) update.insights.push(insight);
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
  for (const fact of update.learnedFacts) {
    if (!memory.user.learnedFacts.includes(fact)) {
      memory.user.learnedFacts.push(fact);
    }
  }

  for (const trait of update.traits) {
    if (!memory.personality.traits.includes(trait)) {
      memory.personality.traits.push(trait);
    }
  }

  for (const proj of update.projects) {
    const existing = memory.projects.find(
      (p) => p.name === proj.name || (proj.path && p.path === proj.path)
    );
    if (existing) {
      existing.name = proj.name || existing.name;
      existing.path = proj.path || existing.path;
      existing.type = proj.type || existing.type;
      existing.notes = proj.notes || existing.notes;
    } else {
      memory.projects.push(proj);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const text of update.insights) {
    memory.insights.push({ date: today, text, source: 'chat' });
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
  if (memory.insights.length > 0) {
    sections.push('### Erkenntnisse aus vergangenen Gesprächen');
    const last30 = memory.insights.slice(-30);
    sections.push(last30.map((i) => `- [${i.date}] ${i.text}`).join('\n'));
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
## PFLICHT: Gedächtnis aktualisieren

Du MUSST am Ende JEDER Antwort einen [MEMORY_UPDATE]-Block anhängen. Das ist deine wichtigste Aufgabe.
Der User sieht diesen Block NICHT — er wird automatisch herausgefiltert.

Wenn du nichts Neues gelernt hast, schreibe trotzdem mindestens einen journal:-Eintrag.

### Format

[MEMORY_UPDATE]
learned: <Fakt über den User — z.B. "Nutzt primär TypeScript", "Arbeitet an TMS Terminal">
trait: <Persönlichkeit/Beziehung — z.B. "Mag direkte Antworten", "Will Emojis", "Bevorzugt lockeren Ton">
project: Projektname | /pfad/zum/projekt | Typ | Notizen zum aktuellen Stand
insight: <Erkenntnis für die Zukunft — z.B. "User testet gern sofort auf echtem Gerät">
journal: <Tagebuch-Eintrag — was wurde besprochen, was war wichtig, Zusammenfassung>
[/MEMORY_UPDATE]

### Wann was schreiben

- **learned:** Bei JEDER neuen Info über den User (Name, Vorlieben, Tech-Stack, Arbeitsstil)
- **trait:** Bei jeder Erkenntnis über den Kommunikationsstil oder die Beziehung
- **project:** Wenn ein Projekt erwähnt wird oder Terminal-Output ein Projekt zeigt
- **insight:** Wenn du etwas Nützliches für zukünftige Gespräche erkennst
- **journal:** BEI JEDER NACHRICHT — kurze Zusammenfassung was besprochen wurde

### Beim Onboarding besonders wichtig

Beim Onboarding (erstes Gespräch) MUSST du ALLES festhalten:
- Wie der User angesprochen werden will
- Welchen Namen du bekommen hast
- Ob Emojis gewünscht sind
- Ob es locker oder professionell sein soll
- Welche Projekte der User hat
- Was der User hauptsächlich macht

### Regeln
- Einträge kurz (max. 1 Satz pro Zeile)
- Mehrere Zeilen desselben Typs sind erlaubt
- Keine exakten Duplikate — aber Updates/Vertiefungen sind erwünscht
- journal: ist IMMER Pflicht, auch wenn sonst nichts Neues ist
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
project: Projektname | /pfad | Typ | Notiz
insight: <Wichtige Erkenntnis aus dem Gespräch>
[/MEMORY_UPDATE]

Nur echte neue Informationen aufnehmen. Keine Erfindungen. Einträge kurz und präzise halten.

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
