import { AiProviderRegistry, ChatMessage, ProviderConfig } from './ai-provider';
import { globalManager } from '../terminal/terminal.manager';
import { logger } from '../utils/logger';

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

// ── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du bist der TMS Terminal Manager — ein hilfreicher Assistent, der mehrere Terminal-Sessions überwacht.

Deine Aufgaben:
1. Fasse Terminal-Aktivitäten verständlich zusammen (auf Deutsch)
2. Beantworte Fragen des Nutzers zu den Terminals
3. Führe Anweisungen aus, wenn der Nutzer es wünscht

Wenn der Nutzer möchte, dass du in ein Terminal schreibst, antworte mit einer Aktion im Format:
[WRITE_TO:<sessionId>]<command>[/WRITE_TO]

Beispiel: [WRITE_TO:abc123]npm run build[/WRITE_TO]

Wenn du Enter drücken sollst nach dem Schreiben, füge hinzu:
[SEND_ENTER:<sessionId>]

Halte deine Zusammenfassungen kurz und prägnant. Verwende Terminal-Labels (z.B. "Shell 1") statt roher Session-IDs.`;

// ── Manager Service ─────────────────────────────────────────────────────────

export class ManagerService {
  private registry: AiProviderRegistry;
  private outputBuffers = new Map<string, string>();
  private lastSummaryAt = new Map<string, number>(); // per-session timestamp
  private sessionLabels = new Map<string, string>(); // sessionId -> "Shell 1"
  private chatHistory: ChatMessage[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private enabled = false;

  // Callbacks wired by ws.handler
  private onSummary: SummaryCallback | null = null;
  private onResponse: ResponseCallback | null = null;
  private onError: ErrorCallback | null = null;

  constructor(providerConfig: ProviderConfig) {
    this.registry = new AiProviderRegistry(providerConfig);
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  setCallbacks(onSummary: SummaryCallback, onResponse: ResponseCallback, onError: ErrorCallback): void {
    this.onSummary = onSummary;
    this.onResponse = onResponse;
    this.onError = onError;
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

  /** Trigger a summary now (also called by the 15-min timer). */
  async poll(): Promise<void> {
    if (!this.enabled) return;

    const sessionsWithActivity: Array<{ sessionId: string; label: string; output: string }> = [];

    for (const [sessionId, buffer] of this.outputBuffers) {
      const lastSummary = this.lastSummaryAt.get(sessionId) ?? 0;
      // Only include sessions with new output since last summary
      if (buffer.length > 0) {
        const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
        // Truncate to MAX_CONTEXT_PER_SESSION for the AI
        const output = buffer.length > MAX_CONTEXT_PER_SESSION
          ? '...' + buffer.slice(-MAX_CONTEXT_PER_SESSION)
          : buffer;
        sessionsWithActivity.push({ sessionId, label, output });
      }
    }

    if (sessionsWithActivity.length === 0) {
      logger.info('Manager: no activity since last poll — skipping');
      return;
    }

    // Build prompt
    let prompt = 'Hier ist die Terminal-Aktivität der letzten 15 Minuten:\n\n';
    for (const s of sessionsWithActivity) {
      prompt += `── ${s.label} (${s.sessionId.slice(0, 8)}) ──\n${s.output}\n\n`;
    }
    prompt += 'Fasse die Aktivität kurz und verständlich zusammen. Was wurde gemacht? Gibt es offene Fragen oder wartende Prompts?';

    try {
      const provider = this.registry.getActive();
      logger.info(`Manager: summarizing ${sessionsWithActivity.length} sessions via ${provider.name}`);

      const reply = await provider.chat(
        [{ role: 'user', content: prompt }],
        SYSTEM_PROMPT,
      );

      // Mark as summarized and clear buffers
      const now = Date.now();
      const sessionInfo = sessionsWithActivity.map(s => ({
        sessionId: s.sessionId,
        label: s.label,
        hasActivity: true,
      }));

      for (const s of sessionsWithActivity) {
        this.lastSummaryAt.set(s.sessionId, now);
        this.outputBuffers.set(s.sessionId, ''); // clear after summary
      }

      // Add to chat history
      this.chatHistory.push({ role: 'assistant', content: reply });
      // Cap chat history
      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-40);
      }

      const summary: ManagerSummary = {
        text: reply,
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

  async handleChat(text: string, targetSessionId?: string): Promise<void> {
    if (!this.enabled) {
      this.onError?.('Manager ist nicht aktiv');
      return;
    }

    // Build context: include recent output from target session (or all)
    let context = '';
    if (targetSessionId) {
      const buffer = this.outputBuffers.get(targetSessionId);
      const label = this.sessionLabels.get(targetSessionId) ?? targetSessionId.slice(0, 8);
      if (buffer) {
        const snippet = buffer.length > MAX_CONTEXT_PER_SESSION
          ? '...' + buffer.slice(-MAX_CONTEXT_PER_SESSION)
          : buffer;
        context = `\n\nAktueller Output von ${label} (${targetSessionId.slice(0, 8)}):\n${snippet}`;
      }
    } else {
      // Include brief context from all sessions
      for (const [sid, buffer] of this.outputBuffers) {
        if (!buffer) continue;
        const label = this.sessionLabels.get(sid) ?? sid.slice(0, 8);
        const snippet = buffer.length > 2000 ? '...' + buffer.slice(-2000) : buffer;
        context += `\n── ${label} ──\n${snippet}\n`;
      }
    }

    // Add available sessions list
    const sessionList = [...this.sessionLabels.entries()]
      .map(([id, label]) => `${label} (${id.slice(0, 8)})`)
      .join(', ');
    const sessionsInfo = sessionList ? `\n\nVerfügbare Terminals: ${sessionList}` : '';

    const userMessage = text + context + sessionsInfo;

    this.chatHistory.push({ role: 'user', content: text }); // store clean version

    try {
      const provider = this.registry.getActive();
      const reply = await provider.chat(
        [...this.chatHistory, { role: 'user', content: userMessage }],
        SYSTEM_PROMPT,
      );

      // Parse actions from reply
      const actions = this.parseActions(reply);

      // Execute actions
      for (const action of actions) {
        this.executeAction(action);
      }

      // Clean reply — remove action tags for display
      const cleanReply = reply
        .replace(/\[WRITE_TO:[^\]]+\][^[]*\[\/WRITE_TO\]/g, '')
        .replace(/\[SEND_ENTER:[^\]]+\]/g, '')
        .trim();

      this.chatHistory.push({ role: 'assistant', content: cleanReply });
      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-40);
      }

      this.onResponse?.({ text: cleanReply, actions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: chat failed — ${msg}`);
      this.onError?.(`Fehler: ${msg}`);
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
