import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

export const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const MEMORY_FILE = path.join(CONFIG_DIR, 'manager-memory.json');

export const MAX_RECENT_CHAT = 40;
const MAX_INSIGHTS = 200;
const MAX_LEARNED_FACTS = 50;
const MAX_TRAITS = 30;
const MAX_SHARED_HISTORY = 20;
const MAX_PROJECTS = 20;

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

export interface ManagerMemory {
  user: MemoryUser;
  personality: MemoryPersonality;
  projects: MemoryProject[];
  insights: MemoryInsight[];
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
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), { mode: 0o600 });
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
}

export interface MemoryUpdate {
  learnedFacts: string[];
  traits: string[];
  projects: MemoryProject[];
  insights: string[];
}

export function parseMemoryUpdate(text: string): MemoryUpdate | null {
  const match = text.match(/\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/);
  if (!match) return null;

  const block = match[1];
  const update: MemoryUpdate = { learnedFacts: [], traits: [], projects: [], insights: [] };

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
    }
  }

  const hasEntries =
    update.learnedFacts.length > 0 ||
    update.traits.length > 0 ||
    update.projects.length > 0 ||
    update.insights.length > 0;

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

  enforceLimits(memory);
}

export function stripMemoryTags(text: string): string {
  return text.replace(/\[MEMORY_UPDATE\][\s\S]*?\[\/MEMORY_UPDATE\]/g, '').trim();
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
Du kannst dein Langzeitgedächtnis aktualisieren, indem du am Ende deiner Antwort einen [MEMORY_UPDATE]-Block einfügst. Der User sieht diesen Block nicht – er wird automatisch herausgefiltert.

Format:
[MEMORY_UPDATE]
learned: <kurze Aussage über den User, z.B. "Nutzt primär TypeScript">
trait: <etwas über unsere Beziehung oder deinen Stil, z.B. "Mag direkte Antworten ohne Blabla">
project: Projektname | /pfad/zum/projekt | Typ | optionale Notiz
insight: <Erkenntnis aus diesem Gespräch, z.B. "Nutzer bevorzugt kurze Commits">
[/MEMORY_UPDATE]

Regeln:
- Nur verwenden, wenn du wirklich etwas Neues gelernt hast – nicht jede Antwort braucht einen Block.
- Einträge kurz halten (max. 1 Satz).
- Keine Duplikate – prüfe ob die Info schon bekannt ist.
- Mehrere Zeilen desselben Typs sind erlaubt (z.B. mehrere learned:-Zeilen).
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
