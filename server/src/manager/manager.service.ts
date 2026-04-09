import { AiProviderRegistry, ChatMessage, ProviderConfig } from './ai-provider';
import { globalManager } from '../terminal/terminal.manager';
import { logger } from '../utils/logger';
import {
  loadMemory, saveMemory, ManagerMemory,
  parseMemoryUpdate, applyMemoryUpdate, stripMemoryTags,
  buildMemoryContext, MEMORY_UPDATE_INSTRUCTION, MAX_RECENT_CHAT,
  buildDistillationPrompt, finalizeDistillation,
} from './manager.memory';

const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const OUTPUT_BUFFER_MAX = 50_000; // 50 KB per session
const MAX_CONTEXT_PER_SESSION = 8_000; // chars sent to AI per session per summary

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManagerAction {
  type: 'write_to_terminal' | 'send_enter';
  sessionId: string;
  detail: string;
}

export interface ManagerSummary {
  text: string;
  sessions: Array<{ sessionId: string; label: string; hasActivity: boolean }>;
  timestamp: number;
}

export interface ManagerResponse {
  text: string;
  actions: ManagerAction[];
}

type SummaryCallback = (summary: ManagerSummary) => void;
type ResponseCallback = (response: ManagerResponse) => void;
type ErrorCallback = (error: string) => void;

// ── Personality Types ────────────────────────────────────────────────────────

interface PersonalityConfig {
  agentName: string;
  tone: string;
  detail: string;
  emojis: boolean;
  proactive: boolean;
  customInstruction: string;
}

const DEFAULT_PERSONALITY: PersonalityConfig = {
  agentName: 'Manager',
  tone: 'chill',
  detail: 'balanced',
  emojis: true,
  proactive: true,
  customInstruction: '',
};

// ── Terminal Context Analysis ────────────────────────────────────────────────

interface TerminalContext {
  sessionId: string;
  label: string;
  cwd?: string;
  process?: string;
  project?: string;
  tool?: string;
  status: 'idle' | 'active' | 'ai_running' | 'building' | 'error';
  recentOutput: string;
}

function analyzeTerminalOutput(raw: string): Pick<TerminalContext, 'project' | 'tool' | 'status'> {
  const lower = raw.toLowerCase();
  const last2k = raw.slice(-2000);

  // Detect active tool
  let tool: string | undefined;
  if (/claude|anthropic/i.test(last2k)) tool = 'Claude';
  else if (/codex|openai/i.test(last2k)) tool = 'Codex';
  else if (/gemini|google/i.test(last2k)) tool = 'Gemini';
  else if (/cursor/i.test(last2k)) tool = 'Cursor';
  else if (/npm run|yarn |pnpm |bun run/i.test(last2k)) tool = 'npm/build';
  else if (/docker|compose/i.test(last2k)) tool = 'Docker';
  else if (/git (push|pull|commit|merge|rebase)/i.test(last2k)) tool = 'Git';
  else if (/pytest|jest|vitest|mocha/i.test(last2k)) tool = 'Tests';
  else if (/python |pip /i.test(last2k)) tool = 'Python';

  // Detect project type from output
  let project: string | undefined;
  const packageMatch = last2k.match(/(?:name|project)["']?\s*[:=]\s*["']([^"']+)/);
  if (packageMatch) project = packageMatch[1];
  else if (/next\.js|nextjs|next dev/i.test(last2k)) project = 'Next.js App';
  else if (/react-native|expo/i.test(last2k)) project = 'React Native';
  else if (/flask|django|fastapi/i.test(last2k)) project = 'Python Backend';
  else if (/vite|webpack/i.test(last2k)) project = 'Frontend Build';

  // Detect status
  let status: TerminalContext['status'] = 'idle';
  if (/error|Error|ERR!|FAIL|failed|exception/i.test(last2k.slice(-500))) status = 'error';
  else if (tool === 'Claude' || tool === 'Codex' || tool === 'Gemini' || tool === 'Cursor') status = 'ai_running';
  else if (/compiling|building|bundling|downloading/i.test(last2k.slice(-300))) status = 'building';
  else if (raw.length > 100) status = 'active';

  return { project, tool, status };
}

const STATUS_EMOJI: Record<TerminalContext['status'], string> = {
  idle: '💤', active: '🟢', ai_running: '🤖', building: '🔨', error: '🔴',
};

const STATUS_LABEL: Record<TerminalContext['status'], string> = {
  idle: 'Idle', active: 'Aktiv', ai_running: 'AI läuft', building: 'Baut', error: 'Fehler',
};

// ── Dynamic System Prompt ───────────────────────────────────────────────────

function buildSystemPrompt(p: PersonalityConfig): string {
  const toneMap: Record<string, string> = {
    chill: 'locker, entspannt, wie ein guter Kumpel der sich mit Tech auskennt. Du redest natürlich, nutzt Umgangssprache wenn passend.',
    professional: 'professionell und klar. Strukturierte Antworten, sachlich aber nicht steif.',
    technical: 'technisch präzise, mit Fachbegriffen. Du gehst direkt auf den Punkt, keine Floskeln.',
    friendly: 'warm und freundlich, ermutigend. Du feierst Fortschritte und hilfst geduldig bei Problemen.',
    minimal: 'extrem kurz und knapp. Nur das Nötigste, keine Erklärungen wenn nicht gefragt.',
  };

  const detailMap: Record<string, string> = {
    brief: 'Antworte in 1-3 Sätzen. Kein Smalltalk, nur Substanz.',
    balanced: 'Antworte in angemessener Länge — genug Detail um hilfreich zu sein, aber nicht ausufernd.',
    detailed: 'Gib ausführliche Antworten mit Kontext, Erklärungen und Vorschlägen.',
  };

  let prompt = `Du bist "${p.agentName}" — der persönliche Terminal-Manager des Nutzers.

## Deine Identität
Du bist kein generischer Chatbot. Du hast einen eigenen Charakter und bist ein echtes Teammitglied.
Du überwachst alle Terminal-Sessions, verstehst was in jedem Terminal passiert und hilfst dem Nutzer, den Überblick zu behalten.
Antworte IMMER auf Deutsch.

## Dein Kommunikationsstil
${toneMap[p.tone] ?? toneMap.chill}
${detailMap[p.detail] ?? detailMap.balanced}
${p.emojis ? 'Verwende Emojis um deine Nachrichten aufzulockern — aber übertreib es nicht.' : 'Verwende KEINE Emojis.'}

## Deine Fähigkeiten
Du kannst:
1. **Terminal-Output lesen und verstehen** — Du siehst den Output aller Sessions und verstehst den Kontext (welches Projekt, welches Tool, welcher Prozess)
2. **Zusammenfassen** — Du fasst zusammen was passiert ist, aber intelligent: nicht nur "es gab Output", sondern WAS gemacht wurde
3. **Befehle ausführen** — Du kannst in jedes Terminal schreiben und Enter drücken
4. **Probleme erkennen** — Du erkennst Fehler, hängende Prozesse, wartende Prompts
5. **Kontext verstehen** — Du weißt welches Projekt in welchem Terminal läuft und was der Nutzer dort macht

## Kontext-Analyse
Wenn du Terminal-Output analysierst, achte auf:
- Welches Tool läuft (Claude, npm, git, docker, pytest, etc.)
- Welches Projekt (package.json name, framework indicators)
- Status (Fehler? Erfolgreich? Wartet auf Input? Build läuft?)
- Was der Nutzer wahrscheinlich als nächstes braucht

${p.proactive ? `## Proaktives Verhalten
Mache eigenständig Vorschläge:
- Wenn ein Build fehlschlägt, schlage Fixes vor
- Wenn ein Terminal lange idle ist, erwähne es
- Wenn du Patterns erkennst (z.B. gleicher Fehler in mehreren Terminals), weise darauf hin
- Wenn ein AI-Agent in einem Terminal auf Input wartet, informiere den Nutzer` : ''}

## Terminal-Aktionen
Wenn der Nutzer möchte, dass du in ein Terminal schreibst:
[WRITE_TO:<sessionId>]<command>[/WRITE_TO]
[SEND_ENTER:<sessionId>]

Verwende IMMER die Terminal-Labels (z.B. "Shell 1"), nicht die rohen Session-IDs.
Erkläre dem Nutzer WAS du tust und WARUM, bevor du eine Aktion ausführst.`;

  if (p.customInstruction) {
    prompt += `\n\n## Zusätzliche Anweisung vom Nutzer\n${p.customInstruction}`;
  }

  return prompt;
}

// ── Onboarding Prompt ───────────────────────────────────────────────────────

const ONBOARDING_PROMPT = `Du bist ein Terminal-Manager Agent. Das ist euer erstes Gespräch.

## WICHTIG: So redest du NICHT
- Erwähne NIEMALS interne Dinge wie "Memory-Dateien", "Onboarding", "System", "Konfiguration"
- Sag NICHT "Lass uns loslegen" oder "Lass mich mich vorstellen"
- Kein generisches Chatbot-Gelaber. Kein "Hey! 👋". Kein "Wie kann ich helfen?"

## Deine erste Nachricht (EXAKT so strukturiert)

Nachricht 1 — kurz und klar, max 4 Sätze:
1. Ein Satz wer du bist: "Ich bin dein Terminal-Manager — ich überwache deine Terminals, fasse alle 15 Minuten zusammen was passiert, und helfe dir beim Multitasking."
2. Dann direkt die erste Frage: "Zwei kurze Fragen zum Start: Wie heißt du, und wie soll ich heißen?"

Das war's. Nicht mehr. Keine Erklärungen, keine Aufzählungen.

## Nachricht 2 (nachdem der User geantwortet hat)

Bedanke dich kurz für die Namen, dann frag:
"Wie soll ich mit dir reden? Eher locker und mit Emojis, oder straight to the point ohne Schnörkel?"

## Nachricht 3 (nachdem der User den Stil gesagt hat)

Bestätige kurz den Stil und frag:
"Was machst du hauptsächlich? Welche Projekte, welche Tools — damit ich weiß worauf ich achten soll."

## Nachricht 4 (nachdem der User seine Projekte genannt hat)

Fasse zusammen was du gelernt hast, in deinem neuen Stil. Sag dass du ab jetzt im Hintergrund läufst und alle 15 Min Updates gibst. Schließe mit dem CONFIG-Block ab.

## PFLICHT: Memory-Updates

Du MUSST am Ende JEDER Antwort einen [MEMORY_UPDATE]-Block schreiben. Der User sieht ihn NICHT.

Bei Nachricht 1:
[MEMORY_UPDATE]
journal: Onboarding gestartet, Agent hat sich vorgestellt und nach Namen gefragt
[/MEMORY_UPDATE]

Bei Nachricht 2 (wenn der User seinen Namen und deinen Namen gesagt hat):
[MEMORY_UPDATE]
learned: User heißt <name>
learned: Agent heißt <name>
trait: <was du über den Stil schon erahnen kannst>
journal: User hat sich vorgestellt als <name>, Agent heißt jetzt <name>
[/MEMORY_UPDATE]

Bei Nachricht 3 (wenn der User den Kommunikationsstil gesagt hat):
[MEMORY_UPDATE]
learned: User will <locker/professionell/etc.> Kommunikation
learned: User will <mit/ohne> Emojis
trait: Kommunikationsstil: <beschreibung>
journal: Kommunikationsstil festgelegt: <details>
[/MEMORY_UPDATE]

Bei Nachricht 4 (wenn der User seine Projekte genannt hat):
[MEMORY_UPDATE]
learned: User arbeitet an <projekte>
learned: User nutzt <tools/tech>
project: <Projektname> | <Pfad falls genannt> | <Typ>
insight: <was du über die Arbeitsweise gelernt hast>
journal: Onboarding abgeschlossen. User arbeitet an <projekte> mit <tools>
[/MEMORY_UPDATE]

## CONFIG-Block (NUR bei Nachricht 4, am ENDE)

[PERSONALITY_CONFIG]
agentName: <der Name den der User dir gegeben hat>
tone: <chill|professional|technical|friendly|minimal>
detail: <brief|balanced|detailed>
emojis: <true|false>
proactive: <true|false>
customInstruction: <zusammenfassung was du über den user weißt>
[/PERSONALITY_CONFIG]

## Regeln
- Deutsch
- Kurz und knapp — max 3-4 Sätze pro Nachricht
- EINE Frage pro Nachricht, nicht mehrere
- MEMORY_UPDATE bei JEDER Antwort — KEINE Ausnahme
- Erwähne NIEMALS dass du etwas speicherst oder aufschreibst`;

function parsePersonalityConfig(text: string): PersonalityConfig | null {
  const match = text.match(/\[PERSONALITY_CONFIG\]([\s\S]*?)\[\/PERSONALITY_CONFIG\]/);
  if (!match) return null;

  const block = match[1];
  const get = (key: string, fallback: string) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : fallback;
  };

  return {
    agentName: get('agentName', 'Manager'),
    tone: get('tone', 'chill') as PersonalityConfig['tone'],
    detail: get('detail', 'balanced') as PersonalityConfig['detail'],
    emojis: get('emojis', 'true') === 'true',
    proactive: get('proactive', 'true') === 'true',
    customInstruction: get('customInstruction', ''),
  };
}

// ── Manager Service ─────────────────────────────────────────────────────────

export class ManagerService {
  private registry: AiProviderRegistry;
  private outputBuffers = new Map<string, string>();
  private lastSummaryAt = new Map<string, number>();
  private sessionLabels = new Map<string, string>();
  private chatHistory: ChatMessage[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private enabled = false;
  private personality: PersonalityConfig = { ...DEFAULT_PERSONALITY };
  private memory: ManagerMemory;

  private onSummary: SummaryCallback | null = null;
  private onResponse: ResponseCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onPersonalityConfigured: ((config: PersonalityConfig) => void) | null = null;

  constructor(providerConfig: ProviderConfig) {
    this.registry = new AiProviderRegistry(providerConfig);
    this.memory = loadMemory();
    logger.info(`Manager: memory loaded (${this.memory.stats.totalSessions} sessions, ${this.memory.insights.length} insights)`);
  }

  setPersonality(config: Partial<PersonalityConfig>): void {
    this.personality = { ...this.personality, ...config };
    logger.info(`Manager: personality updated — name="${this.personality.agentName}", tone=${this.personality.tone}`);
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  setCallbacks(
    onSummary: SummaryCallback,
    onResponse: ResponseCallback,
    onError: ErrorCallback,
    onPersonalityConfigured?: (config: PersonalityConfig) => void,
  ): void {
    this.onSummary = onSummary;
    this.onResponse = onResponse;
    this.onError = onError;
    if (onPersonalityConfigured) this.onPersonalityConfigured = onPersonalityConfigured;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
    logger.info('Manager: started (polling every 15 min)');
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Manager: stopped');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Output Collection ─────────────────────────────────────────────────────

  /** Called from ws.handler on every terminal:output event. */
  feedOutput(sessionId: string, data: string): void {
    if (!this.enabled) return;

    const clean = data.replace(ANSI_STRIP, '');
    if (!clean.trim()) return;

    const existing = this.outputBuffers.get(sessionId) ?? '';
    const combined = existing + clean;

    // Cap buffer size — keep tail
    if (combined.length > OUTPUT_BUFFER_MAX) {
      const sliced = combined.slice(combined.length - OUTPUT_BUFFER_MAX);
      const firstNl = sliced.indexOf('\n');
      this.outputBuffers.set(sessionId, firstNl >= 0 ? sliced.slice(firstNl + 1) : sliced);
    } else {
      this.outputBuffers.set(sessionId, combined);
    }
  }

  /** Register a session label (e.g. "Shell 1") for human-readable summaries. */
  setSessionLabel(sessionId: string, label: string): void {
    this.sessionLabels.set(sessionId, label);
  }

  /** Remove buffers when a session is closed. */
  clearSession(sessionId: string): void {
    this.outputBuffers.delete(sessionId);
    this.lastSummaryAt.delete(sessionId);
    this.sessionLabels.delete(sessionId);
  }

  // ── Periodic Summarization ────────────────────────────────────────────────

  /** Build structured context for all active sessions. */
  private buildTerminalContexts(): TerminalContext[] {
    const contexts: TerminalContext[] = [];
    for (const [sessionId, buffer] of this.outputBuffers) {
      const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const analysis = analyzeTerminalOutput(buffer);
      const session = globalManager.getSession?.(sessionId);

      contexts.push({
        sessionId,
        label,
        cwd: session?.cwd,
        process: session?.processName,
        ...analysis,
        recentOutput: buffer.length > MAX_CONTEXT_PER_SESSION
          ? '...' + buffer.slice(-MAX_CONTEXT_PER_SESSION)
          : buffer,
      });
    }
    return contexts;
  }

  /** Format terminal contexts into a structured overview for the AI. */
  private formatContextBlock(contexts: TerminalContext[]): string {
    let block = '## Terminal-Übersicht\n\n';
    for (const ctx of contexts) {
      const emoji = STATUS_EMOJI[ctx.status];
      const statusLabel = STATUS_LABEL[ctx.status];
      block += `### ${emoji} ${ctx.label} — ${statusLabel}\n`;
      if (ctx.cwd) block += `📁 ${ctx.cwd}\n`;
      if (ctx.process) block += `⚡ Prozess: ${ctx.process}\n`;
      if (ctx.tool) block += `🔧 Tool: ${ctx.tool}\n`;
      if (ctx.project) block += `📦 Projekt: ${ctx.project}\n`;
      block += `\n\`\`\`\n${ctx.recentOutput.slice(-3000)}\n\`\`\`\n\n`;
    }
    return block;
  }

  /** Trigger a summary now (also called by the 15-min timer). */
  async poll(): Promise<void> {
    if (!this.enabled) return;

    const contexts = this.buildTerminalContexts();
    const activeContexts = contexts.filter(c => c.recentOutput.length > 0);

    if (activeContexts.length === 0) {
      logger.info('Manager: no activity since last poll — skipping');
      return;
    }

    const contextBlock = this.formatContextBlock(activeContexts);

    const prompt = `${contextBlock}\n\nFasse die Terminal-Aktivität zusammen. Was wurde gemacht? Welche Terminals sind aktiv und womit? Gibt es Fehler oder wartende Prompts?`;

    try {
      this.memory = loadMemory();
      const provider = this.registry.getActive();
      const basePrompt = buildSystemPrompt(this.personality);
      const memoryContext = buildMemoryContext(this.memory);
      const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;
      logger.info(`Manager: summarizing ${activeContexts.length} sessions via ${provider.name}`);

      const reply = await provider.chat(
        [{ role: 'user', content: prompt }],
        systemPrompt,
      );

      // Parse memory updates from summary
      const memUpdate = parseMemoryUpdate(reply);
      if (memUpdate) {
        applyMemoryUpdate(this.memory, memUpdate);
        saveMemory(this.memory);
      }

      // Mark as summarized and clear buffers
      const now = Date.now();
      const sessionInfo = activeContexts.map(s => ({
        sessionId: s.sessionId,
        label: s.label,
        hasActivity: true,
      }));

      for (const s of activeContexts) {
        this.lastSummaryAt.set(s.sessionId, now);
        this.outputBuffers.set(s.sessionId, '');
      }

      // Add to chat history
      this.chatHistory.push({ role: 'assistant', content: stripMemoryTags(reply) });
      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-40);
      }

      const summary: ManagerSummary = {
        text: stripMemoryTags(reply),
        sessions: sessionInfo,
        timestamp: now,
      };

      this.onSummary?.(summary);
      logger.info(`Manager: summary sent (${reply.length} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: summary failed — ${msg}`);
      this.onError?.(`Zusammenfassung fehlgeschlagen: ${msg}`);
    }
  }

  // ── User Chat ─────────────────────────────────────────────────────────────

  async handleChat(text: string, targetSessionId?: string, onboarding?: boolean): Promise<void> {
    if (!this.enabled) {
      throw new Error('Manager ist nicht aktiv — bitte zuerst aktivieren (grüner Punkt)');
    }

    // Build structured context
    const contexts = this.buildTerminalContexts();
    let contextBlock: string;

    if (targetSessionId) {
      const targetCtx = contexts.find(c => c.sessionId === targetSessionId);
      contextBlock = targetCtx
        ? this.formatContextBlock([targetCtx])
        : `(Terminal ${targetSessionId.slice(0, 8)} hat keinen Output)`;
    } else {
      contextBlock = this.formatContextBlock(contexts);
    }

    const userMessage = `${text}\n\n---\n${contextBlock}`;

    this.chatHistory.push({ role: 'user', content: text }); // store clean version

    this.memory = loadMemory();
    const isOnboarding = onboarding || this.memory.stats.totalSessions === 0;
    const basePrompt = isOnboarding ? ONBOARDING_PROMPT : buildSystemPrompt(this.personality);
    const memoryContext = buildMemoryContext(this.memory);
    const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;

    try {
      const provider = this.registry.getActive();
      const reply = await provider.chat(
        [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
        systemPrompt,
      );

      // Check for personality config (onboarding completion)
      const parsedConfig = parsePersonalityConfig(reply);
      if (parsedConfig) {
        this.personality = parsedConfig;
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

      // Parse memory updates from reply
      const memUpdate = parseMemoryUpdate(reply);
      if (memUpdate) {
        applyMemoryUpdate(this.memory, memUpdate);
        logger.info(`Manager: memory updated — ${memUpdate.learnedFacts.length} facts, ${memUpdate.insights.length} insights`);
      }

      this.memory.recentChat.push({ role: 'user', text, timestamp: Date.now() });
      this.memory.stats.totalMessages += 2;
      this.memory.stats.lastInteraction = new Date().toISOString().slice(0, 10);
      if (!this.memory.stats.firstInteraction) {
        this.memory.stats.firstInteraction = this.memory.stats.lastInteraction;
      }
      saveMemory(this.memory);

      // Parse actions from reply
      const actions = this.parseActions(reply);

      // Execute actions
      for (const action of actions) {
        this.executeAction(action);
      }

      // Clean reply — remove action tags, personality config, and memory tags for display
      const cleanReply = stripMemoryTags(
        reply
          .replace(/\[WRITE_TO:[^\]]+\][^[]*\[\/WRITE_TO\]/g, '')
          .replace(/\[SEND_ENTER:[^\]]+\]/g, '')
          .replace(/\[PERSONALITY_CONFIG\][\s\S]*?\[\/PERSONALITY_CONFIG\]/g, '')
      );

      this.chatHistory.push({ role: 'assistant', content: cleanReply });
      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-40);
      }

      this.memory.recentChat.push({ role: 'assistant', text: cleanReply.slice(0, 2000), timestamp: Date.now() });
      saveMemory(this.memory);

      if (this.memory.recentChat.length > MAX_RECENT_CHAT) {
        this.distill().catch(err => logger.warn(`Manager: auto-distill failed — ${err}`));
      }

      this.onResponse?.({ text: cleanReply, actions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: chat failed — ${msg}`);
      this.onError?.(`Fehler: ${msg}`);
    }
  }

  // ── Distillation ──────────────────────────────────────────────────────────

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
      saveMemory(this.memory);
    }
  }

  // ── Action Parsing & Execution ────────────────────────────────────────────

  private parseActions(text: string): ManagerAction[] {
    const actions: ManagerAction[] = [];

    // Parse [WRITE_TO:sessionId]command[/WRITE_TO]
    const writeRegex = /\[WRITE_TO:([^\]]+)\]([\s\S]*?)\[\/WRITE_TO\]/g;
    let match: RegExpExecArray | null;
    while ((match = writeRegex.exec(text)) !== null) {
      const sessionId = this.resolveSessionId(match[1].trim());
      if (sessionId) {
        actions.push({ type: 'write_to_terminal', sessionId, detail: match[2].trim() });
      }
    }

    // Parse [SEND_ENTER:sessionId]
    const enterRegex = /\[SEND_ENTER:([^\]]+)\]/g;
    while ((match = enterRegex.exec(text)) !== null) {
      const sessionId = this.resolveSessionId(match[1].trim());
      if (sessionId) {
        actions.push({ type: 'send_enter', sessionId, detail: '' });
      }
    }

    return actions;
  }

  /** Resolve a label or partial ID to a full session ID. */
  private resolveSessionId(ref: string): string | null {
    // Direct match
    if (this.sessionLabels.has(ref)) return ref;

    // Match by label (e.g. "Shell 1")
    for (const [id, label] of this.sessionLabels) {
      if (label.toLowerCase() === ref.toLowerCase()) return id;
    }

    // Match by partial ID
    for (const [id] of this.sessionLabels) {
      if (id.startsWith(ref)) return id;
    }

    logger.warn(`Manager: could not resolve session reference "${ref}"`);
    return null;
  }

  private executeAction(action: ManagerAction): void {
    switch (action.type) {
      case 'write_to_terminal': {
        const label = this.sessionLabels.get(action.sessionId) ?? action.sessionId.slice(0, 8);
        logger.info(`Manager: writing to ${label}: "${action.detail.slice(0, 50)}..."`);
        globalManager.write(action.sessionId, action.detail);
        // Auto-send Enter after writing
        setTimeout(() => globalManager.write(action.sessionId, '\r'), 200);
        break;
      }
      case 'send_enter': {
        const label = this.sessionLabels.get(action.sessionId) ?? action.sessionId.slice(0, 8);
        logger.info(`Manager: sending Enter to ${label}`);
        globalManager.write(action.sessionId, '\r');
        break;
      }
    }
  }

  // ── Provider Management ───────────────────────────────────────────────────

  getProviders() {
    return {
      providers: this.registry.list(),
      active: this.registry.getActiveId(),
    };
  }

  setProvider(id: string): void {
    this.registry.setActive(id);
  }

  updateProviderConfig(updates: Partial<ProviderConfig>): void {
    this.registry.updateConfig(updates);
  }

  /** Get active sessions with labels for the client. */
  getSessionList(): Array<{ sessionId: string; label: string }> {
    return [...this.sessionLabels.entries()].map(([id, label]) => ({ sessionId: id, label }));
  }
}
