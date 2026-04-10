import { AiProviderRegistry, ChatMessage, ProviderConfig, ToolDefinition, StreamResult } from './ai-provider';
import { globalManager } from '../terminal/terminal.manager';
import { readProcessCwd } from '../terminal/cwd.utils';
import { logger } from '../utils/logger';
import type { PhaseInfo } from '../../../shared/protocol';
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

// ── Native Tool Definitions (for GLM) ──────────────────────────────────────

const MANAGER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_to_terminal',
      description: 'Schreibt einen Shell-Befehl in ein Terminal und führt ihn aus. NUR nutzen wenn der User EXPLIZIT einen konkreten Befehl ausführen will (z.B. "schreib git status in Shell 1"). NICHT nutzen bei normalen Gesprächen.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Terminal-Name oder Shell-Nummer, z.B. "Shell 1", "ayysir", "TMS Terminal"' },
          command: { type: 'string', description: 'Der auszuführende Befehl, z.B. "git status", "npm run build"' },
        },
        required: ['session_label', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_enter',
      description: 'Drückt Enter in einem Terminal. Nutze dies um wartende Prompts zu bestätigen.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Das Terminal-Label, z.B. "Shell 1"' },
        },
        required: ['session_label'],
      },
    },
  },
];

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
type ThinkingCallback = (phase: string, detail?: string, elapsed?: number) => void;
type StreamChunkCallback = (token: string) => void;
type StreamEndCallback = (text: string, actions: ManagerAction[], phases: PhaseInfo[]) => void;

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

## Deine Fähigkeiten

Du hast ECHTEN Zugriff auf alle Terminals. Das ist keine Simulation.

1. TERMINAL-OUTPUT LESEN: Du siehst den Output aller aktiven Sessions. Der Output wird dir automatisch mitgegeben.

2. BEFEHLE AUSFÜHREN: Du hast Terminal-Tools (write_to_terminal, send_enter). Nutze sie SOFORT wenn der User einen Befehl ausführen will. Frag NICHT nach ob er sicher ist — führ es einfach aus.

3. PROZESSE ABBRECHEN: Du kannst laufende Prozesse mit Ctrl+C stoppen (schreibe dafür das Zeichen über write_to_terminal).

4. TERMINAL-STATUS ERKENNEN: Du erkennst ob ein Terminal idle ist, ob ein Build läuft, ob ein Fehler aufgetreten ist, ob ein AI-Agent auf Input wartet.

${p.proactive ? `5. PROAKTIV HANDELN: Du denkst mit. Wenn was schiefläuft, sagst du Bescheid. Wenn was auffällt, erwähnst du es. Du schlägst Aktionen vor und führst sie auf Wunsch aus.` : ''}

WICHTIG: Sag NIEMALS "Ich habe keinen Zugriff" oder "Ich kann keine Befehle ausführen" — du KANNST es. Nutze die Tools.

## Antwort-Format
Antworte natürlich und menschlich. Wenn du einen Befehl ausführst, sag kurz was du tust.`;

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
  private outputBuffers = new Map<string, { data: string; lastUpdated: number }>();
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
  private onThinking: ThinkingCallback | null = null;
  private onStreamChunk: StreamChunkCallback | null = null;
  private onStreamEnd: StreamEndCallback | null = null;

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
    onThinking?: ThinkingCallback,
    onStreamChunk?: StreamChunkCallback,
    onStreamEnd?: StreamEndCallback,
  ): void {
    this.onSummary = onSummary;
    this.onResponse = onResponse;
    this.onError = onError;
    if (onPersonalityConfigured) this.onPersonalityConfigured = onPersonalityConfigured;
    if (onThinking) this.onThinking = onThinking;
    if (onStreamChunk) this.onStreamChunk = onStreamChunk;
    if (onStreamEnd) this.onStreamEnd = onStreamEnd;
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

    const existing = this.outputBuffers.get(sessionId);
    const existingData = existing?.data ?? '';
    const combined = existingData + clean;

    // Cap buffer size — keep tail
    let finalData: string;
    if (combined.length > OUTPUT_BUFFER_MAX) {
      const sliced = combined.slice(combined.length - OUTPUT_BUFFER_MAX);
      const firstNl = sliced.indexOf('\n');
      finalData = firstNl >= 0 ? sliced.slice(firstNl + 1) : sliced;
    } else {
      finalData = combined;
    }

    this.outputBuffers.set(sessionId, { data: finalData, lastUpdated: Date.now() });
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

  /** Refresh session labels with current CWD from all active PTY processes. */
  async refreshLabels(): Promise<void> {
    for (const [sessionId, label] of this.sessionLabels) {
      const session = globalManager.getSession?.(sessionId);
      if (!session) continue;
      const shellMatch = label.match(/^Shell (\d+)/);
      if (!shellMatch) continue;
      const shellNum = parseInt(shellMatch[1]);
      try {
        const cwd = await readProcessCwd(session.pty.pid);
        if (cwd) {
          const folder = cwd.split('/').filter(Boolean).pop() ?? '';
          if (folder) {
            const newLabel = `Shell ${shellNum} · ${folder}`;
            if (newLabel !== label) {
              this.sessionLabels.set(sessionId, newLabel);
              logger.info(`Manager: label updated — ${label} → ${newLabel}`);
            }
          }
        }
      } catch {
        // process may have exited
      }
    }
  }

  // ── Periodic Summarization ────────────────────────────────────────────────

  /** Build structured context for all active sessions. */
  private buildTerminalContexts(): TerminalContext[] {
    const contexts: TerminalContext[] = [];
    const now = Date.now();
    for (const [sessionId, buf] of this.outputBuffers) {
      const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const isStale = (now - buf.lastUpdated) > 60_000;
      const analysis = analyzeTerminalOutput(buf.data);
      const session = globalManager.getSession?.(sessionId);

      // Override status to idle if buffer is stale
      const status = isStale ? 'idle' : analysis.status;

      contexts.push({
        sessionId,
        label,
        cwd: session?.cwd,
        process: session?.processName,
        project: analysis.project,
        tool: analysis.tool,
        status,
        recentOutput: buf.data.length > MAX_CONTEXT_PER_SESSION
          ? '...' + buf.data.slice(-MAX_CONTEXT_PER_SESSION)
          : buf.data,
      });
    }
    return contexts;
  }

  /** Format terminal contexts into a structured overview for the AI. */
  private formatContextBlock(contexts: TerminalContext[]): string {
    let block = '## Terminal-Übersicht\n\n';
    const now = Date.now();
    for (const ctx of contexts) {
      const emoji = STATUS_EMOJI[ctx.status];
      const statusLabel = STATUS_LABEL[ctx.status];
      const buf = this.outputBuffers.get(ctx.sessionId);
      const staleSecs = buf ? Math.round((now - buf.lastUpdated) / 1000) : 0;
      const staleNote = staleSecs > 60 ? ` ⏳ Letzter Output vor ${staleSecs}s — wahrscheinlich idle` : '';
      block += `### ${emoji} ${ctx.label} — ${statusLabel}${staleNote}\n`;
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
        this.outputBuffers.set(s.sessionId, { data: '', lastUpdated: Date.now() });
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

  /** Resolve a terminal label like "Shell 2", "ayysir", or "Shell 2 · ayysir" to a sessionId. */
  private resolveLabel(label: string): string | null {
    const lower = label.toLowerCase();
    // Exact match
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase() === lower) return id;
    }
    // Starts-with match (e.g. "Shell 1" matches "Shell 1 · ayysir")
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase().startsWith(lower)) return id;
    }
    // Contains match (e.g. "ayysir" matches "Shell 1 · ayysir")
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase().includes(lower)) return id;
    }
    // Normalized match (e.g. "Shell2" without space)
    const normalized = label.replace(/\s+/g, '').toLowerCase();
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.replace(/\s+/g, '').toLowerCase().includes(normalized)) return id;
    }
    logger.warn(`Manager: could not resolve label "${label}"`);
    return null;
  }

  /** Convert native tool calls to ManagerActions. */
  private toolCallsToActions(toolCalls: Array<{ name: string; arguments: Record<string, string> }>): ManagerAction[] {
    logger.info(`Manager: processing ${toolCalls.length} tool calls, known labels: ${[...this.sessionLabels.entries()].map(([id, l]) => `${l}=${id.slice(0, 8)}`).join(', ') || 'none'}`);
    const actions: ManagerAction[] = [];
    for (const tc of toolCalls) {
      logger.info(`Manager: tool call: ${tc.name}(${JSON.stringify(tc.arguments)})`);
      const label = tc.arguments.session_label;
      const sessionId = label ? this.resolveLabel(label) : null;
      if (!sessionId) {
        logger.warn(`Manager: tool call ${tc.name} — could not resolve label "${label}"`);
        continue;
      }
      if (tc.name === 'write_to_terminal') {
        actions.push({ type: 'write_to_terminal', sessionId, detail: tc.arguments.command ?? '' });
      } else if (tc.name === 'send_enter') {
        actions.push({ type: 'send_enter', sessionId, detail: '' });
      }
    }
    return actions;
  }

  private emitThinking(phase: string, startTime: number, detail?: string): void {
    const elapsed = Date.now() - startTime;
    this.onThinking?.(phase, detail, elapsed);
  }

  async handleChat(text: string, targetSessionId?: string, onboarding?: boolean): Promise<void> {
    if (!this.enabled) {
      throw new Error('Manager ist nicht aktiv — bitte zuerst aktivieren (grüner Punkt)');
    }


    // Refresh labels with current CWD before processing
    await this.refreshLabels();

    const startTime = Date.now();
    const phases: PhaseInfo[] = [];
    let phaseStart = startTime;

    const recordPhase = (phase: string, label: string) => {
      const now = Date.now();
      if (phases.length > 0) {
        phases[phases.length - 1].duration = now - phaseStart;
      }
      phases.push({ phase, label, duration: 0 });
      phaseStart = now;
      this.emitThinking(phase, startTime);
    };

    // Phase 1: Analyze terminals
    recordPhase('analyzing_terminals', 'Terminals analysieren');

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
    this.chatHistory.push({ role: 'user', content: text });

    // Phase 2: Build context
    recordPhase('building_context', 'Kontext vorbereiten');

    this.memory = loadMemory();
    const memoryIsEmpty = this.memory.user.learnedFacts.length === 0 && !this.memory.user.name;
    const isOnboarding = onboarding && memoryIsEmpty;
    const basePrompt = onboarding ? ONBOARDING_PROMPT : buildSystemPrompt(this.personality);
    const memoryContext = buildMemoryContext(this.memory);
    const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;

    // Phase 3: Call AI
    recordPhase('calling_ai', 'Sende an AI');

    try {
      const provider = this.registry.getActive();
      const glm = this.registry.getActiveAsGlm();
      logger.info(`Manager: streaming chat via ${provider.name}${glm ? ' (with tools)' : ''}`);

      // Phase 4: Streaming
      recordPhase('streaming', 'Schreibt');

      let reply: string;
      let nativeToolCalls: Array<{ name: string; arguments: Record<string, string> }> = [];

      if (glm) {
        // GLM: use native tool calling
        const result = await glm.chatStreamWithTools(
          [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
          systemPrompt,
          MANAGER_TOOLS,
          (token) => this.onStreamChunk?.(token),
        );
        reply = result.text;
        nativeToolCalls = result.toolCalls;
      } else {
        // Kimi: text-only streaming (tags parsed later)
        reply = await provider.chatStream(
          [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
          systemPrompt,
          (token) => this.onStreamChunk?.(token),
        );
      }

      // Close last phase duration
      phases[phases.length - 1].duration = Date.now() - phaseStart;

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

      // Collect actions: native tool calls (GLM) + regex fallback (tags in text)
      const nativeActions = this.toolCallsToActions(nativeToolCalls);
      const tagActions = this.parseActions(reply);
      const actions = [...nativeActions, ...tagActions];

      // Phase 5: Execute actions (only if there are any)
      if (actions.length > 0) {
        phaseStart = Date.now();
        recordPhase('executing_actions', 'Befehle ausführen');
        for (const action of actions) {
          this.executeAction(action);
        }
        phases[phases.length - 1].duration = Date.now() - phaseStart;
      }

      // Clean reply
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

      let finalText = cleanReply;
      if (!finalText) {
        if (parsedConfig) {
          finalText = `${parsedConfig.agentName} ist eingerichtet und bereit.`;
        } else if (actions.length > 0) {
          // Auto-generate confirmation for tool-call-only responses
          const summaries = actions.map(a => {
            const lbl = this.sessionLabels.get(a.sessionId) ?? a.sessionId.slice(0, 8);
            return a.type === 'write_to_terminal'
              ? `\`${a.detail}\` in ${lbl}`
              : `Enter in ${lbl}`;
          });
          finalText = `Ausgeführt: ${summaries.join(', ')}`;
        } else {
          finalText = 'Verstanden — ich habe mir alles gemerkt.';
        }
      }

      // Send stream end with phases
      this.onStreamEnd?.(finalText, actions, phases);
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
        logger.info(`Manager: writing to ${label} (${action.sessionId.slice(0, 8)}): "${action.detail.slice(0, 50)}"`);
        const ok = globalManager.write(action.sessionId, action.detail);
        if (!ok) {
          logger.warn(`Manager: write FAILED — session ${action.sessionId.slice(0, 8)} not found in TerminalManager`);
          logger.warn(`Manager: known labels: ${[...this.sessionLabels.entries()].map(([id, l]) => `${l}=${id.slice(0, 8)}`).join(', ') || 'none'}`);
        }
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
