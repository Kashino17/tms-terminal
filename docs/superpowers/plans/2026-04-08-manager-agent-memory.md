# Manager Agent Memory System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Manager Agent (Kimi K2.5 / GLM 5.0 / Claude) a persistent memory that grows with every conversation — remembering the user, learning preferences, tracking projects, and deepening its personality over time.

**Architecture:** A JSON file at `~/.tms-terminal/manager-memory.json` stores user profile, personality, projects, insights, and recent chat. The server loads this file before every AI call, injects it as context into the system prompt, parses `[MEMORY_UPDATE]` blocks from AI responses to learn new facts, and runs periodic "distillation" to compress old chat into insights.

**Tech Stack:** Node.js, TypeScript, fs (JSON file I/O), existing ManagerService + ws.handler

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/src/manager/manager.memory.ts` | Create | Memory types, load/save, context block builder, distillation logic, size limits |
| `server/src/manager/manager.service.ts` | Modify | Integrate memory into handleChat/poll, parse MEMORY_UPDATE, trigger distillation |
| `server/src/websocket/ws.handler.ts` | Modify | Trigger distillation on ws close |

---

### Task 1: Memory Types & File I/O

**Files:**
- Create: `server/src/manager/manager.memory.ts`

- [ ] **Step 1: Create the memory types and empty-state factory**

```typescript
// server/src/manager/manager.memory.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Constants ───────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const MEMORY_FILE = path.join(CONFIG_DIR, 'manager-memory.json');

const MAX_RECENT_CHAT = 40;
const MAX_INSIGHTS = 200;
const MAX_LEARNED_FACTS = 50;
const MAX_TRAITS = 30;
const MAX_SHARED_HISTORY = 20;
const MAX_PROJECTS = 20;

// ── Empty State ─────────────────────────────────────────────────────────────

export function createEmptyMemory(): ManagerMemory {
  return {
    user: { name: '', role: '', techStack: [], preferences: [], learnedFacts: [] },
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
    stats: { totalSessions: 0, firstInteraction: '', lastInteraction: '', totalMessages: 0 },
  };
}
```

- [ ] **Step 2: Add load and save functions**

Append to `manager.memory.ts`:

```typescript
// ── File I/O ────────────────────────────────────────────────────────────────

export function loadMemory(): ManagerMemory {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ManagerMemory>;
      // Merge with empty to ensure all fields exist (handles schema evolution)
      const empty = createEmptyMemory();
      return {
        user: { ...empty.user, ...parsed.user },
        personality: { ...empty.personality, ...parsed.personality },
        projects: parsed.projects ?? [],
        insights: parsed.insights ?? [],
        recentChat: parsed.recentChat ?? [],
        stats: { ...empty.stats, ...parsed.stats },
      };
    }
  } catch (err) {
    logger.warn(`Manager memory: failed to load — ${err instanceof Error ? err.message : err}`);
  }
  return createEmptyMemory();
}

export function saveMemory(memory: ManagerMemory): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add server/src/manager/manager.memory.ts
git commit -m "feat(memory): add types, empty state factory, load/save"
```

---

### Task 2: Size Limits & Memory Update Parser

**Files:**
- Modify: `server/src/manager/manager.memory.ts`

- [ ] **Step 1: Add enforceLimits function**

Append to `manager.memory.ts`:

```typescript
// ── Size Limits ─────────────────────────────────────────────────────────────

export function enforceLimits(memory: ManagerMemory): void {
  // recentChat: max 40
  if (memory.recentChat.length > MAX_RECENT_CHAT) {
    memory.recentChat = memory.recentChat.slice(-MAX_RECENT_CHAT);
  }

  // insights: max 200 — trim oldest
  if (memory.insights.length > MAX_INSIGHTS) {
    memory.insights = memory.insights.slice(-MAX_INSIGHTS);
  }

  // learnedFacts: max 50 — trim oldest
  if (memory.user.learnedFacts.length > MAX_LEARNED_FACTS) {
    memory.user.learnedFacts = memory.user.learnedFacts.slice(-MAX_LEARNED_FACTS);
  }

  // traits: max 30
  if (memory.personality.traits.length > MAX_TRAITS) {
    memory.personality.traits = memory.personality.traits.slice(-MAX_TRAITS);
  }

  // sharedHistory: max 20
  if (memory.personality.sharedHistory.length > MAX_SHARED_HISTORY) {
    memory.personality.sharedHistory = memory.personality.sharedHistory.slice(-MAX_SHARED_HISTORY);
  }

  // projects: max 20
  if (memory.projects.length > MAX_PROJECTS) {
    memory.projects = memory.projects.slice(-MAX_PROJECTS);
  }
}
```

- [ ] **Step 2: Add parseMemoryUpdate function**

Append to `manager.memory.ts`:

```typescript
// ── Memory Update Parser ────────────────────────────────────────────────────

export function parseMemoryUpdate(text: string): {
  learnedFacts: string[];
  traits: string[];
  projects: MemoryProject[];
  insights: string[];
} | null {
  const match = text.match(/\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/);
  if (!match) return null;

  const block = match[1];
  const learnedFacts: string[] = [];
  const traits: string[] = [];
  const projects: MemoryProject[] = [];
  const insights: string[] = [];

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('learned:')) {
      learnedFacts.push(trimmed.slice(8).trim());
    } else if (trimmed.startsWith('trait:')) {
      traits.push(trimmed.slice(6).trim());
    } else if (trimmed.startsWith('project:')) {
      const parts = trimmed.slice(8).trim().split('|').map(s => s.trim());
      if (parts.length >= 3) {
        projects.push({ name: parts[0], path: parts[1], type: parts[2], notes: parts[3] ?? '' });
      }
    } else if (trimmed.startsWith('insight:')) {
      insights.push(trimmed.slice(8).trim());
    }
  }

  if (learnedFacts.length === 0 && traits.length === 0 && projects.length === 0 && insights.length === 0) {
    return null;
  }
  return { learnedFacts, traits, projects, insights };
}

/** Apply parsed memory updates to the memory object. */
export function applyMemoryUpdate(
  memory: ManagerMemory,
  update: NonNullable<ReturnType<typeof parseMemoryUpdate>>,
): void {
  const today = new Date().toISOString().slice(0, 10);

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
    const existing = memory.projects.find(p => p.name === proj.name || p.path === proj.path);
    if (existing) {
      Object.assign(existing, proj);
    } else {
      memory.projects.push(proj);
    }
  }

  for (const insight of update.insights) {
    memory.insights.push({ date: today, text: insight, source: 'chat' });
  }

  enforceLimits(memory);
}
```

- [ ] **Step 3: Add stripMemoryTags helper**

Append to `manager.memory.ts`:

```typescript
/** Remove [MEMORY_UPDATE] blocks from text before showing to user. */
export function stripMemoryTags(text: string): string {
  return text.replace(/\[MEMORY_UPDATE\][\s\S]*?\[\/MEMORY_UPDATE\]/g, '').trim();
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add server/src/manager/manager.memory.ts
git commit -m "feat(memory): size limits, update parser, apply logic"
```

---

### Task 3: Memory Context Block Builder

**Files:**
- Modify: `server/src/manager/manager.memory.ts`

- [ ] **Step 1: Add buildMemoryContext function**

Append to `manager.memory.ts`:

```typescript
// ── Context Block Builder ───────────────────────────────────────────────────

/** Build a text block that gets injected into the system prompt. */
export function buildMemoryContext(memory: ManagerMemory): string {
  const parts: string[] = ['## Dein Gedächtnis\n'];

  // User profile
  if (memory.user.name || memory.user.learnedFacts.length > 0) {
    parts.push('### Über den User');
    if (memory.user.name) parts.push(`Name: ${memory.user.name}`);
    if (memory.user.role) parts.push(`Rolle: ${memory.user.role}`);
    if (memory.user.techStack.length > 0) parts.push(`Tech-Stack: ${memory.user.techStack.join(', ')}`);
    if (memory.user.preferences.length > 0) {
      parts.push('Präferenzen:');
      for (const p of memory.user.preferences) parts.push(`- ${p}`);
    }
    if (memory.user.learnedFacts.length > 0) {
      parts.push('Gelernte Fakten:');
      for (const f of memory.user.learnedFacts) parts.push(`- ${f}`);
    }
    parts.push('');
  }

  // Personality additions
  if (memory.personality.traits.length > 0 || memory.personality.sharedHistory.length > 0) {
    parts.push('### Deine Persönlichkeit');
    if (memory.personality.traits.length > 0) {
      for (const t of memory.personality.traits) parts.push(`- ${t}`);
    }
    if (memory.personality.sharedHistory.length > 0) {
      parts.push('Gemeinsame Geschichte:');
      for (const h of memory.personality.sharedHistory) parts.push(`- ${h}`);
    }
    parts.push('');
  }

  // Projects
  if (memory.projects.length > 0) {
    parts.push('### Aktive Projekte');
    for (const p of memory.projects) {
      parts.push(`- **${p.name}** (${p.type}) — ${p.path}${p.notes ? ` — ${p.notes}` : ''}`);
    }
    parts.push('');
  }

  // Recent insights (last 30)
  if (memory.insights.length > 0) {
    const recent = memory.insights.slice(-30);
    parts.push('### Erkenntnisse aus vergangenen Gesprächen');
    for (const i of recent) {
      parts.push(`- [${i.date}] ${i.text}`);
    }
    parts.push('');
  }

  // Stats
  parts.push('### Statistik');
  parts.push(`${memory.stats.totalSessions} Sessions seit ${memory.stats.firstInteraction || 'jetzt'}`);
  parts.push(`Letzte Interaktion: ${memory.stats.lastInteraction || 'jetzt'}`);
  parts.push(`${memory.stats.totalMessages} Nachrichten insgesamt`);

  return parts.join('\n');
}
```

- [ ] **Step 2: Add the MEMORY_UPDATE instruction constant**

Append to `manager.memory.ts`:

```typescript
// ── Memory Update Instruction ───────────────────────────────────────────────

/** Appended to system prompt so the AI knows how to update memory. */
export const MEMORY_UPDATE_INSTRUCTION = `
## Dein Gedächtnis aktualisieren

Du hast ein persistentes Gedächtnis. Wenn du etwas Neues lernst, hänge einen [MEMORY_UPDATE] Block an deine Antwort an.
Der User sieht diesen Block NICHT — er wird vom System geparst und gespeichert.

Format:
[MEMORY_UPDATE]
learned: <neuer Fakt über den User>
trait: <neue Persönlichkeits-Eigenschaft oder Beziehungs-Erkenntnis>
project: <Projektname> | <Pfad> | <Typ>
insight: <Erkenntnis für zukünftige Gespräche>
[/MEMORY_UPDATE]

Regeln:
- Nur anhängen wenn du tatsächlich etwas NEUES gelernt hast
- Nicht bei jeder Nachricht — nur wenn es relevant ist
- Kurz und prägnant, ein Satz pro Eintrag
- Keine Duplikate zu Dingen die du schon weißt (siehe "Dein Gedächtnis" oben)`;
```

- [ ] **Step 3: Export the MAX_RECENT_CHAT constant**

Add `export` to the constant declaration (needed by manager.service.ts for distillation trigger):

Change `const MAX_RECENT_CHAT = 40;` to `export const MAX_RECENT_CHAT = 40;`

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add server/src/manager/manager.memory.ts
git commit -m "feat(memory): context block builder + AI update instruction"
```

---

### Task 4: Distillation Logic

**Files:**
- Modify: `server/src/manager/manager.memory.ts`

- [ ] **Step 1: Add the distillation prompt builder**

Append to `manager.memory.ts`:

```typescript
// ── Distillation ────────────────────────────────────────────────────────────

/** Build a prompt that asks the AI to distill recent chat into insights. */
export function buildDistillationPrompt(recentChat: MemoryChatEntry[]): string {
  let chatLog = '';
  for (const entry of recentChat) {
    const label = entry.role === 'user' ? 'User' : 'Agent';
    chatLog += `${label}: ${entry.text}\n\n`;
  }

  return `Analysiere diesen Chat-Verlauf und extrahiere das Wichtigste:

${chatLog}

Extrahiere:
1. Was hast du Neues über den User gelernt? (learned: ...)
2. Welche Projekte wurden erwähnt? (project: Name | Pfad | Typ)
3. Welche Erkenntnisse sind für zukünftige Gespräche relevant? (insight: ...)
4. Hat sich an deiner Persönlichkeit/Beziehung etwas verändert? (trait: ...)

Antworte NUR mit einem [MEMORY_UPDATE] Block, nichts anderes.`;
}

/** After distillation: clear recentChat, bump session stats. */
export function finalizeDistillation(memory: ManagerMemory): void {
  memory.recentChat = [];
  memory.stats.totalSessions++;
  memory.stats.lastInteraction = new Date().toISOString().slice(0, 10);
  if (!memory.stats.firstInteraction) {
    memory.stats.firstInteraction = memory.stats.lastInteraction;
  }
  enforceLimits(memory);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/manager/manager.memory.ts
git commit -m "feat(memory): distillation prompt + finalization"
```

---

### Task 5: Integrate Memory into ManagerService

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Add memory imports**

At the top of `manager.service.ts`, add:

```typescript
import {
  loadMemory, saveMemory, ManagerMemory,
  parseMemoryUpdate, applyMemoryUpdate, stripMemoryTags,
  buildMemoryContext, MEMORY_UPDATE_INSTRUCTION, MAX_RECENT_CHAT,
  buildDistillationPrompt, finalizeDistillation,
} from './manager.memory';
```

- [ ] **Step 2: Add memory field and load in constructor**

In the `ManagerService` class, add a `memory` field and load it:

```typescript
// Add field next to existing fields:
private memory: ManagerMemory;

// In constructor, after registry init:
this.memory = loadMemory();
logger.info(`Manager: memory loaded (${this.memory.stats.totalSessions} sessions, ${this.memory.insights.length} insights)`);
```

- [ ] **Step 3: Update handleChat to use memory**

In `handleChat()`, replace the system prompt building and response handling:

**Before the `try` block**, load fresh memory and build the prompt:

```typescript
// Replace:
//   const systemPrompt = onboarding ? ONBOARDING_PROMPT : buildSystemPrompt(this.personality);

// With:
this.memory = loadMemory(); // reload in case another process changed it
const isOnboarding = onboarding || this.memory.stats.totalSessions === 0;
const basePrompt = isOnboarding ? ONBOARDING_PROMPT : buildSystemPrompt(this.memory.personality as any);
const memoryContext = buildMemoryContext(this.memory);
const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;
```

**After getting the `reply`**, add memory update parsing (after the existing `parsedConfig` check):

```typescript
// Parse memory updates from AI response
const memUpdate = parseMemoryUpdate(reply);
if (memUpdate) {
  applyMemoryUpdate(this.memory, memUpdate);
  logger.info(`Manager: memory updated — ${memUpdate.learnedFacts.length} facts, ${memUpdate.insights.length} insights`);
}

// Add to recentChat
this.memory.recentChat.push({ role: 'user', text, timestamp: Date.now() });
this.memory.recentChat.push({ role: 'assistant', text: stripMemoryTags(reply).slice(0, 2000), timestamp: Date.now() });
this.memory.stats.totalMessages += 2;
this.memory.stats.lastInteraction = new Date().toISOString().slice(0, 10);
if (!this.memory.stats.firstInteraction) {
  this.memory.stats.firstInteraction = this.memory.stats.lastInteraction;
}

// Save memory after every chat
saveMemory(this.memory);

// Auto-distill if chat too long
if (this.memory.recentChat.length > MAX_RECENT_CHAT) {
  this.distill().catch(err => logger.warn(`Manager: auto-distill failed — ${err}`));
}
```

**In the clean reply line**, also strip memory tags:

```typescript
// Replace the existing cleanReply line with:
const cleanReply = stripMemoryTags(
  reply
    .replace(/\[WRITE_TO:[^\]]+\][^[]*\[\/WRITE_TO\]/g, '')
    .replace(/\[SEND_ENTER:[^\]]+\]/g, '')
    .replace(/\[PERSONALITY_CONFIG\][\s\S]*?\[\/PERSONALITY_CONFIG\]/g, '')
);
```

- [ ] **Step 4: Apply personality from memory instead of local field**

In `handleChat`, after the `parsedConfig` block, sync personality to memory:

```typescript
if (parsedConfig) {
  this.personality = parsedConfig;
  // Also save to memory
  this.memory.personality = {
    ...this.memory.personality,
    agentName: parsedConfig.agentName,
    tone: parsedConfig.tone,
    detail: parsedConfig.detail,
    emojis: parsedConfig.emojis,
    proactive: parsedConfig.proactive,
  };
  this.onPersonalityConfigured?.(parsedConfig);
  logger.info(`Manager: onboarding complete — name="${parsedConfig.agentName}", tone=${parsedConfig.tone}`);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(memory): integrate memory into chat flow"
```

---

### Task 6: Add Distillation Method to ManagerService

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Add the distill method**

Add this method to the `ManagerService` class (after `handleChat`):

```typescript
  // ── Memory Distillation ─────────────────────────────────────────────────

  /** Distill recentChat into insights and clear the short-term memory. */
  async distill(): Promise<void> {
    if (this.memory.recentChat.length === 0) return;

    logger.info(`Manager: distilling ${this.memory.recentChat.length} messages...`);

    try {
      const provider = this.registry.getActive();
      const prompt = buildDistillationPrompt(this.memory.recentChat);
      const reply = await provider.chat(
        [{ role: 'user', content: prompt }],
        'Du bist ein Gedächtnis-Assistent. Extrahiere die wichtigsten Erkenntnisse aus dem Chat-Verlauf.',
      );

      const update = parseMemoryUpdate(reply);
      if (update) {
        applyMemoryUpdate(this.memory, update);
        logger.info(`Manager: distilled — ${update.insights.length} insights, ${update.learnedFacts.length} facts`);
      }

      finalizeDistillation(this.memory);
      saveMemory(this.memory);
      logger.info('Manager: distillation complete, recentChat cleared');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: distillation failed — ${msg}`);
      // Don't lose the chat — save what we have
      saveMemory(this.memory);
    }
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(memory): add distillation method"
```

---

### Task 7: Trigger Distillation on Disconnect

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`

- [ ] **Step 1: Add distillation call to ws.on('close')**

In `ws.handler.ts`, in the `ws.on('close', ...)` callback, add a distillation trigger after the existing detach loop:

```typescript
  ws.on('close', () => {
    logger.info(`Client disconnected: ${ip} — detaching ${ownedSessions.size} sessions (kept alive)`);
    for (const sessionId of ownedSessions) {
      const gen = sessionGens.get(sessionId);
      globalManager.detachSession(sessionId, gen);
    }
    ownedSessions.clear();
    sessionGens.clear();

    // Distill manager memory on disconnect (session end)
    if (managerService.isEnabled()) {
      managerService.distill().catch(err => {
        logger.warn(`Manager: disconnect distill failed — ${err instanceof Error ? err.message : err}`);
      });
    }
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(memory): trigger distillation on client disconnect"
```

---

### Task 8: Update Summary Polling to Use Memory

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Update poll() to use memory context**

In the `poll()` method, update the system prompt to include memory context:

```typescript
// Replace:
//   const systemPrompt = buildSystemPrompt(this.personality);

// With:
this.memory = loadMemory();
const basePrompt = buildSystemPrompt(this.memory.personality as any);
const memoryContext = buildMemoryContext(this.memory);
const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;
```

After getting the poll reply, also parse memory updates:

```typescript
// After the existing reply handling, before clearing buffers:
const memUpdate = parseMemoryUpdate(reply);
if (memUpdate) {
  applyMemoryUpdate(this.memory, memUpdate);
  saveMemory(this.memory);
}
```

- [ ] **Step 2: Strip memory tags from summary text**

Import `stripMemoryTags` if not already imported, and strip from the summary text:

```typescript
// In the summary callback, strip tags:
const summary: ManagerSummary = {
  text: stripMemoryTags(reply),
  sessions: sessionInfo,
  timestamp: now,
};
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(memory): use memory context in summary polling"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Full TypeScript check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Verify memory file is created on first use**

Run: `ls -la ~/.tms-terminal/manager-memory.json`
Expected: file does not exist yet (created on first manager:toggle)

- [ ] **Step 3: Commit any remaining changes**

```bash
git add -A
git commit -m "feat: Manager Agent memory system — persistent learning across sessions"
```

- [ ] **Step 4: Build release**

```bash
cd mobile
# No mobile changes needed — memory is server-only
# But bump patch for server update awareness
```

Since this is server-only, no APK build needed. Just push:

```bash
git push origin master
```
