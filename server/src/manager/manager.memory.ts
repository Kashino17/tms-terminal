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
      tone: 'professional',
      detail: 'balanced',
      emojis: false,
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
