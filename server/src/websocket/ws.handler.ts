import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol';
import { globalManager } from '../terminal/terminal.manager';
import { promptDetector } from '../notifications/prompt.detector';
import { fcmService } from '../notifications/fcm.service';
import { watcherService } from '../watchers/watcher.service';
import { getProcessSnapshot, killProcess } from '../system/process.monitor';
import { logger } from '../utils/logger';

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

export function handleConnection(ws: WebSocket, ip: string): void {
  // Track which sessions this connection owns (for detach on disconnect)
  const ownedSessions = new Set<string>();
  // Use the persisted tokens as the starting value; overwritten on register
  let deviceToken: string | null = persistedTokens.size > 0 ? [...persistedTokens][0] : null;

  logger.success(`Client connected: ${ip}`);

  /** Register a session with the prompt detector so we can notify on AI prompts. */
  const watchSession = (sessionId: string): void => {
    promptDetector.watch(sessionId, (snippet) => {
      // Always send in-app badge notification via WebSocket
      send(ws, { type: 'terminal:prompt_detected', sessionId, payload: { snippet } });

      if (persistedTokens.size === 0) { logger.warn('FCM: prompt detected but no token'); return; }
      logger.info(`FCM: sending notification — "${snippet.slice(0, 60)}"`);
      const promises: Promise<void>[] = [];
      for (const token of persistedTokens) {
        promises.push(
          fcmService.send(
            token,
            '⚡ Terminal waiting for input',
            snippet,
            { sessionId },
          ).catch(() => { persistedTokens.delete(token); })
        );
      }
      void Promise.allSettled(promises);
    });
  };

  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn(`Invalid JSON from ${ip}`);
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        break;

      case 'client:register_token': {
        deviceToken = msg.payload.token;
        persistedTokens.add(deviceToken);   // survive reconnects
        // Cap at MAX_PERSISTED_TOKENS — evict oldest (first) entry
        if (persistedTokens.size > MAX_PERSISTED_TOKENS) {
          const oldest = persistedTokens.values().next().value;
          if (oldest !== undefined) persistedTokens.delete(oldest);
        }
        watcherService.setDeviceToken(deviceToken);
        logger.info(`FCM token registered for ${ip}`);
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
            },
            (sessionId, exitCode) => {
              ownedSessions.delete(sessionId);
              promptDetector.unwatch(sessionId);
              send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode } });
            },
          );
          ownedSessions.add(session.id);
          watchSession(session.id);
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
          },
          (sessionId, exitCode) => {
            ownedSessions.delete(sessionId);
            promptDetector.unwatch(sessionId);
            send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode } });
          },
        );

        if (session) {
          ownedSessions.add(session.id);
          watchSession(session.id);
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

      case 'terminal:close': {
        if (!isValidSessionId(msg.sessionId)) {
          send(ws, { type: 'terminal:error', sessionId: 'none', payload: { message: 'Invalid sessionId' } });
          break;
        }

        ownedSessions.delete(msg.sessionId);
        promptDetector.unwatch(msg.sessionId);
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
    for (const sessionId of ownedSessions) {
      promptDetector.unwatch(sessionId);
      globalManager.detachSession(sessionId);
    }
    ownedSessions.clear();
  });

  ws.on('error', (err) => {
    logger.error(`WebSocket error from ${ip}: ${err.message}`);
    for (const sessionId of ownedSessions) {
      promptDetector.unwatch(sessionId);
      globalManager.detachSession(sessionId);
    }
    ownedSessions.clear();
  });
}
