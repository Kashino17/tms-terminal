import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { globalManager } from '../terminal/terminal.manager';
import { promptDetector } from '../notifications/prompt.detector';
import { idleDetector } from '../notifications/idle.detector';
import { fcmService } from '../notifications/fcm.service';
import { watcherService } from '../watchers/watcher.service';
import { getProcessSnapshot, killProcess } from '../system/process.monitor';
import { logger } from '../utils/logger';
import { autopilotService } from '../autopilot/autopilot.service';
import { transcribe as whisperTranscribe } from '../audio/whisper-sidecar';
import { synthesize as ttsSynthesize, isAvailable as ttsAvailable } from '../audio/tts-sidecar';
import { ManagerService } from '../manager/manager.service';
import { loadManagerConfig, saveManagerConfig } from '../manager/manager.config';
import { ConnectionRateLimiter } from './rate-limiter';
import { ChromeManager } from '../chrome/chrome.manager';

// Wire up the detach feed callback so the prompt detector keeps receiving
// data even when sessions are detached (client backgrounded/disconnected).
// This enables server-side auto-approve. The idle detector also needs activity
// signals so idle notifications work while the client is away.
globalManager.detachFeedCallback = (sessionId, data) => {
  promptDetector.feed(sessionId, data);
  idleDetector.activity(sessionId);
};

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length < 50;
}

const VALID_WATCHER_TYPES = ['file', 'process', 'keyword'] as const;

// Last known FCM tokens — persists across client reconnects so that
// prompt notifications can still be sent even if the client briefly disconnects.
const MAX_PERSISTED_TOKENS = 10;
const persistedTokens: Set<string> = new Set();

// Server-side auto-approve state — persists across reconnects.
// When enabled for a session, the server sends '\r' directly to the PTY on prompt detection,
// even when the client is disconnected/backgrounded.
const serverAutoApprove = new Map<string, boolean>();

// Track last user input per session — auto-approve pauses while user is typing.
// Updated on every terminal:input message from the client.
const lastUserInputAt = new Map<string, number>();
const TYPING_PAUSE_MS = 2000;

// Track how many characters the user has on the current input line.
// Auto-approve is blocked if pendingInputLen > 0 (user has unsent text).
const pendingInputLen = new Map<string, number>();

// ── Manager Agent ────────────────────────────────────────────────────
export const managerService = new ManagerService(loadManagerConfig());

// Save manager state on graceful shutdown (before process exits)
process.on('SIGINT', () => managerService.saveStateOnShutdown());
process.on('SIGTERM', () => managerService.saveStateOnShutdown());

// Mutable reference to the current WebSocket connection.
// Manager callbacks use this instead of the closure-captured `ws` so that
// responses are always sent to the CURRENT client, not a stale dead socket.
let currentWs: WebSocket | null = null;
// Buffer for manager messages sent while the client is disconnected.
// Flushed on reconnect.
const pendingManagerMessages: Array<Record<string, unknown>> = [];

const MAX_PENDING_MANAGER_MESSAGES = 100;

function sendManager(msg: Record<string, unknown>): void {
  if (currentWs && currentWs.readyState === currentWs.OPEN) {
    currentWs.send(JSON.stringify(msg));
  } else {
    // Client disconnected — buffer the message for delivery on reconnect
    pendingManagerMessages.push(msg);
    // Cap buffer to prevent unbounded growth during long disconnects
    if (pendingManagerMessages.length > MAX_PENDING_MANAGER_MESSAGES) {
      const dropped = pendingManagerMessages.length - MAX_PENDING_MANAGER_MESSAGES;
      pendingManagerMessages.splice(0, dropped);
      logger.info(`Manager: dropped ${dropped} old buffered messages (cap=${MAX_PENDING_MANAGER_MESSAGES})`);
    }
    logger.info(`Manager: buffered message (type=${msg.type}, queue=${pendingManagerMessages.length})`);
  }
}

function flushPendingManagerMessages(ws: WebSocket): void {
  if (pendingManagerMessages.length === 0) return;
  logger.info(`Manager: flushing ${pendingManagerMessages.length} buffered messages`);
  while (pendingManagerMessages.length > 0) {
    const msg = pendingManagerMessages.shift()!;
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

function setupManagerCallbacks(ws: WebSocket): void {
  managerService.setCallbacks(
    (summary) => sendManager({ type: 'manager:summary', payload: summary }),
    (response) => sendManager({ type: 'manager:response', payload: response }),
    (error) => sendManager({ type: 'manager:error', payload: { message: error } }),
    (config) => sendManager({ type: 'manager:personality_configured', payload: config }),
    (phase, detail, elapsed) => sendManager({ type: 'manager:thinking', payload: { phase, detail, elapsed } }),
    (token, tokenStats) => sendManager({ type: 'manager:stream_chunk', payload: { token, ...tokenStats } }),
    (text, actions, phases, images, presentations) => sendManager({ type: 'manager:stream_end', payload: { text, actions, phases, images, presentations } }),
    createTerminalForManager,
    closeTerminalForManager,
    (tasks) => sendManager({ type: 'manager:tasks', payload: { tasks } }),
  );
}

// These need to be module-level so setupManagerCallbacks can reference them
// They're assigned inside handleConnection when ws is available
let createTerminalForManager: (label?: string) => string | null = () => null;
let closeTerminalForManager: (sessionId: string) => boolean = () => false;

// ── Autopilot state ──────────────────────────────────────────────────
const aiSessions = new Set<string>(); // sessions where AI tool was detected
const autopilotTimers = new Map<string, NodeJS.Timeout>();
const AUTOPILOT_IDLE_MS = 60_000; // 1 minute idle before sending next prompt

/** Update pending input tracking from raw terminal input data */
function trackPendingInput(sessionId: string, data: string): void {
  let len = pendingInputLen.get(sessionId) ?? 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x0D || c === 0x0A) {        // Enter — line submitted
      len = 0;
    } else if (c === 0x03 || c === 0x15) { // Ctrl+C / Ctrl+U — line cancelled/cleared
      len = 0;
    } else if (c === 0x7F || c === 0x08) { // Backspace / BS
      len = Math.max(0, len - 1);
    } else if (c === 0x1B) {               // Escape sequence (arrow keys etc.) — skip
      if (i + 1 < data.length) {
        const next = data.charCodeAt(i + 1);
        if (next === 0x5B || next === 0x4F) { // CSI [ or SS3 O
          i += 2;
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x3F) i++;
        } else {
          i++; // Alt+key
        }
      }
    } else if (c >= 0x20) {               // Printable character
      len++;
    }
  }
  pendingInputLen.set(sessionId, len);
}

export function handleConnection(ws: WebSocket, ip: string): void {
  // Track which sessions this connection owns (for detach on disconnect)
  const ownedSessions = new Set<string>();
  const chromeManager = new ChromeManager();
  // Track attach generation per session — passed to detachSession to prevent stale detach
  const sessionGens = new Map<string, number>();
  // Use the persisted tokens as the starting value; overwritten on register
  let deviceToken: string | null = persistedTokens.size > 0 ? [...persistedTokens][0] : null;

  // Per-connection rate limiter
  const rateLimiter = new ConnectionRateLimiter();

  logger.success(`Client connected: ${ip}`);

  // Update the mutable WS reference so manager callbacks always use the current connection
  currentWs = ws;

  // Flush any manager messages that were buffered while disconnected
  flushPendingManagerMessages(ws);

  /** Register a session with the prompt detector for auto-approve (no FCM — idle detector handles that). */
  const watchSession = (sessionId: string): void => {
    promptDetector.watch(sessionId, (snippet) => {
      // Server-side auto-approve: if enabled, send Enter directly to PTY
      // This works even when the client is backgrounded/disconnected
      if (serverAutoApprove.get(sessionId)) {
        const hasPending = (pendingInputLen.get(sessionId) ?? 0) > 0;
        const isTyping = (Date.now() - (lastUserInputAt.get(sessionId) ?? 0)) < TYPING_PAUSE_MS;

        if (hasPending) {
          logger.info(`Auto-approve: BLOCKED for session ${sessionId.slice(0, 8)} (unsent text on line)`);
          // Fall through — notify client with hasPendingInput flag
        } else if (isTyping) {
          logger.info(`Auto-approve: PAUSED for session ${sessionId.slice(0, 8)} (user typing)`);
          // Fall through to send prompt notification to client instead
        } else {
          logger.info(`Auto-approve: sending Enter for session ${sessionId.slice(0, 8)}`);
          globalManager.write(sessionId, '\r');
          return; // No WS notification needed
        }
      }

      // Send in-app badge notification via WebSocket (for auto-approve UI badge)
      const pendingFlag = (pendingInputLen.get(sessionId) ?? 0) > 0;
      send(ws, { type: 'terminal:prompt_detected', sessionId, payload: { snippet, hasPendingInput: pendingFlag } });
    });
  };

  /** Register a session with the idle detector for FCM push notifications. */
  const watchSessionIdle = (sessionId: string): void => {
    idleDetector.watch(sessionId, (idleSecs) => {
      if (persistedTokens.size === 0) { logger.warn('Idle: notification skipped — no FCM token'); return; }

      const hostname = require('os').hostname().replace(/\.local$/, '');
      const sessionNum = [...ownedSessions].indexOf(sessionId) + 1;
      const tabLabel = sessionNum > 0 ? `Shell ${sessionNum}` : 'Terminal';
      const title = `\u{1F4A4} ${hostname} \u{00B7} ${tabLabel}`;
      const body = `Terminal seit ${idleSecs}s inaktiv`;

      logger.info(`Idle: sending FCM — "${title}" — "${body}"`);
      const promises: Promise<void>[] = [];
      for (const token of persistedTokens) {
        promises.push(
          fcmService.send(token, title, body, { sessionId, type: 'idle' })
            .catch(() => { persistedTokens.delete(token); }),
        );
      }
      void Promise.allSettled(promises);
    });
  };

  /** Create a new terminal session on behalf of the Manager Agent. */
  createTerminalForManager = (label?: string): string | null => {
    try {
      const cols = 80;
      const rows = 24;
      const session = globalManager.createSession(
        { cols, rows },
        (sessionId, data) => {
          send(ws, { type: 'terminal:output', sessionId, payload: { data } });
          promptDetector.feed(sessionId, data);
          idleDetector.activity(sessionId);
          resetAutopilotTimer(sessionId);
          managerService.feedOutput(sessionId, data);
        },
        (sessionId, exitCode) => {
          ownedSessions.delete(sessionId);
          promptDetector.unwatch(sessionId);
          idleDetector.unwatch(sessionId);
          aiSessions.delete(sessionId);
          send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode } });
        },
      );
      ownedSessions.add(session.id);
      sessionGens.set(session.id, globalManager.getAttachGen(session.id));
      watchSession(session.id);
      watchSessionIdle(session.id);

      const shellNum = ownedSessions.size;
      const sessionLabel = label || `Shell ${shellNum}`;
      managerService.setSessionLabel(session.id, sessionLabel);

      // Notify the client about the new session
      send(ws, {
        type: 'terminal:created',
        sessionId: session.id,
        payload: { cols: session.cols, rows: session.rows, fromManager: true, label: sessionLabel },
      } as any);

      logger.info(`Manager: created terminal "${sessionLabel}" (${session.id.slice(0, 8)})`);
      return session.id;
    } catch (err) {
      logger.warn(`Manager: failed to create terminal — ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };

  /** Close a terminal session on behalf of the Manager Agent. */
  closeTerminalForManager = (sessionId: string): boolean => {
    try {
      if (!ownedSessions.has(sessionId)) {
        logger.warn(`Manager: cannot close session ${sessionId.slice(0, 8)} — not owned by this connection`);
        return false;
      }
      globalManager.closeSession(sessionId);
      ownedSessions.delete(sessionId);
      promptDetector.unwatch(sessionId);
      idleDetector.unwatch(sessionId);
      aiSessions.delete(sessionId);
      send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode: 0 } });
      logger.info(`Manager: closed terminal ${sessionId.slice(0, 8)}`);
      return true;
    } catch (err) {
      logger.warn(`Manager: failed to close terminal — ${err instanceof Error ? err.message : err}`);
      return false;
    }
  };

  /** Reset the autopilot idle timer for a session. Fires after AUTOPILOT_IDLE_MS of inactivity. */
  const resetAutopilotTimer = (sessionId: string): void => {
    const existing = autopilotTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      autopilotTimers.delete(sessionId);
      if (!aiSessions.has(sessionId)) return;
      if (!autopilotService.isEnabled(sessionId)) return;

      // If there's a running item, mark it done (terminal went idle = prompt finished)
      autopilotService.markCurrentDone(sessionId);

      // Try next prompt
      const result = autopilotService.tryDequeuePrompt(sessionId);
      if (result) {
        // Write prompt text first, then send Enter separately after a short delay.
        // If sent together, the terminal treats it as a paste block and doesn't execute.
        const flatPrompt = result.prompt.replace(/[\r\n]+/g, ' ').trim();
        globalManager.write(sessionId, flatPrompt);
        setTimeout(() => globalManager.write(sessionId, '\r'), 200);
      }
    }, AUTOPILOT_IDLE_MS);
    timer.unref();
    autopilotTimers.set(sessionId, timer);
  };

  // Set up autopilot callbacks for WebSocket notifications
  autopilotService.setCallbacks(
    (sid, itemId) => send(ws, { type: 'autopilot:prompt_sent', sessionId: sid, payload: { id: itemId } } as any),
    (sid, itemId) => send(ws, { type: 'autopilot:prompt_done', sessionId: sid, payload: { id: itemId } } as any),
  );

  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn(`Invalid JSON from ${ip}`);
      return;
    }

    // Handle extension message types not in shared/protocol.ts
    const msgType = (msg as any).type as string;

    // ── Rate limiting ────────────────────────────────────────────────
    if (!rateLimiter.consume(msgType)) {
      if (rateLimiter.isBlocked()) {
        send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Rate limit exceeded — connection temporarily blocked' } });
      }
      return;
    }

    if (msgType === 'client:backgrounding') {
      logger.info(`Client backgrounding — detaching all sessions (${ownedSessions.size} sessions)`);
      for (const sessionId of ownedSessions) {
        const gen = sessionGens.get(sessionId);
        globalManager.detachSession(sessionId, gen);
      }
      // Do NOT close the WebSocket — the client will close it from their side
      return;
    }

    if (msgType === 'client:set_ai_session') {
      const sid = (msg as any).sessionId;
      const hasAi = !!(msg as any).payload?.hasAi;
      if (typeof sid === 'string') {
        if (hasAi) aiSessions.add(sid);
        else aiSessions.delete(sid);
        logger.info(`AI session ${hasAi ? 'registered' : 'unregistered'}: ${sid.slice(0, 8)}`);
      }
      return;
    }

    if (msgType === 'client:set_auto_approve') {
      const sid = (msg as any).sessionId;
      const enabled = !!(msg as any).payload?.enabled;
      if (typeof sid === 'string') {
        serverAutoApprove.set(sid, enabled);
        // Track AI sessions for autopilot — auto-approve is only used on AI terminals
        if (enabled) aiSessions.add(sid);
        else aiSessions.delete(sid);
        logger.info(`Auto-approve ${enabled ? 'enabled' : 'disabled'} for session ${sid.slice(0, 8)}`);
      }
      return;
    }

    if (msgType === 'client:rtt') {
      const rtt = (msg as any).payload?.rtt;
      if (typeof rtt === 'number' && rtt > 0 && rtt < 30000) {
        for (const sessionId of ownedSessions) {
          globalManager.setSessionRtt(sessionId, rtt);
        }
      }
      return;
    }

    if (msgType === 'client:set_idle_threshold') {
      const seconds = (msg as any).payload?.seconds;
      if (typeof seconds === 'number' && seconds >= 0) {
        if (seconds === 0) {
          // Disabled — unwatch all sessions from idle detector
          for (const sessionId of ownedSessions) {
            idleDetector.unwatch(sessionId);
          }
          logger.info('Idle notifications disabled by client');
        } else {
          idleDetector.setDefaultThreshold(seconds * 1000);
          // Re-arm all current sessions with the new threshold
          for (const sessionId of ownedSessions) {
            idleDetector.setThreshold(sessionId, seconds * 1000);
            idleDetector.activity(sessionId); // restart timer with new threshold
          }
          logger.info(`Idle threshold set to ${seconds}s`);
        }
      }
      return;
    }

    // ── Autopilot message handlers ───────────────────────────────────
    if (msgType === 'autopilot:optimize') {
      const { items, cwd } = (msg as any).payload ?? {};
      const sessionId = (msg as any).sessionId;
      if (!Array.isArray(items) || !cwd || !sessionId) return;

      // Mark items as optimizing
      for (const item of items) {
        autopilotService.updateItem(sessionId, item.id, { status: 'optimizing' });
      }

      // Run optimization (async, results sent back one by one)
      autopilotService.optimizeItems(items, cwd, (id, result) => {
        if (result.prompt) {
          autopilotService.updateItem(sessionId, id, {
            optimizedPrompt: result.prompt,
            status: 'queued',
          });
          send(ws, { type: 'autopilot:optimized', sessionId, payload: { id, optimizedPrompt: result.prompt } } as any);
        } else {
          autopilotService.updateItem(sessionId, id, { status: 'error', error: result.error });
          send(ws, { type: 'autopilot:optimize_error', sessionId, payload: { id, error: result.error } } as any);
        }
      });
      return;
    }

    if (msgType === 'autopilot:add_item') {
      const sessionId = (msg as any).sessionId;
      const item = (msg as any).payload;
      if (sessionId && item?.id && item?.text) {
        autopilotService.addItem(sessionId, {
          id: item.id,
          text: item.text,
          status: item.status ?? 'draft',
          optimizedPrompt: item.optimizedPrompt,
        });
      }
      return;
    }

    if (msgType === 'autopilot:remove_item') {
      const sessionId = (msg as any).sessionId;
      const itemId = (msg as any).payload?.id;
      if (sessionId && itemId) {
        autopilotService.removeItem(sessionId, itemId);
      }
      return;
    }

    if (msgType === 'autopilot:update_item') {
      const sessionId = (msg as any).sessionId;
      const { id, ...updates } = (msg as any).payload ?? {};
      if (sessionId && id) {
        autopilotService.updateItem(sessionId, id, updates);
      }
      return;
    }

    if (msgType === 'autopilot:reorder') {
      const sessionId = (msg as any).sessionId;
      const itemIds = (msg as any).payload?.itemIds;
      if (sessionId && Array.isArray(itemIds)) {
        autopilotService.reorderQueue(sessionId, itemIds);
      }
      return;
    }

    if (msgType === 'autopilot:queue_toggle') {
      const sessionId = (msg as any).sessionId;
      const enabled = !!(msg as any).payload?.enabled;
      if (sessionId) {
        autopilotService.setEnabled(sessionId, enabled);
        logger.info(`Autopilot queue ${enabled ? 'enabled' : 'disabled'} for ${sessionId.slice(0, 8)}`);
      }
      return;
    }

    // ── Manager Agent message handlers ────────────────────────────────
    if (msgType === 'manager:toggle') {
      const enabled = !!(msg as any).payload?.enabled;
      if (enabled) {
        setupManagerCallbacks(ws);
        managerService.start();
      } else {
        managerService.stop();
      }
      send(ws, { type: 'manager:status', payload: { enabled } } as any);
      // Also send provider list on toggle
      send(ws, { type: 'manager:providers', payload: managerService.getProviders() } as any);
      return;
    }

    if (msgType === 'manager:chat') {
      // Ensure callbacks are set on every chat (survives server restarts + reconnects)
      setupManagerCallbacks(ws);
      if (!managerService.isEnabled()) managerService.start();

      const text = (msg as any).payload?.text;
      const targetSessionId = (msg as any).payload?.targetSessionId;
      const onboarding = !!(msg as any).payload?.onboarding;
      if (typeof text === 'string' && text.length > 0) {
        managerService.handleChat(text, targetSessionId, onboarding).catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          send(ws, { type: 'manager:error', payload: { message: errMsg } } as any);
        });
      }
      return;
    }

    if (msgType === 'manager:cancel') {
      managerService.cancelCurrentRequest();
      send(ws, { type: 'manager:stream_end', payload: { text: '⛔ Abgebrochen.', actions: [], phases: [] } } as any);
      return;
    }

    if (msgType === 'manager:poll') {
      setupManagerCallbacks(ws);
      if (!managerService.isEnabled()) managerService.start();
      const pollTarget = (msg as any).payload?.targetSessionId;
      managerService.poll(pollTarget, true).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        send(ws, { type: 'manager:error', payload: { message: errMsg } } as any);
      });
      return;
    }

    if (msgType === 'manager:set_provider') {
      const providerId = (msg as any).payload?.providerId;
      if (typeof providerId === 'string') {
        try {
          managerService.setProvider(providerId);
          send(ws, { type: 'manager:providers', payload: managerService.getProviders() } as any);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          send(ws, { type: 'manager:error', payload: { message: errMsg } } as any);
        }
      }
      return;
    }

    if (msgType === 'manager:set_personality') {
      const payload = (msg as any).payload;
      if (payload && typeof payload === 'object') {
        managerService.setPersonality(payload);
      }
      return;
    }

    if (msgType === 'manager:set_api_key') {
      const { providerId, apiKey } = (msg as any).payload ?? {};
      if (typeof providerId === 'string' && typeof apiKey === 'string') {
        const updates: Record<string, string> = {};
        if (providerId === 'kimi') updates.kimiApiKey = apiKey;
        else if (providerId === 'glm') updates.glmApiKey = apiKey;
        else if (providerId === 'openai') updates.openaiApiKey = apiKey;
        managerService.updateProviderConfig(updates);
        saveManagerConfig(updates);
        send(ws, { type: 'manager:providers', payload: managerService.getProviders() } as any);
      }
      return;
    }

    // ── File Upload from mobile app ───────────────────────────────
    if (msgType === 'client:file_upload') {
      const { filename, data, mimeType } = (msg as any).payload ?? {};
      if (typeof filename === 'string' && typeof data === 'string') {
        try {
          const uploadDir = path.join(os.homedir(), '.tms-terminal', 'uploads');
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(uploadDir, `${Date.now()}_${safeName}`);
          fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
          logger.info(`File upload: ${safeName} (${mimeType}) → ${filePath}`);
          // Send file path to manager as a chat message
          managerService.handleChat(`[DATEI-UPLOAD] Der User hat eine Datei gesendet: ${filePath} (${mimeType || 'unbekannt'}, ${safeName}). Verarbeite sie entsprechend.`).catch(() => {});
          send(ws, { type: 'client:file_uploaded', payload: { path: filePath, filename: safeName } } as any);
        } catch (err) {
          logger.warn(`File upload failed: ${err}`);
        }
      }
      return;
    }

    // ── App State tracking ──────────────────────────────────────────
    if (msgType === 'client:app_state') {
      const { foreground } = (msg as any).payload ?? {};
      (managerService as any).appForeground = !!foreground;
      logger.info(`App state: ${foreground ? 'foreground' : 'background'}`);
      return;
    }
    if (msgType === 'client:active_tab') {
      const { tabId, sessionId: tabSessionId } = (msg as any).payload ?? {};
      (managerService as any).activeTabId = tabId;
      (managerService as any).activeSessionId = tabSessionId;
      return;
    }

    if (msgType === 'manager:sync_labels') {
      const labels = (msg as any).payload?.labels as Array<{ sessionId: string; name: string }> | undefined;
      if (Array.isArray(labels)) {
        // Clean up stale labels: remove any session labels not in the current sync
        const syncedIds = new Set(labels.map(l => l.sessionId));
        const currentList = managerService.getSessionList();
        for (const { sessionId } of currentList) {
          if (!syncedIds.has(sessionId) && !ownedSessions.has(sessionId)) {
            managerService.clearSession(sessionId);
          }
        }
        // Apply new labels
        for (const { sessionId, name } of labels) {
          if (typeof sessionId === 'string' && typeof name === 'string') {
            managerService.setSessionLabel(sessionId, name);
          }
        }
        logger.info(`Manager: synced ${labels.length} labels from client`);
      }
      return;
    }

    if (msgType === 'manager:memory_read') {
      const mem = require('../manager/manager.memory');
      send(ws, { type: 'manager:memory_data', payload: { memory: mem.loadMemory() } } as any);
      return;
    }

    if (msgType === 'manager:memory_write') {
      const { section, data } = (msg as any).payload ?? {};
      if (typeof section === 'string' && data !== undefined) {
        const mem = require('../manager/manager.memory');
        mem.updateMemorySection(section, data);
        send(ws, { type: 'manager:memory_data', payload: { memory: mem.loadMemory() } } as any);
      }
      return;
    }

    if (msgType === 'audio:transcribe') {
      const sessionId = (msg as any).sessionId;
      const audio = (msg as any).payload?.audio;
      const format = (msg as any).payload?.format;

      if (!isValidSessionId(sessionId)) {
        send(ws, { type: 'audio:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } } as any);
        return;
      }
      if (typeof audio !== 'string' || audio.length === 0) {
        send(ws, { type: 'audio:error', sessionId, payload: { message: 'Keine Audiodaten empfangen' } } as any);
        return;
      }
      if (format !== 'wav') {
        send(ws, { type: 'audio:error', sessionId, payload: { message: 'Nur WAV-Format unterstuetzt' } } as any);
        return;
      }

      // Auto-select model based on audio size: turbo for long audio (>2MB base64 ≈ 1+ min), large-v3 for short
      const autoModel = audio.length > 2 * 1024 * 1024 ? 'turbo' : 'large-v3';

      whisperTranscribe(audio, {
        model: autoModel,
        onProgress: (info) => {
          send(ws, { type: 'audio:progress', sessionId, payload: { chunk: info.chunk, total: info.total, text: info.text } } as any);
        },
      }).then((text) => {
        send(ws, { type: 'audio:transcription', sessionId, payload: { text } } as any);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'Transkription fehlgeschlagen';
        logger.warn(`[whisper] Transcription failed: ${message}`);
        send(ws, { type: 'audio:error', sessionId, payload: { message } } as any);
      });
      return;
    }

    // ── TTS: Text-to-Speech synthesis ─────────────────────────────
    if (msgType === 'tts:generate') {
      const text = (msg as any).payload?.text;
      const messageId = (msg as any).payload?.messageId ?? 'unknown';

      if (!text || typeof text !== 'string') {
        send(ws, { type: 'tts:error', payload: { messageId, message: 'Kein Text angegeben' } } as any);
        return;
      }

      if (!ttsAvailable()) {
        send(ws, { type: 'tts:error', payload: { messageId, message: 'TTS nicht verfügbar. Installiere: pip install mlx-audio' } } as any);
        return;
      }

      logger.info(`[tts] Generating for message ${messageId} (${text.length} chars)`);
      ttsSynthesize(text, {
        onProgress: (info) => {
          sendManager({ type: 'tts:progress', payload: { messageId, chunk: info.chunk, total: info.total } } as any);
        },
      }).then(({ audioBase64, durationSecs }) => {
        logger.info(`[tts] Done: ${messageId} — ${durationSecs}s audio, ${(audioBase64.length / 1024).toFixed(0)} KB base64`);

        // Save audio to file and send URL instead of base64 (3+ MB over WS is unreliable)
        const fs = require('fs');
        const path = require('path');
        const audioDir = path.join(__dirname, '..', '..', '..', 'generated-tts');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        const filename = `tts_${messageId}.wav`;
        fs.writeFileSync(path.join(audioDir, filename), Buffer.from(audioBase64, 'base64'));

        sendManager({ type: 'tts:result', payload: { messageId, filename, duration: durationSecs } } as any);
        logger.info(`[tts] Sent tts:result for ${messageId} (file: ${filename})`);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'TTS fehlgeschlagen';
        logger.warn(`[tts] Synthesis failed: ${message}`);
        sendManager({ type: 'tts:error', payload: { messageId, message } } as any);
      });
      return;
    }

    // ── Chrome Remote Control ──────────────────────────────────────
    if (msgType === 'chrome:connect') {
      chromeManager.onFrame = (data, width, height, timestamp) => {
        send(ws, { type: 'chrome:frame', payload: { data, width, height, timestamp } } as any);
      };
      chromeManager.onStatus = (state, reason) => {
        send(ws, { type: 'chrome:status', payload: { state, reason } } as any);
      };
      chromeManager.onTabEvent = (event) => {
        if (event.type === 'created') {
          send(ws, { type: 'chrome:tab:created', payload: event.tab } as any);
        } else if (event.type === 'removed') {
          send(ws, { type: 'chrome:tab:removed', payload: { targetId: event.targetId } } as any);
        } else if (event.type === 'updated') {
          send(ws, { type: 'chrome:tab:updated', payload: { targetId: event.targetId, title: event.title, url: event.url } } as any);
        }
      };
      chromeManager.onTabsList = (tabs, activeTargetId) => {
        send(ws, { type: 'chrome:tabs', payload: { tabs, activeTargetId } } as any);
      };
      chromeManager.connect().then(() => {
        chromeManager.startScreencast();
      }).catch((err: any) => {
        const msg = err instanceof Error ? err.message : String(err);
        send(ws, { type: 'chrome:status', payload: { state: 'not-found', reason: msg } } as any);
      });
      return;
    }

    if (msgType === 'chrome:disconnect') {
      chromeManager.disconnect();
      return;
    }

    if (msgType === 'chrome:input') {
      const p = (msg as any).payload ?? {};
      chromeManager.handleInput(p.action, p);
      return;
    }

    if (msgType === 'chrome:navigate') {
      const { url } = (msg as any).payload ?? {};
      if (url && typeof url === 'string') chromeManager.navigate(url);
      return;
    }

    if (msgType === 'chrome:tab:switch') {
      const { targetId } = (msg as any).payload ?? {};
      if (targetId) chromeManager.switchTab(targetId);
      return;
    }

    if (msgType === 'chrome:tab:open') {
      const { url } = (msg as any).payload ?? {};
      chromeManager.openTab(url);
      return;
    }

    if (msgType === 'chrome:tab:close') {
      const { targetId } = (msg as any).payload ?? {};
      if (targetId) chromeManager.closeTab(targetId);
      return;
    }

    if (msgType === 'chrome:quality') {
      const { quality, maxFps } = (msg as any).payload ?? {};
      if (typeof quality === 'number' && typeof maxFps === 'number') {
        chromeManager.setQuality(quality, maxFps);
      }
      return;
    }

    if (msgType === 'chrome:pause') {
      chromeManager.pause();
      return;
    }

    if (msgType === 'chrome:resume') {
      chromeManager.resume();
      return;
    }

    if (msgType === 'chrome:resize') {
      const { width, height } = (msg as any).payload ?? {};
      if (typeof width === 'number' && typeof height === 'number') {
        chromeManager.setMobileViewport(width, height);
        const chromeWidth = width < 400 ? 375 : width < 700 ? 600 : Math.max(900, width);
        const chromeHeight = Math.round(chromeWidth * 1.5);
        chromeManager.resize(chromeWidth, chromeHeight);
      }
      return;
    }

    if (msgType === 'chrome:back') {
      chromeManager.goBack();
      return;
    }

    if (msgType === 'chrome:forward') {
      chromeManager.goForward();
      return;
    }

    if (msgType === 'chrome:reload') {
      chromeManager.reload();
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        break;

      case 'client:register_token': {
        deviceToken = msg.payload?.token;
        if (!deviceToken) {
          logger.warn(`FCM: register_token received but token is empty/null`);
          break;
        }
        persistedTokens.add(deviceToken);   // survive reconnects
        // Cap at MAX_PERSISTED_TOKENS — evict oldest (first) entry
        if (persistedTokens.size > MAX_PERSISTED_TOKENS) {
          const oldest = persistedTokens.values().next().value;
          if (oldest !== undefined) persistedTokens.delete(oldest);
        }
        watcherService.setDeviceToken(deviceToken);
        managerService.setFcmTokens(persistedTokens);
        logger.success(`FCM token registered for ${ip} (len=${deviceToken.length})`);
        break;
      }

      case 'terminal:create': {
        try {
          const { cols, rows } = msg.payload;

          // Validate cols and rows
          if (!Number.isInteger(cols) || cols < 1 || cols > 500) {
            send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid cols: must be integer 1-500' } });
            break;
          }
          if (!Number.isInteger(rows) || rows < 1 || rows > 200) {
            send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid rows: must be integer 1-200' } });
            break;
          }

          const session = globalManager.createSession(
            { cols, rows },
            (sessionId, data) => {
              send(ws, { type: 'terminal:output', sessionId, payload: { data } });
              promptDetector.feed(sessionId, data);
              idleDetector.activity(sessionId);
              resetAutopilotTimer(sessionId);
              managerService.feedOutput(sessionId, data);
            },
            (sessionId, exitCode) => {
              ownedSessions.delete(sessionId);
              promptDetector.unwatch(sessionId);
              idleDetector.unwatch(sessionId);
              aiSessions.delete(sessionId);
              autopilotService.clearSession(sessionId);
              const apTimer = autopilotTimers.get(sessionId);
              if (apTimer) { clearTimeout(apTimer); autopilotTimers.delete(sessionId); }
              send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode } });
            },
          );
          ownedSessions.add(session.id);
          sessionGens.set(session.id, globalManager.getAttachGen(session.id));
          watchSession(session.id);
          watchSessionIdle(session.id);
          // Register session with manager — initial label, client will sync real names
          const shellNum = ownedSessions.size;
          managerService.setSessionLabel(session.id, `Shell ${shellNum}`);
          send(ws, {
            type: 'terminal:created',
            sessionId: session.id,
            payload: { cols: session.cols, rows: session.rows },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to create terminal';
          logger.error(`Failed to create terminal for ${ip}: ${message}`);
          send(ws, {
            type: 'terminal:error',
            sessionId: 'none',
            payload: { message: `Terminal creation failed: ${message}` },
          });
        }
        break;
      }

      case 'terminal:reattach': {
        if (!isValidSessionId(msg.sessionId)) {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } });
          break;
        }

        const { cols, rows } = msg.payload;

        if (!Number.isInteger(cols) || cols < 1 || cols > 500) {
          send(ws, { type: 'terminal:error', sessionId: msg.sessionId, payload: { message: 'Invalid cols: must be integer 1-500' } });
          break;
        }
        if (!Number.isInteger(rows) || rows < 1 || rows > 200) {
          send(ws, { type: 'terminal:error', sessionId: msg.sessionId, payload: { message: 'Invalid rows: must be integer 1-200' } });
          break;
        }

        const session = globalManager.reattachSession(
          msg.sessionId,
          (sessionId, data) => {
            send(ws, { type: 'terminal:output', sessionId, payload: { data } });
            promptDetector.feed(sessionId, data);
            idleDetector.activity(sessionId);
            resetAutopilotTimer(sessionId);
            managerService.feedOutput(sessionId, data);
          },
          (sessionId, exitCode) => {
            ownedSessions.delete(sessionId);
            promptDetector.unwatch(sessionId);
            idleDetector.unwatch(sessionId);
            aiSessions.delete(sessionId);
            autopilotService.clearSession(sessionId);
            const apTimer = autopilotTimers.get(sessionId);
            if (apTimer) { clearTimeout(apTimer); autopilotTimers.delete(sessionId); }
            send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode } });
          },
        );

        if (session) {
          ownedSessions.add(session.id);
          sessionGens.set(session.id, globalManager.getAttachGen(session.id));
          promptDetector.unwatch(session.id); // reset stale timer state before re-watching
          idleDetector.unwatch(session.id);   // reset stale idle state before re-watching
          watchSession(session.id);
          watchSessionIdle(session.id);
          // Set initial label — client will sync real names via manager:sync_labels
          if (!managerService.getSessionList().find(s => s.sessionId === session.id)) {
            managerService.setSessionLabel(session.id, `Shell ${ownedSessions.size}`);
          }
          globalManager.resize(session.id, cols, rows);
          send(ws, {
            type: 'terminal:reattached',
            sessionId: session.id,
            payload: {
              cols: session.cols,
              rows: session.rows,
              cwd: session.cwd,
              processName: session.processName,
            },
          });

          // Sync autopilot queue status — items may have been optimized while client was away
          const queue = autopilotService.getQueue(session.id);
          for (const item of queue) {
            if (item.status === 'queued' && item.optimizedPrompt) {
              send(ws, { type: 'autopilot:optimized', sessionId: session.id, payload: { id: item.id, optimizedPrompt: item.optimizedPrompt } } as any);
            } else if (item.status === 'done') {
              send(ws, { type: 'autopilot:prompt_done', sessionId: session.id, payload: { id: item.id } } as any);
            } else if (item.status === 'error' && item.error) {
              send(ws, { type: 'autopilot:optimize_error', sessionId: session.id, payload: { id: item.id, error: item.error } } as any);
            }
          }
        } else {
          send(ws, {
            type: 'terminal:error',
            sessionId: msg.sessionId,
            payload: { message: 'Session not found' },
          });
        }
        break;
      }

      case 'terminal:input': {
        if (!isValidSessionId(msg.sessionId)) {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } });
          break;
        }

        const { data } = msg.payload;

        // Validate input data
        if (typeof data !== 'string' || data.length >= 1_048_576) {
          send(ws, {
            type: 'terminal:error',
            sessionId: msg.sessionId,
            payload: { message: 'Invalid input: must be a string under 1 MB' },
          });
          break;
        }

        // Track user input for auto-approve typing pause + pending input detection
        lastUserInputAt.set(msg.sessionId, Date.now());
        trackPendingInput(msg.sessionId, data);
        idleDetector.activity(msg.sessionId);
        resetAutopilotTimer(msg.sessionId);
        managerService.trackUserInput(msg.sessionId);

        if (!globalManager.write(msg.sessionId, data)) {
          send(ws, {
            type: 'terminal:error',
            sessionId: msg.sessionId,
            payload: { message: 'Session not found' },
          });
        }
        break;
      }

      case 'terminal:resize': {
        if (!isValidSessionId(msg.sessionId)) {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } });
          break;
        }

        const { cols, rows } = msg.payload;

        // Validate cols and rows
        if (!Number.isInteger(cols) || cols < 1 || cols > 500) {
          send(ws, { type: 'terminal:error', sessionId: msg.sessionId, payload: { message: 'Invalid cols: must be integer 1-500' } });
          break;
        }
        if (!Number.isInteger(rows) || rows < 1 || rows > 200) {
          send(ws, { type: 'terminal:error', sessionId: msg.sessionId, payload: { message: 'Invalid rows: must be integer 1-200' } });
          break;
        }

        if (!globalManager.resize(msg.sessionId, cols, rows)) {
          send(ws, {
            type: 'terminal:error',
            sessionId: msg.sessionId,
            payload: { message: 'Session not found' },
          });
        }
        break;
      }

      case 'terminal:clear': {
        if (!isValidSessionId(msg.sessionId)) break;
        // Send platform-appropriate clear command
        const clearCmd = require('os').platform() === 'win32' ? 'cls\r' : 'clear\r';
        globalManager.write(msg.sessionId, clearCmd);
        break;
      }

      case 'terminal:close': {
        if (!isValidSessionId(msg.sessionId)) {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } });
          break;
        }

        ownedSessions.delete(msg.sessionId);
        sessionGens.delete(msg.sessionId);
        serverAutoApprove.delete(msg.sessionId);
        lastUserInputAt.delete(msg.sessionId);
        pendingInputLen.delete(msg.sessionId);
        promptDetector.unwatch(msg.sessionId);
        idleDetector.unwatch(msg.sessionId);
        aiSessions.delete(msg.sessionId);
        autopilotService.clearSession(msg.sessionId);
        managerService.clearSession(msg.sessionId);
        const apTimer = autopilotTimers.get(msg.sessionId);
        if (apTimer) { clearTimeout(apTimer); autopilotTimers.delete(msg.sessionId); }
        if (!globalManager.closeSession(msg.sessionId)) {
          send(ws, {
            type: 'terminal:error',
            sessionId: msg.sessionId,
            payload: { message: 'Session not found' },
          });
        }
        break;
      }

      // ── Watcher messages ──────────────────────────────────────────────
      case 'watcher:list': {
        const watchers = watcherService.getAll();
        send(ws, { type: 'watcher:list', payload: { watchers } });
        break;
      }

      case 'watcher:create': {
        const w = msg.payload;
        if (!w || typeof w.id !== 'string' || typeof w.label !== 'string' || typeof w.type !== 'string' || typeof w.enabled !== 'boolean' || !w.config || typeof w.config !== 'object') {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid watcher:create payload' } });
          break;
        }
        // Validate watcher type against whitelist
        if (!(VALID_WATCHER_TYPES as readonly string[]).includes(w.type)) {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: `Invalid watcher type: must be one of ${VALID_WATCHER_TYPES.join(', ')}` } });
          break;
        }
        watcherService.create(w as { id: string; type: 'file' | 'process' | 'keyword'; label: string; enabled: boolean; config: Record<string, string> });
        send(ws, { type: 'watcher:created', payload: w as { id: string; type: string; label: string; enabled: boolean; config: Record<string, string> } });
        break;
      }

      case 'watcher:update': {
        const payload = msg.payload;
        if (!payload || typeof payload.id !== 'string') {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid watcher:update payload' } });
          break;
        }
        // Whitelist allowed update fields — only enabled, label, config
        const allowedUpdates: Partial<{ enabled: boolean; label: string; config: Record<string, string> }> = {};
        if ('enabled' in payload && typeof payload.enabled === 'boolean') allowedUpdates.enabled = payload.enabled;
        if ('label' in payload && typeof (payload as Record<string, unknown>).label === 'string') allowedUpdates.label = (payload as Record<string, unknown>).label as string;
        if ('config' in payload && typeof (payload as Record<string, unknown>).config === 'object' && (payload as Record<string, unknown>).config !== null) allowedUpdates.config = (payload as Record<string, unknown>).config as Record<string, string>;
        const updated = watcherService.update(payload.id, allowedUpdates);
        if (updated) {
          send(ws, { type: 'watcher:updated', payload: updated as { id: string; enabled: boolean } });
        }
        break;
      }

      case 'watcher:delete': {
        const payload = msg.payload;
        if (!payload || typeof payload.id !== 'string') {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid watcher:delete payload' } });
          break;
        }
        watcherService.delete(payload.id);
        send(ws, { type: 'watcher:deleted', payload: { id: payload.id } });
        break;
      }

      case 'watcher:test': {
        const payload = msg.payload;
        if (!payload || typeof payload.id !== 'string') {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid watcher:test payload' } });
          break;
        }
        watcherService.test(payload.id);
        break;
      }

      // ── System monitor messages ──────────────────────────────────
      case 'system:snapshot': {
        getProcessSnapshot().then((snapshot) => {
          send(ws, { type: 'system:snapshot', payload: snapshot });
        }).catch((err) => {
          logger.warn(`System snapshot failed: ${err instanceof Error ? err.message : err}`);
        });
        break;
      }

      case 'system:kill': {
        const { pid, signal } = msg.payload;

        // Only allow killing managed PTY pids
        const managedPids = globalManager.getManagedPids();
        if (!managedPids.has(pid)) {
          send(ws, { type: 'system:kill_result', payload: { pid, success: false, message: 'Only managed terminal PIDs can be killed via this command' } });
          break;
        }

        killProcess(pid, signal).then((result) => {
          send(ws, { type: 'system:kill_result', payload: { pid, success: result.ok, message: result.error } });
        }).catch((err) => {
          logger.warn(`Kill process failed: ${err instanceof Error ? err.message : err}`);
          send(ws, { type: 'system:kill_result', payload: { pid, success: false, message: err instanceof Error ? err.message : String(err) } });
        });
        break;
      }

      default:
        logger.warn(`Unknown message type from ${ip}: ${(msg as { type: string }).type}`);
    }
  });

  ws.on('close', () => {
    logger.info(`Client disconnected: ${ip} — detaching ${ownedSessions.size} sessions (kept alive)`);

    // Clear the current WS reference so manager messages get buffered
    if (currentWs === ws) {
      currentWs = null;
    }

    chromeManager.disconnect();

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

  ws.on('error', (err) => {
    logger.error(`WebSocket error from ${ip}: ${err.message}`);
    if (currentWs === ws) currentWs = null;
    for (const sessionId of ownedSessions) {
      // Do NOT unwatch promptDetector — same rationale as ws.on('close')
      globalManager.detachSession(sessionId);
    }
    ownedSessions.clear();
  });
}
