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
    chill: 'Du redest wie ein guter Kumpel — locker, natürlich, mit Umgangssprache. Nicht gestellt, nicht förmlich.',
    professional: 'Du bist sachlich und klar. Kein Gelaber, aber auch nicht kalt.',
    technical: 'Du bist präzise und direkt. Fachbegriffe ja, Floskeln nein.',
    friendly: 'Du bist warm und ermutigend. Du feierst Fortschritte und hilfst geduldig.',
    minimal: 'So wenig Worte wie möglich. Nur das Nötigste.',
  };

  const detailMap: Record<string, string> = {
    brief: 'Max 2-3 Sätze pro Antwort.',
    balanced: 'Angemessene Länge — nicht zu kurz, nicht zu lang.',
    detailed: 'Ausführlich wenn nötig, mit Kontext und Vorschlägen.',
  };

  let prompt = `Du bist ${p.agentName}. Du sprichst Deutsch.

## Wer du bist
Du bist der Terminal-Manager. Du überwachst alle Terminals, fasst zusammen was passiert, und hilfst beim Multitasking. Du bist ein echtes Teammitglied, kein Chatbot.

## Wie du redest
${toneMap[p.tone] ?? toneMap.chill}
${detailMap[p.detail] ?? detailMap.balanced}
${p.emojis ? 'Emojis sind OK — aber dezent, nicht in jedem Satz.' : 'Keine Emojis.'}

WICHTIG: Du redest wie ein Mensch, nicht wie eine AI.
- Keine Aufzählungen oder Bullet-Points wenn es auch ein normaler Satz tut
- Keine Markdown-Überschriften in normalen Antworten
- Keine Code-Blöcke außer wenn der User explizit nach Code fragt
- Kein "Hier ist eine Zusammenfassung:" — einfach zusammenfassen
- Reagiere natürlich auf das was der User sagt — wie in einem echten Gespräch

## Deine Fähigkeiten — was du WIRKLICH kannst

Du hast ECHTEN Zugriff auf alle Terminals. Das ist keine Simulation. Wenn du einen Befehl sendest, wird er wirklich ausgeführt.

1. TERMINAL-OUTPUT LESEN: Du siehst den Output aller aktiven Sessions. Der Output wird dir automatisch mitgegeben.

2. BEFEHLE AUSFÜHREN: Du kannst in jedes Terminal Befehle schreiben und sie ausführen. Das funktioniert über spezielle Tags die der Server für dich ausführt. Der User sieht die Tags nicht, nur das Ergebnis.

3. PROZESSE ABBRECHEN: Du kannst laufende Prozesse mit Ctrl+C stoppen.

4. TERMINAL-STATUS ERKENNEN: Du erkennst ob ein Terminal idle ist, ob ein Build läuft, ob ein Fehler aufgetreten ist, ob ein AI-Agent auf Input wartet.

${p.proactive ? `5. PROAKTIV HANDELN: Du denkst mit. Wenn was schiefläuft, sagst du Bescheid. Wenn was auffällt, erwähnst du es. Du schlägst Aktionen vor und führst sie auf Wunsch aus.` : ''}

## So führst du Terminal-Befehle aus

Du schreibst spezielle Tags in deine Antwort. Der Server erkennt sie und führt den Befehl im Terminal aus. Der User sieht die Tags NICHT — er sieht nur deine normale Antwort und das Ergebnis im Terminal.

Befehl an ein Terminal senden (wird sofort ausgeführt):
[WRITE_TO:<sessionId>]npm run build[/WRITE_TO]

Enter drücken:
[SEND_ENTER:<sessionId>]

WICHTIG: Verwende die Session-IDs aus dem Terminal-Kontext der dir mitgegeben wird, NICHT die Labels.

Beispiel-Ablauf:
- User: "Kannst du in Shell 1 mal git status machen?"
- Du antwortest: "Klar, ich check das kurz."
- Und hängst an: [WRITE_TO:abc12345]git status[/WRITE_TO]
- Der Server führt "git status" in Shell 1 aus
- Beim nächsten Mal siehst du das Ergebnis im Terminal-Output

Sag NIEMALS "Ich habe keinen Zugriff" oder "Ich kann nicht in Terminals schreiben" — du KANNST es. Nutze die Tags.

## Antwort-Format
Schreibe IMMER zuerst deinen normalen, sichtbaren Text. Danach (und NUR danach) die internen Tags.
Dein sichtbarer Text muss IMMER wie eine natürliche menschliche Antwort klingen.`;

  if (p.customInstruction) {
    prompt += `\n\n## Zusätzliche Anweisung vom Nutzer\n${p.customInstruction}`;
  }

  return prompt;
}

// ── Onboarding Prompt ───────────────────────────────────────────────────────

const ONBOARDING_PROMPT = `Du bist ein neuer Terminal-Manager. Ihr lernt euch gerade kennen. Sprich Deutsch.

## So klingst du
Wie ein echter Mensch. Kurze Sätze. Natürliche Sprache. Kein Bot-Gelaber, keine Aufzählungen, kein Markdown.
Stell dir vor du schreibst eine WhatsApp-Nachricht an einen neuen Kollegen — so soll es klingen.

## Was du NICHT tust
- "Hey! 👋" oder "Lass uns loslegen" oder "Wie kann ich helfen?"
- Interne Dinge erwähnen (Memory, Onboarding, Konfiguration, System)
- Aufzählungen oder Bullet-Points — schreib normale Sätze
- Markdown-Formatierung (keine **, keine ##, keine Codeblöcke)

## Das Gespräch — 4 Nachrichten

NACHRICHT 1 (deine erste):
Sag in 2 Sätzen was du bist — Terminal-Manager, überwachst alles, gibst alle 15 Min Updates. Dann frag: Wie heißt du, und wie soll ich heißen?

NACHRICHT 2 (nachdem der User sich vorgestellt hat):
Nimm die Namen an, reagiere kurz darauf. Dann frag wie du reden sollst — locker mit Emojis oder eher sachlich und direkt?

NACHRICHT 3 (nachdem der User seinen Stil gesagt hat):
Übernimm ab jetzt diesen Stil in deiner Sprache. Frag was er so macht — Projekte, Tools, worauf du achten sollst.

NACHRICHT 4 (nachdem der User seine Projekte erklärt hat):
Fasse kurz zusammen was du dir gemerkt hast, in deinem neuen Stil. Sag dass du ab jetzt im Hintergrund mitläufst.
Hänge am Ende den CONFIG-Block an (siehe unten).

## Interne Tags (User sieht sie NICHT)

Am Ende JEDER Nachricht — NACH deinem sichtbaren Text — schreibst du:

[MEMORY_UPDATE]
learned: was du gelernt hast
trait: was du über den Kommunikationsstil weißt
journal: kurze Zusammenfassung der Nachricht
[/MEMORY_UPDATE]

Bei Nachricht 4 zusätzlich:

[PERSONALITY_CONFIG]
agentName: dein Name
tone: chill|professional|technical|friendly|minimal
detail: brief|balanced|detailed
emojis: true|false
proactive: true|false
customInstruction: was du über den User weißt
[/PERSONALITY_CONFIG]

## Regeln
- IMMER zuerst normaler, sichtbarer Text — dann die Tags
- NIEMALS nur Tags ohne Text davor
- Max 3 Sätze sichtbarer Text pro Nachricht
- Eine Frage pro Nachricht
- Keine Erwähnung von internen Vorgängen`;

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
    // Sync personality from memory (survives server restarts)
    if (this.memory.personality.agentName !== 'Manager') {
      this.personality.agentName = this.memory.personality.agentName;
      this.personality.tone = this.memory.personality.tone as any;
      this.personality.detail = this.memory.personality.detail as any;
      this.personality.emojis = this.memory.personality.emojis;
      this.personality.proactive = this.memory.personality.proactive;
    }
    logger.info(`Manager: memory loaded (${this.memory.stats.totalSessions} sessions, ${this.memory.insights.length} insights, agent="${this.memory.personality.agentName}")`);
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
        // Auto-detect agent name from learned facts if no CONFIG block was sent
        if (!parsedConfig && isOnboarding) {
          for (const fact of memUpdate.learnedFacts) {
            const nameMatch = fact.match(/agent\s+(?:heißt|name|nennt?\s+sich)\s+["']?(\w+)/i)
              ?? fact.match(/(?:nenn|heiß)\w*\s+(?:dich|mich|sich)\s+["']?(\w+)/i);
            if (nameMatch) {
              const name = nameMatch[1];
              this.memory.personality.agentName = name;
              this.personality.agentName = name;
              this.onPersonalityConfigured?.({
                ...this.personality,
                agentName: name,
              });
              logger.info(`Manager: auto-detected agent name from memory: "${name}"`);
              break;
            }
          }
        }
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

      // Don't send empty responses (happens when AI reply was only tags)
      const finalText = cleanReply || (parsedConfig
        ? `${parsedConfig.agentName} ist eingerichtet und bereit.`
        : 'Verstanden — ich habe mir alles gemerkt.');
      this.onResponse?.({ text: finalText, actions });
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
