import { ProcessWatch } from '../terminal/process.watch';
import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { globalManager } from '../terminal/terminal.manager';
import { readProcessCwd, readForegroundProcess, normalizeCwd } from '../terminal/cwd.utils';
import { promptDetector } from '../notifications/prompt.detector';
import { idleDetector } from '../notifications/idle.detector';
import { fcmService } from '../notifications/fcm.service';
import { getProcessSnapshot, killProcess } from '../system/process.monitor';
import { logger } from '../utils/logger';
import { autopilotService } from '../autopilot/autopilot.service';
import { computePendingLen, evaluateApprovalGate, evaluateGate } from './approval.util';
import { screenPromptWatcher, setScreenSource } from '../notifications/prompt.watcher';
import { promptFingerprint, type PromptClass } from '../notifications/prompt.classifier';
import { isAutoApprove, setAutoApprove, clearAutoApprove } from './auto.approve.state';
import { transcribe as whisperTranscribe } from '../audio/whisper-sidecar';
import { synthesize as ttsSynthesize, isAvailable as ttsAvailable } from '../audio/tts-sidecar';
import { DictationManager } from '../audio/dictation';
import { handleDictationMessage, createDictationConnectionHandler } from '../audio/dictation.connection';
import { decodeToFloat32 } from '../audio/ffmpeg-decode';
import { AdtsPcm } from '../audio/adts-pcm';
import { DictationStatsStore } from '../audio/dictation.stats';
import { DictionaryStore } from '../audio/dictionary';
import { handleDictionaryMessage } from '../audio/dictionary.connection';
import { captureSoon } from '../terminal/restore/snapshotter';
import { ConnectionRateLimiter } from './rate-limiter';
import { createOutputPacer } from './output.pacer';
import { createActivityFeed } from './activity.feed';
import { readAnswers, forgetReader } from '../reader';
import { startSpeechRun, type SpeechRun } from '../voice/run';
import { synthesize, voiceAvailable } from '../voice/engine';
import { browserBridge } from '../browserbridge/browserbridge.manager';
import { asPaste } from '../terminal/paste.policy';
import { titleStore } from '../terminal/titles';
import { cleanTitle } from '../terminal/titles.store';
import { clipboardHub } from '../clipboard';
import {
  hasMacUnlockPassword,
  setMacUnlockPassword,
  getMacUnlockPassword,
  unlockMacScreen,
} from '../auth/mac-unlock.service';

// ── Terminal-Titel: auf dem Server gespeichert, an ALLE Apps verteilt ─────────
// Der Titel eines Terminals gehoert dem Server (titles.store.ts): so ueberlebt
// er eine Neuinstallation der App und ist auf jedem Geraet derselbe.
const liveSockets = new Set<WebSocket>();
function broadcastTitle(sessionId: string, title: string | null): void {
  const msg: ServerMessage = { type: 'terminal:title', sessionId, payload: { title } };
  const data = JSON.stringify(msg);
  for (const sock of liveSockets) {
    if (sock.readyState === 1) sock.send(data);
  }
}
// ── Gemeinsame Zwischenablage: jede Aenderung geht an ALLE Apps ──────────────
clipboardHub.onChange((ev) => {
  const msg: ServerMessage = ev.kind === 'added'
    ? { type: 'clipboard:added', payload: { item: ev.change.item, removed: ev.change.removed } }
    : { type: 'clipboard:removed', payload: { ids: ev.ids } };
  const data = JSON.stringify(msg);
  for (const sock of liveSockets) if (sock.readyState === 1) sock.send(data);
});

/** Ein Terminal ist endgueltig weg — sein Titel auch. */
function forgetTitle(sessionId: string): void {
  forgetReader(sessionId);
  if (titleStore.get(sessionId) === undefined) return;
  titleStore.remove(sessionId);
  broadcastTitle(sessionId, null);
}

// Wire up the detach feed callback so the prompt detector keeps receiving
// data even when sessions are detached (client backgrounded/disconnected).
// This enables server-side auto-approve. The idle detector also needs activity
// signals so idle notifications work while the client is away.
globalManager.detachFeedCallback = (sessionId, data) => {
  promptDetector.feed(sessionId, data);
  screenPromptWatcher.poke(sessionId);
  idleDetector.activity(sessionId);
};

// Der Beobachter liest den Bildschirm über den Manager — spät gebunden, damit
// das Beobachter-Modul nichts vom Terminal-Manager wissen muss.
setScreenSource((sessionId) => globalManager.getScreen(sessionId));

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Streamed dictation ──────────────────────────────────────────────
// One process-wide manager: sessions outlive the socket that started them, so
// a reconnecting app resumes its dictation instead of losing it.
/** Terms and mishearings of the dictation (the user edits them in the app). */
export const dictionary = new DictionaryStore(path.join(os.homedir(), '.tms-terminal', 'dictionary.json'));
/** Stop -> text timings of the last 50 dictations (numbers only). */
export const dictationStats = new DictationStatsStore(path.join(os.homedir(), '.tms-terminal', 'dictation-stats.json'));
const dictations = new DictationManager({
  decode: (bytes, format) => decodeToFloat32(bytes, format),
  openPcm: () => new AdtsPcm((bytes) => decodeToFloat32(bytes, 'adts')),
  onDone: (stat) => dictationStats.record(stat),
  transcribeWav: (wavBase64) => whisperTranscribe(wavBase64, { prompt: dictionary.prompt() }),
  fix: (text) => dictionary.fix(text),
  now: () => Date.now(),
  log: (msg) => logger.info(msg),
});
setInterval(() => dictations.sweep(), 60_000).unref();


/** Lean connection for the Android dictation bubble (`?role=dictation`). */
export const handleDictationConnection = createDictationConnectionHandler(dictations, (m) => logger.info(m));

// ── Live working-directory tracking ──────────────────────────────────
// A cd/pushd changes the shell's cwd. Rather than parse the output text,
// we re-read the real cwd once the terminal output settles after a command,
// and push it only when it actually changed. Timers are unref'd; a timer
// that fires after the session is gone is a no-op (getSession returns
// undefined), so no explicit teardown is required for correctness.
const cwdCheckTimers = new Map<string, NodeJS.Timeout>();
const CWD_SETTLE_MS = 500;

/** Read the shell's real cwd and push it if it differs from the last known. */
async function refreshCwd(ws: WebSocket, sessionId: string): Promise<void> {
  const session = globalManager.getSession(sessionId);
  if (!session) return;
  const raw = await readProcessCwd(session.pty.pid);
  if (!raw || raw === session.cwd) return;
  session.cwd = raw; // store raw absolute path (consistent with factory/detach)
  send(ws, { type: 'terminal:cwd', sessionId, payload: { cwd: normalizeCwd(raw) } });
}

// ── Vordergrund-Programm beim Start einer Vollbild-TUI ───────────────
// Unter Windows schluckt ConPTY die DECSET-Maus-Sequenzen von OpenCode; die
// Seite erzwingt den Maus-Modus dann nur, wenn sie den Prozessnamen kennt.
// Bisher kam der erst nach einer Neuverbindung. Jetzt: beim ÜBERGANG in den
// alternativen Bildschirm einmal nachsehen (nicht bei jeder Ausgabe — unter
// Windows startet das jedes Mal PowerShell).
const altScreenSeen = new Map<string, boolean>();
async function refreshProcessOnAltScreen(ws: WebSocket, sessionId: string): Promise<void> {
  const session = globalManager.getSession(sessionId);
  if (!session) return;
  const alt = await globalManager.isAltScreen(sessionId);
  const was = altScreenSeen.get(sessionId) ?? false;
  altScreenSeen.set(sessionId, alt);
  // Beide Übergänge melden: auch das ENDE (vim beendet) — sonst hielte die App
  // den alten Namen und gäbe dem Terminal weiter die echte statt der
  // virtuellen Höhe.
  if (alt === was) return;
  const name = await readForegroundProcess(session.pty.pid);
  if (!name) return;
  session.processName = name;
  send(ws, { type: 'terminal:process', sessionId, payload: { processName: name } });
}

// Windows: ConPTY gibt den alternativen Bildschirm nicht weiter — der Start
// einer Vollbild-TUI ist im Strom unsichtbar. Dort stattdessen nach Ausgabe-
// Pausen gedrosselt nachsehen (siehe process.watch.ts).
const procWs = new Map<string, WebSocket>();
const processWatch = new ProcessWatch({
  now: () => Date.now(),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
  read: async (sessionId) => {
    const session = globalManager.getSession(sessionId);
    return session ? readForegroundProcess(session.pty.pid) : null;
  },
  report: (sessionId, name) => {
    const session = globalManager.getSession(sessionId);
    const ws = procWs.get(sessionId);
    if (!session || !ws) return;
    session.processName = name;
    send(ws, { type: 'terminal:process', sessionId, payload: { processName: name } });
  },
});
const IS_WINDOWS = os.platform() === 'win32';

/** Debounced cwd re-read — called on every output chunk. */
function scheduleCwdCheck(ws: WebSocket, sessionId: string): void {
  const prev = cwdCheckTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    cwdCheckTimers.delete(sessionId);
    void refreshCwd(ws, sessionId);
    if (IS_WINDOWS) { procWs.set(sessionId, ws); processWatch.poke(sessionId); }
    else void refreshProcessOnAltScreen(ws, sessionId);
  }, CWD_SETTLE_MS);
  t.unref();
  cwdCheckTimers.set(sessionId, t);
}

/** Cancel a pending cwd re-read (called from a session's exit callback). */
function clearCwdCheck(sessionId: string): void {
  const t = cwdCheckTimers.get(sessionId);
  if (t) { clearTimeout(t); cwdCheckTimers.delete(sessionId); }
  altScreenSeen.delete(sessionId);
  processWatch.forget(sessionId);
  procWs.delete(sessionId);
}

/** Push the current best-known cwd immediately (on attach/create) so the
 *  folder label is correct right away; scheduleCwdCheck then keeps it live. */
function pushInitialCwd(ws: WebSocket, sessionId: string): void {
  const session = globalManager.getSession(sessionId);
  if (!session?.cwd) return;
  send(ws, { type: 'terminal:cwd', sessionId, payload: { cwd: normalizeCwd(session.cwd) } });
}

function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length < 50;
}

// Last known FCM tokens — persists across client reconnects so that
// prompt notifications can still be sent even if the client briefly disconnects.
const MAX_PERSISTED_TOKENS = 10;
const persistedTokens: Set<string> = new Set();

// Ein Push je wartender Frage. Der Fingerabdruck stammt aus dem Klassifikator
// und bleibt stabil, solange dieselbe Frage auf dem Schirm steht — ohne ihn
// würde jeder Neuzeichen-Frame eine weitere Benachrichtigung auslösen.
const lastQuestionPush = new Map<string, string>();

/**
 * Meldet eine Umfrage ans Handy. NUR für Umfragen: Berechtigungen beantwortet
 * der Server selbst, dafür will niemand geweckt werden.
 * Die Daten tragen die sessionId, damit ein Tipp auf die Meldung genau dieses
 * Terminal öffnet (siehe notifications.service.ts).
 */
function pushQuestion(sessionId: string, label: string, question: string, fp: string): void {
  if (lastQuestionPush.get(sessionId) === fp) return;
  lastQuestionPush.set(sessionId, fp);

  if (persistedTokens.size === 0) {
    logger.warn('Frage-Push uebersprungen — kein FCM-Token registriert');
    return;
  }
  const hostname = os.hostname().replace(/\.local$/, '');
  const title = `\u{2753} Rückfrage · ${hostname} · ${label}`;
  const body = question.trim().slice(0, 120) || 'Das Terminal wartet auf deine Auswahl';

  logger.info(`Frage-Push: "${title}" — "${body}"`);
  for (const token of persistedTokens) {
    void fcmService
      .send(token, title, body, { sessionId, type: 'prompt', kind: 'question' })
      .catch(() => { persistedTokens.delete(token); });
  }
}

// Track last user input per session — auto-approve pauses while user is typing.
// Updated on every terminal:input message from the client.
// (Typing/stale thresholds live in approval.util next to the gate decision.)
const lastUserInputAt = new Map<string, number>();

// Track how many characters the user has on the current input line.
// Auto-approve is blocked if pendingInputLen > 0 (user has unsent text).
const pendingInputLen = new Map<string, number>();

// The connection that receives browser-bridge pushes (the most recent one).
let currentWs: WebSocket | null = null;

// ── Autopilot state ──────────────────────────────────────────────────
const aiSessions = new Set<string>(); // sessions where AI tool was detected
const autopilotTimers = new Map<string, NodeJS.Timeout>();
// Auto-approve retry chains: a prompt that fired while the user was typing is
// DEFERRED, not dropped (the detector's dedup hash never changes while the
// prompt sits waiting, so it would otherwise never fire again).
const approvalRetryTimers = new Map<string, NodeJS.Timeout>();
const APPROVAL_RETRY_MS = 1000;
const APPROVAL_RETRY_MAX = 30; // ~30s of patience, then give up loudly
const AUTOPILOT_IDLE_MS = 60_000; // 1 minute idle before sending next prompt

/** Update pending input tracking from raw terminal input data. See computePendingLen. */
function trackPendingInput(sessionId: string, data: string): void {
  pendingInputLen.set(sessionId, computePendingLen(pendingInputLen.get(sessionId) ?? 0, data));
}

export function handleConnection(ws: WebSocket, ip: string): void {
  // Track which sessions this connection owns (for detach on disconnect)
  const ownedSessions = new Set<string>();
  // Track attach generation per session — passed to detachSession to prevent stale detach
  const sessionGens = new Map<string, number>();
  // Deduplicate rapid identical reattach requests (e.g. AppState wake storms)
  const lastReattach = new Map<string, { at: number; cols: number; rows: number }>();
  // Use the persisted tokens as the starting value; overwritten on register
  let deviceToken: string | null = persistedTokens.size > 0 ? [...persistedTokens][0] : null;

  // Per-connection rate limiter
  const rateLimiter = new ConnectionRateLimiter();

  // Output pacing (see output.pacer.ts): covered terminals in bundles, a
  // backgrounded app almost nothing — same bytes, same order, fewer wake-ups.
  /** Sessions handed over while the app was not visible (see below). */
  const heldDetached = new Set<string>();
  const pacer = createOutputPacer((sid, data) => {
    send(ws, { type: 'terminal:output', sessionId: sid, payload: { data } });
  }, undefined, (sid, data) => {
    // The app is not visible and this session keeps producing: stop queueing
    // for it altogether. Detached, its output only feeds the mirror and the
    // detectors (auto-approve, pushes keep working); `data` — what the app
    // never saw — counts as missed, so the app gets one full picture when it
    // comes back (client:attention below) instead of megabytes in the pocket.
    globalManager.detachSession(sid, sessionGens.get(sid), data);
    heldDetached.add(sid);
  });
  /** Send what the pacer still holds for a session (it is about to end). */
  const flushPaced = (sid: string): void => {
    const rest = pacer.take(sid);
    if (rest) send(ws, { type: 'terminal:output', sessionId: sid, payload: { data: rest } });
  };

  logger.success(`Client connected: ${ip}`);
  liveSockets.add(ws);
  send(ws, { type: 'terminal:titles', payload: { titles: titleStore.all() } });
  // Woran jedes Terminal arbeitet: der ganze Stand jetzt, danach nur Wechsel —
  // und gar nichts, solange die App nicht sichtbar ist (activity.feed.ts).
  const activityFeed = createActivityFeed(
    (activities, full) => send(ws, { type: 'terminal:activity', payload: full ? { activities, full } : { activities } }),
    globalManager.getActivities(),
  );
  const stopActivity = globalManager.onActivity((sid, activity) => activityFeed.note(sid, activity));
  activityFeed.start();
  // Vorlesen in der geklonten Stimme: höchstens ein Lauf je Verbindung.
  let speech: { reqId: string; run: SpeechRun } | null = null;
  const stopSpeech = (): void => { speech?.run.stop(); speech = null; };
  void hasMacUnlockPassword().then((configured) => {
    send(ws, { type: 'mac:unlock_status', payload: { configured, supported: process.platform === 'darwin' } });
  });

  currentWs = ws;

  // Browser-Bridge: when a captured browser-open is forwarded, push the URL to
  // this connection (foreground auto-open) AND fire an FCM push so a backgrounded
  // app still surfaces the login. See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
  browserBridge.setNotifier((ev) => {
    send(ws, { type: 'browserbridge:open', payload: ev });
    if (deviceToken) {
      void fcmService.send(deviceToken, '🔐 Login öffnen', ev.host || 'Terminal-Browser', { kind: 'browserbridge', url: ev.url });
    }
  });


  /** „Shell 3" — dieselbe Beschriftung wie beim Idle-Push. */
  const terminalLabel = (sessionId: string): string => {
    const num = [...ownedSessions].indexOf(sessionId) + 1;
    return num > 0 ? `Shell ${num}` : 'Terminal';
  };

  /** Register a session with the prompt detector for auto-approve (no FCM — idle detector handles that). */
  const watchSession = (sessionId: string, reattach = false): void => {
    const onPrompt = (snippet: string, context?: { window: string; reason: 'prompt' | 'ai-finished' }): void => {
      // Gibt es einen Spiegel, gehört die Prompt-Behandlung dem Bildschirm-Weg
      // (siehe screenPromptWatcher unten). Der Byte-Weg ist dann nur noch für
      // „die KI ist fertig" zuständig — und bleibt Rückfall ohne Spiegel.
      if (context?.reason === 'prompt' && globalManager.hasMirror(sessionId)) return;

      // Sudo / Passwort-Abfrage niemals automatisch beantworten — immer ans Handy melden.
      if (/(\[sudo\]\s*password\s+for\s+[^:]+:\s*|^password:\s*|enter\s+passphrase\s+for\s+[^:]+:\s*)/im.test(snippet)) {
        const pendingFlag = (pendingInputLen.get(sessionId) ?? 0) > 0;
        send(ws, { type: 'terminal:prompt_detected', sessionId, payload: { snippet, hasPendingInput: pendingFlag, kind: 'sudo' } });
        return;
      }

      // Server-side auto-approve: if enabled, send the approving keystroke directly
      // to the PTY. This works even when the client is backgrounded/disconnected.
      if (isAutoApprove(sessionId)) {
        const firedHash = promptDetector.tailHash(sessionId);
        const win = context?.window ?? snippet;

        /** One gate evaluation; defers itself while the user is typing. */
        const tryApprove = (attempt: number): 'sent' | 'deferred' | 'notify-only' | 'stale' | 'off' => {
          if (!isAutoApprove(sessionId)) return 'off';
          // Any output since the fire (user answered, box torn down, new
          // content) means this prompt is gone — stop, never double-press.
          if (promptDetector.tailHash(sessionId) !== firedHash) return 'stale';
          const gate = evaluateApprovalGate({
            window: win,
            pendingLen: pendingInputLen.get(sessionId) ?? 0,
            sinceInputMs: Date.now() - (lastUserInputAt.get(sessionId) ?? 0),
          });
          if (gate.gate === 'send') {
            logger.info(`Auto-approve: sending ${JSON.stringify(gate.key)} for session ${sessionId.slice(0, 8)}${attempt ? ` (retry ${attempt})` : ''}`);
            globalManager.write(sessionId, gate.key);
            // Our own keystroke is not user input — clear any stale pending count.
            pendingInputLen.set(sessionId, 0);
            // Refresh the detector's refractory so the box teardown can't re-fire.
            promptDetector.noteApproved(sessionId);
            return 'sent';
          }
          if (gate.gate === 'notify-only') return 'notify-only';
          // paused-typing / blocked-pending: DEFER — dropping it here is how
          // approvals used to vanish forever.
          if (attempt < APPROVAL_RETRY_MAX) {
            const prev = approvalRetryTimers.get(sessionId);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => { approvalRetryTimers.delete(sessionId); tryApprove(attempt + 1); }, APPROVAL_RETRY_MS);
            t.unref();
            approvalRetryTimers.set(sessionId, t);
          } else {
            logger.info(`Auto-approve: gave up after ${APPROVAL_RETRY_MAX} retries for session ${sessionId.slice(0, 8)}`);
          }
          return 'deferred';
        };

        // A fresh prompt supersedes any retry chain from an earlier one.
        const prevTimer = approvalRetryTimers.get(sessionId);
        if (prevTimer) { clearTimeout(prevTimer); approvalRetryTimers.delete(sessionId); }

        const outcome = tryApprove(0);
        if (outcome === 'sent') return; // No WS notification needed
        if (outcome === 'deferred') {
          logger.info(`Auto-approve: DEFERRED for session ${sessionId.slice(0, 8)} (user active) — retrying up to ${APPROVAL_RETRY_MAX}s`);
        } else if (outcome === 'notify-only') {
          // Evidence trail: log the (base64-masked) last line so a misclassified
          // permission prompt can be diagnosed from the log alone.
          const lastLine = win.slice(win.lastIndexOf('\n') + 1).trim();
          logger.info(`Auto-approve: NOTIFY-only for session ${sessionId.slice(0, 8)} (free-text prompt) lastLine-b64=${Buffer.from(lastLine).toString('base64').slice(0, 96)}`);
        }
      }

      // Send in-app badge notification via WebSocket (for auto-approve UI badge)
      const pendingFlag = (pendingInputLen.get(sessionId) ?? 0) > 0;
      send(ws, { type: 'terminal:prompt_detected', sessionId, payload: { snippet, hasPendingInput: pendingFlag } });
    };
    // Reattach must NOT reset the startup grace (rewatch preserves it); a fresh
    // watch() is only for a brand-new session.
    if (reattach) promptDetector.rewatch(sessionId, onPrompt);
    else promptDetector.watch(sessionId, onPrompt);

    // ── Bildschirm-Weg: der eigentliche Auto-Approve ──
    // Klassifiziert auf dem gerenderten Bildschirm statt auf dem Byte-Strom und
    // wird so lange erneut bewertet, bis der Prompt gelöst ist (prompt.watcher).
    screenPromptWatcher.watch(sessionId, (cls: PromptClass, attempt: number) => {
      if (cls.kind === 'sudo') {
        if (attempt === 0) {
          send(ws, {
            type: 'terminal:prompt_detected',
            sessionId,
            payload: {
              snippet: cls.question,
              hasPendingInput: (pendingInputLen.get(sessionId) ?? 0) > 0,
              kind: 'sudo',
            },
          });
        }
        return;
      }

      if (cls.key !== null) {
        // Berechtigung oder Ja/Nein — beantwortbar.
        if (isAutoApprove(sessionId)) {
          const gate = evaluateGate({
            key: cls.key,
            pendingLen: pendingInputLen.get(sessionId) ?? 0,
            sinceInputMs: Date.now() - (lastUserInputAt.get(sessionId) ?? 0),
          });
          if (gate.gate === 'send') {
            logger.info(`Auto-approve: sende ${JSON.stringify(gate.key)} fuer ${sessionId.slice(0, 8)}${attempt ? ` (Versuch ${attempt})` : ''}`);
            globalManager.write(sessionId, gate.key);
            pendingInputLen.set(sessionId, 0);   // unser Tastendruck ist keine Nutzereingabe
            screenPromptWatcher.resolved(sessionId);
            return;
          }
          if (attempt === 0) {
            logger.info(`Auto-approve: VERSCHOBEN fuer ${sessionId.slice(0, 8)} (${gate.gate}) — wird wiederholt`);
          }
          if (attempt >= 1) return;   // der Takt versucht es weiter, ohne die App zuzuspammen
        }
        if (attempt === 0) {
          send(ws, {
            type: 'terminal:prompt_detected',
            sessionId,
            payload: {
              snippet: cls.question,
              hasPendingInput: (pendingInputLen.get(sessionId) ?? 0) > 0,
              kind: cls.kind === 'confirm' ? 'confirm' : 'permission',
            },
          });
        }
        return;
      }

      // Umfrage: nie beantworten. Melden und einmalig pushen.
      if (attempt === 0) {
        send(ws, {
          type: 'terminal:prompt_detected',
          sessionId,
          payload: { snippet: cls.question, hasPendingInput: false, kind: 'question' },
        });
        pushQuestion(sessionId, terminalLabel(sessionId), cls.question, promptFingerprint(cls));
      }
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
    (sid, itemId) => send(ws, { type: 'autopilot:prompt_sent', sessionId: sid, payload: { id: itemId } }),
    (sid, itemId) => send(ws, { type: 'autopilot:prompt_done', sessionId: sid, payload: { id: itemId } }),
  );

  /**
   * Hängt eine laufende Session an DIESE Verbindung an: ab jetzt geht ihre
   * Ausgabe hierher, und der Rückstand aus dem Detach-Puffer wird nachgespült.
   * Die Größe bleibt, wie sie ist — der Aufrufer kennt die Maße des Clients nicht,
   * und ein unnötiges SIGWINCH lässt Claude & Co. ihr ganzes Bild neu malen.
   */
  const attachToThisClient = (sessionId: string, clientCols?: number, clientRows?: number, clientFresh = false): boolean => {
    const session = globalManager.reattachSession(
      sessionId,
      (sid, data) => {
        pacer.push(sid, data);
        promptDetector.feed(sid, data);
        screenPromptWatcher.poke(sid);
        idleDetector.activity(sid);
        scheduleCwdCheck(ws, sid);
        resetAutopilotTimer(sid);
      },
      (sid, exitCode) => {
        ownedSessions.delete(sid);
        promptDetector.unwatch(sid);
        screenPromptWatcher.unwatch(sid);
        lastQuestionPush.delete(sid);
        idleDetector.unwatch(sid);
        clearCwdCheck(sid);
        aiSessions.delete(sid);
        autopilotService.clearSession(sid);
        const apTimer = autopilotTimers.get(sid);
        if (apTimer) { clearTimeout(apTimer); autopilotTimers.delete(sid); }
        flushPaced(sid);
        send(ws, { type: 'terminal:closed', sessionId: sid, payload: { exitCode } });
        forgetTitle(sid);
      },
      clientCols,
      clientRows,
      clientFresh,
    );
    if (!session) return false;

    ownedSessions.add(session.id);
    sessionGens.set(session.id, globalManager.getAttachGen(session.id));
    idleDetector.unwatch(session.id);
    watchSession(session.id, true); // reattach=true: Startphase & Dedup des Erkenners bleiben erhalten
    watchSessionIdle(session.id);
    send(ws, {
      type: 'terminal:reattached',
      sessionId: session.id,
      payload: { cols: session.cols, rows: session.rows, cwd: session.cwd, processName: session.processName },
    });
    pushInitialCwd(ws, session.id);
    return true;
  };

  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn(`Invalid JSON from ${ip}`);
      return;
    }

    // ── Rate limiting ────────────────────────────────────────────────
    if (!rateLimiter.consume(msg.type)) {
      // Drops are rare with the generous buckets — but a silently dropped
      // create/reattach would leave a ghost card and a dropped transcribe a
      // stuck spinner, so those get an explicit error back.
      if (msg.type === 'terminal:create' || msg.type === 'terminal:reattach') {
        send(ws, { type: 'terminal:error', sessionId: (msg as { sessionId?: string }).sessionId ?? 'none', payload: { message: 'Zu viele Anfragen — bitte kurz warten' } });
      } else if (msg.type === 'audio:transcribe') {
        send(ws, { type: 'audio:error', sessionId: (msg as { sessionId?: string }).sessionId ?? 'none', payload: { message: 'Zu viele Anfragen — bitte kurz warten' } });
      }
      return;
    }

    if (msg.type === 'client:backgrounding') {
      logger.info(`Client backgrounding — detaching all sessions (${ownedSessions.size} sessions)`);
      for (const sessionId of ownedSessions) {
        const gen = sessionGens.get(sessionId);
        globalManager.detachSession(sessionId, gen, pacer.take(sessionId));
      }
      // Do NOT close the WebSocket — the client will close it from their side
      return;
    }

    if (msg.type === 'client:set_ai_session') {
      const sid = msg.sessionId;
      const hasAi = !!msg.payload?.hasAi;
      if (typeof sid === 'string') {
        if (hasAi) aiSessions.add(sid);
        else aiSessions.delete(sid);
        logger.info(`AI session ${hasAi ? 'registered' : 'unregistered'}: ${sid.slice(0, 8)}`);
      }
      return;
    }

    if (msg.type === 'client:set_auto_approve') {
      const sid = msg.sessionId;
      const enabled = !!msg.payload?.enabled;
      if (typeof sid === 'string') {
        setAutoApprove(sid, enabled);
        // Sofort sichern statt bis zum 30-Sekunden-Takt zu warten: ein Neustart
        // dazwischen brächte das Terminal mit stillem Auto-Approve zurück.
        captureSoon();
        // Track AI sessions for autopilot — auto-approve is only used on AI terminals
        if (enabled) aiSessions.add(sid);
        else aiSessions.delete(sid);
        logger.info(`Auto-approve ${enabled ? 'enabled' : 'disabled'} for session ${sid.slice(0, 8)}`);
      }
      return;
    }

    if (msg.type === 'client:rtt') {
      const rtt = msg.payload?.rtt;
      if (typeof rtt === 'number' && rtt > 0 && rtt < 30000) {
        for (const sessionId of ownedSessions) {
          globalManager.setSessionRtt(sessionId, rtt);
        }
      }
      return;
    }

    if (msg.type === 'client:set_idle_threshold') {
      const seconds = msg.payload?.seconds;
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
    if (msg.type === 'autopilot:optimize') {
      const { items, cwd } = msg.payload ?? {};
      const sessionId = msg.sessionId;
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
          send(ws, { type: 'autopilot:optimized', sessionId, payload: { id, optimizedPrompt: result.prompt } });
        } else {
          autopilotService.updateItem(sessionId, id, { status: 'error', error: result.error });
          send(ws, { type: 'autopilot:optimize_error', sessionId, payload: { id, error: result.error } });
        }
      });
      return;
    }

    if (msg.type === 'autopilot:add_item') {
      const sessionId = msg.sessionId;
      const item = msg.payload;
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

    if (msg.type === 'autopilot:remove_item') {
      const sessionId = msg.sessionId;
      const itemId = msg.payload?.id;
      if (sessionId && itemId) {
        autopilotService.removeItem(sessionId, itemId);
      }
      return;
    }

    if (msg.type === 'autopilot:update_item') {
      const sessionId = msg.sessionId;
      const { id, ...updates } = msg.payload ?? {};
      if (sessionId && id) {
        autopilotService.updateItem(sessionId, id, updates);
      }
      return;
    }

    if (msg.type === 'autopilot:reorder') {
      const sessionId = msg.sessionId;
      const itemIds = msg.payload?.itemIds;
      if (sessionId && Array.isArray(itemIds)) {
        autopilotService.reorderQueue(sessionId, itemIds);
      }
      return;
    }

    if (msg.type === 'autopilot:queue_toggle') {
      const sessionId = msg.sessionId;
      const enabled = !!msg.payload?.enabled;
      if (sessionId) {
        autopilotService.setEnabled(sessionId, enabled);
        logger.info(`Autopilot queue ${enabled ? 'enabled' : 'disabled'} for ${sessionId.slice(0, 8)}`);
      }
      return;
    }

    // ── File Upload from mobile app ───────────────────────────────
    if (msg.type === 'client:file_upload') {
      const { filename, data, mimeType } = msg.payload ?? {};
      if (typeof filename === 'string' && typeof data === 'string') {
        try {
          const uploadDir = path.join(os.homedir(), '.tms-terminal', 'uploads');
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(uploadDir, `${Date.now()}_${safeName}`);
          fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
          logger.info(`File upload: ${safeName} (${mimeType}) → ${filePath}`);
          send(ws, { type: 'client:file_uploaded', payload: { path: filePath, filename: safeName } });
        } catch (err) {
          logger.warn(`File upload failed: ${err}`);
        }
      }
      return;
    }

    // ── App State tracking ──────────────────────────────────────────
    if (msg.type === 'client:app_state') {
      const { foreground } = msg.payload ?? {};
      logger.info(`App state: ${foreground ? 'foreground' : 'background'}`);
      return;
    }
    if (msg.type === 'client:active_tab') {
      return;
    }
    // What the app is showing right now — drives the output pacer.
    // focus: null = several terminals visible / unknown, '' = none, id = that one in front.
    if (msg.type === 'client:attention') {
      const p: { foreground?: unknown; focus?: unknown } = msg.payload ?? {};
      pacer.setAttention(p.foreground !== false, typeof p.focus === 'string' ? p.focus : null);
      activityFeed.setForeground(p.foreground !== false);
      // Back on screen: sessions handed over meanwhile are attached again —
      // the reattach sends their current picture (they have missed output).
      if (p.foreground !== false && heldDetached.size > 0) {
        const back = [...heldDetached];
        heldDetached.clear();
        for (const sid of back) {
          if (ownedSessions.has(sid) && globalManager.isDetached(sid)) attachToThisClient(sid);
        }
      }
      return;
    }

    if (msg.type === 'clipboard:list') {
      send(ws, { type: 'clipboard:history', payload: { items: clipboardHub.list() } });
      return;
    }
    if (msg.type === 'clipboard:push') {
      const text = msg.payload?.text;
      if (typeof text === 'string') clipboardHub.addFromPhone(text);
      return;
    }
    if (msg.type === 'clipboard:use' || msg.type === 'clipboard:delete') {
      const id = msg.payload?.id;
      if (typeof id !== 'string') return;
      if (msg.type === 'clipboard:use') clipboardHub.use(id); else clipboardHub.remove(id);
      return;
    }
    if (msg.type === 'clipboard:clear') {
      clipboardHub.clear();
      return;
    }

    if (msg.type === 'speech:speak') {
      // Satz für Satz erzeugen und sofort schicken — die App spielt schon,
      // während der nächste Satz entsteht (voice/run.ts).
      const reqId = String(msg.payload?.reqId ?? '').slice(0, 64);
      const parts = Array.isArray(msg.payload?.parts) ? msg.payload.parts.filter((x): x is string => typeof x === 'string').slice(0, 400) : [];
      stopSpeech();
      if (!reqId) return;
      if (!voiceAvailable()) { send(ws, { type: 'speech:error', payload: { reqId, message: 'unavailable' } }); return; }
      const run = startSpeechRun(parts, synthesize,
        (c) => send(ws, { type: 'speech:audio', payload: { reqId, seq: c.seq, index: c.index, first: c.first, last: c.last, format: 'mp3', audio: c.audio.toString('base64'), ms: c.ms } }),
        (message) => { logger.warn(`[voice] ${message}`); send(ws, { type: 'speech:error', payload: { reqId, message } }); });
      speech = { reqId, run };
      void run.done.then(() => { if (speech?.run === run) speech = null; });
      return;
    }
    if (msg.type === 'speech:played') {
      if (speech && speech.reqId === msg.payload?.reqId && typeof msg.payload?.seq === 'number') speech.run.played(msg.payload.seq);
      return;
    }
    if (msg.type === 'speech:stop') {
      stopSpeech();
      return;
    }

    if (msg.type === 'reader:get') {
      // Lesemodus: die letzten Antworten der KI-Sitzung in diesem Terminal —
      // aus ihrem eigenen Verlauf, nicht vom Bildschirm abgelesen. Nur auf
      // Wunsch (ein Tipp in der App), nie von selbst.
      const sid = msg.sessionId;
      const session = isValidSessionId(sid) ? globalManager.getSession(sid) : undefined;
      if (!session) { send(ws, { type: 'reader:answers', sessionId: String(sid ?? ''), payload: { answers: [], open: false, reason: 'no-claude' } }); return; }
      void readAnswers(sid, session.pty.pid).then((result) => {
        send(ws, { type: 'reader:answers', sessionId: sid, payload: result });
      });
      return;
    }

    if (msg.type === 'terminal:titles_get') {
      send(ws, { type: 'terminal:titles', payload: { titles: titleStore.all() } });
      return;
    }

    if (msg.type === 'terminal:rename') {
      const sessionId = msg.sessionId;
      const title = cleanTitle(msg.payload?.title);
      if (!isValidSessionId(sessionId) || !title || !globalManager.getSession(sessionId)) return;
      if (titleStore.set(sessionId, title)) {
        logger.info(`Titel ${sessionId.slice(0, 8)} → "${title}"`);
        broadcastTitle(sessionId, title);
      }
      return;
    }

    // ── Biometric Mac Unlock & Sudo Relay (Keychain-backed) ────────
    if (msg.type === 'mac:unlock_status') {
      void hasMacUnlockPassword().then((configured) => {
        send(ws, { type: 'mac:unlock_status', payload: { configured, supported: process.platform === 'darwin' } });
      });
      return;
    }

    if (msg.type === 'mac:unlock_setup') {
      const password = msg.payload?.password ?? '';
      void (async () => {
        if (!password) {
          send(ws, { type: 'mac:biometric_unlock_result', payload: { ok: false, mode: 'remote', error: 'Passwort darf nicht leer sein' } });
          return;
        }
        send(ws, { type: 'mac:unlock_status', payload: { configured: true, supported: process.platform === 'darwin' } });
        const saved = await setMacUnlockPassword(password);
        const configured = await hasMacUnlockPassword();
        send(ws, { type: 'mac:unlock_status', payload: { configured, supported: process.platform === 'darwin' } });
        if (!saved) {
          send(ws, { type: 'mac:biometric_unlock_result', payload: { ok: false, mode: 'remote', error: 'Speichern im Schlüsselbund fehlgeschlagen' } });
        }
      })();
      return;
    }

    if (msg.type === 'mac:biometric_unlock') {
      const mode = msg.payload?.mode === 'sudo' ? 'sudo' : 'remote';
      const sid = msg.payload?.sessionId ?? msg.sessionId;
      const inlinePassword = typeof msg.payload?.password === 'string' && msg.payload.password.length > 0
        ? msg.payload.password
        : undefined;
      void (async () => {
        if (inlinePassword) {
          await setMacUnlockPassword(inlinePassword);
          send(ws, { type: 'mac:unlock_status', payload: { configured: true, supported: process.platform === 'darwin' } });
        }
        if (mode === 'sudo') {
          if (!isValidSessionId(sid)) {
            send(ws, { type: 'mac:biometric_unlock_result', payload: { ok: false, mode: 'sudo', error: 'Keine gültige Terminal-Session' } });
            return;
          }
          const pwd = inlinePassword ?? (await getMacUnlockPassword());
          if (!pwd) {
            send(ws, { type: 'mac:biometric_unlock_result', payload: { ok: false, mode: 'sudo', error: 'Kein Mac-Passwort im Schlüsselbund hinterlegt' } });
            return;
          }
          const wrote = globalManager.write(sid, pwd + '\r');
          pendingInputLen.set(sid, 0);
          screenPromptWatcher.resolved(sid);
          promptDetector.noteApproved(sid);
          logger.info(`Biometric sudo confirmed for session ${sid.slice(0, 8)} (ok=${wrote})`);
          send(ws, { type: 'mac:biometric_unlock_result', payload: { ok: wrote, mode: 'sudo', error: wrote ? undefined : 'Session nicht gefunden' } });
          return;
        }

        const res = await unlockMacScreen();
        logger.info(`Biometric Mac screen unlock triggered (ok=${res.ok}${res.error ? `, err=${res.error}` : ''})`);
        send(ws, { type: 'mac:biometric_unlock_result', payload: { ok: res.ok, mode: 'remote', error: res.error } });
      })();
      return;
    }

    if (handleDictationMessage(dictations, msg, (m) => send(ws, m as ServerMessage))) return;
    // The dictionary of this machine: answered to the asker, changes go to every connected app.
    if (handleDictionaryMessage(dictionary, dictationStats, msg, (m) => send(ws, m as ServerMessage),
      (m) => { for (const sock of liveSockets) send(sock, m as ServerMessage); })) return;

    if (msg.type === 'audio:transcribe') {
      const sessionId = isValidSessionId(msg.sessionId) ? msg.sessionId : '__dictation__';
      const audio = msg.payload?.audio;
      const format = msg.payload?.format;

      if (typeof audio !== 'string' || audio.length === 0) {
        send(ws, { type: 'audio:error', sessionId, payload: { message: 'Keine Audiodaten empfangen' } });
        return;
      }
      if (format !== 'wav') {
        send(ws, { type: 'audio:error', sessionId, payload: { message: 'Nur WAV-Format unterstuetzt' } });
        return;
      }

      // MLX sidecar uses a single model for all lengths; no per-size model switch.
      // Keep-alive heartbeat: the app gives up after 25s without any audio
      // message, but single-chunk audio (<~72s) yields no progress events and
      // a cold sidecar start can exceed 25s. chunk 0 is
      // never emitted by the sidecar, so clients that render chunk numbers
      // skip it while the inactivity watchdogs still reset.
      const keepAlive = setInterval(() => {
        send(ws, { type: 'audio:progress', sessionId, payload: { chunk: 0, total: 0, text: '' } });
      }, 10_000);

      const legacyStartedAt = Date.now();
      whisperTranscribe(audio, {
        prompt: dictionary.prompt(),
        onProgress: (info) => {
          send(ws, { type: 'audio:progress', sessionId, payload: { chunk: info.chunk, total: info.total, text: info.text } });
        },
      }).then((raw) => {
        const text = dictionary.fix(raw);
        logger.info(`[whisper] audio:transcribe done in ${Date.now() - legacyStartedAt}ms, ${text.length} chars`);
        send(ws, { type: 'audio:transcription', sessionId, payload: { text } });
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'Transkription fehlgeschlagen';
        logger.warn(`[whisper] Transcription failed after ${Date.now() - legacyStartedAt}ms: ${message}`);
        send(ws, { type: 'audio:error', sessionId, payload: { message } });
      }).finally(() => {
        clearInterval(keepAlive);
      });
      return;
    }

    // ── TTS: Text-to-Speech synthesis ─────────────────────────────
    if (msg.type === 'tts:generate') {
      const text = msg.payload?.text;
      const messageId = msg.payload?.messageId ?? 'unknown';

      if (!text || typeof text !== 'string') {
        send(ws, { type: 'tts:error', payload: { messageId, message: 'Kein Text angegeben' } });
        return;
      }

      if (!ttsAvailable()) {
        send(ws, { type: 'tts:error', payload: { messageId, message: 'TTS nicht verfügbar. Installiere: pip install mlx-audio' } });
        return;
      }

      ttsSynthesize(text).then(({ audioBase64, durationSecs }) => {
        send(ws, { type: 'tts:result', payload: { messageId, audio: audioBase64, duration: durationSecs } });
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'TTS fehlgeschlagen';
        logger.warn(`[tts] Synthesis failed: ${message}`);
        send(ws, { type: 'tts:error', payload: { messageId, message } });
      });
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        break;

      case 'browserbridge:toggle': {
        browserBridge.setEnabled(msg.payload.enabled);
        logger.info(`Browser-Bridge: ${msg.payload.enabled ? 'ON' : 'OFF'}`);
        break;
      }

      case 'browserbridge:callback': {
        // The app's WebView hit a localhost callback; deliver it to the CLI's
        // loopback listener on the PC so the login completes (Weg A — server-relay).
        browserBridge.relayCallback(msg.payload.url)
          .then((r) => send(ws, { type: 'browserbridge:callback_result', payload: r }))
          .catch(() => send(ws, { type: 'browserbridge:callback_result', payload: { status: 0, html: '' } }));
        break;
      }

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
              pacer.push(sessionId, data);
              promptDetector.feed(sessionId, data);
              screenPromptWatcher.poke(sessionId);
              idleDetector.activity(sessionId);
              scheduleCwdCheck(ws, sessionId);
              resetAutopilotTimer(sessionId);
            },
            (sessionId, exitCode) => {
              ownedSessions.delete(sessionId);
              promptDetector.unwatch(sessionId);
              screenPromptWatcher.unwatch(sessionId);
              lastQuestionPush.delete(sessionId);
              idleDetector.unwatch(sessionId);
              clearCwdCheck(sessionId);
              aiSessions.delete(sessionId);
              autopilotService.clearSession(sessionId);
              const apTimer = autopilotTimers.get(sessionId);
              if (apTimer) { clearTimeout(apTimer); autopilotTimers.delete(sessionId); }
              flushPaced(sessionId);
              send(ws, { type: 'terminal:closed', sessionId, payload: { exitCode } });
              forgetTitle(sessionId);
            },
          );
          ownedSessions.add(session.id);
          sessionGens.set(session.id, globalManager.getAttachGen(session.id));
          watchSession(session.id);
          watchSessionIdle(session.id);
          pushInitialCwd(ws, session.id);
          send(ws, {
            type: 'terminal:created',
            sessionId: session.id,
            payload: { cols: session.cols, rows: session.rows },
          });
          // Sofort aufnehmen statt bis zum naechsten Takt zu warten: ein
          // Terminal, das kurz vor einem Absturz entsteht, waere sonst weg.
          captureSoon();
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
        // Leeres Client-Terminal (App-Kaltstart) → immer Vollbild mit Verlauf.
        const fresh = msg.payload.fresh === true;

        if (!Number.isInteger(cols) || cols < 1 || cols > 500) {
          send(ws, { type: 'terminal:error', sessionId: msg.sessionId, payload: { message: 'Invalid cols: must be integer 1-500' } });
          break;
        }
        if (!Number.isInteger(rows) || rows < 1 || rows > 200) {
          send(ws, { type: 'terminal:error', sessionId: msg.sessionId, payload: { message: 'Invalid rows: must be integer 1-200' } });
          break;
        }

        // Deduplicate rapid identical reattach storms on this same connection
        const nowAt = Date.now();
        const prevReattach = lastReattach.get(msg.sessionId);
        if (
          !fresh &&
          prevReattach &&
          nowAt - prevReattach.at < 1000 &&
          prevReattach.cols === cols &&
          prevReattach.rows === rows &&
          ownedSessions.has(msg.sessionId) &&
          !globalManager.isDetached(msg.sessionId)
        ) {
          break;
        }
        lastReattach.set(msg.sessionId, { at: nowAt, cols, rows });

        // Ein Anhänge-Pfad für alle: derselbe Helfer, den auch die Selbstheilung
        // bei Eingabe/Resize benutzt. Nur hier kennen wir die echten Maße des
        // Clients und dürfen die PTY darauf setzen.
        if (attachToThisClient(msg.sessionId, cols, rows, fresh)) {
          const session = globalManager.getSession(msg.sessionId)!;
          pendingInputLen.set(session.id, 0); // alter Zählerstand der Vorgängerverbindung
          globalManager.resize(session.id, cols, rows);

          // Autopilot-Warteschlange nachziehen — sie lief weiter, während der Client weg war.
          const queue = autopilotService.getQueue(session.id);
          for (const item of queue) {
            if (item.status === 'queued' && item.optimizedPrompt) {
              send(ws, { type: 'autopilot:optimized', sessionId: session.id, payload: { id: item.id, optimizedPrompt: item.optimizedPrompt } });
            } else if (item.status === 'done') {
              send(ws, { type: 'autopilot:prompt_done', sessionId: session.id, payload: { id: item.id } });
            } else if (item.status === 'error' && item.error) {
              send(ws, { type: 'autopilot:optimize_error', sessionId: session.id, payload: { id: item.id, error: item.error } });
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

        // Wer tippt, sieht sofort: dieses Terminal antwortet für kurze Zeit
        // ungebremst, egal was die App als „vorne" gemeldet hat.
        pacer.noteInput(msg.sessionId);

        // SELBSTHEILUNG: Eine LEBENDE Verbindung tippt in eine ABGEHÄNGTE Session.
        //
        // Das kann nur eines heißen: der Client ist wieder da, hat es aber nicht
        // gemerkt (Funkloch, stiller Socket-Tausch, Ansichtswechsel) und darum nie
        // ein terminal:reattach geschickt. Ohne Anhängen läuft sein Befehl zwar —
        // aber die gesamte Ausgabe wandert in den Detach-Puffer. Der Nutzer sieht
        // NICHTS und hält seine Nachricht für nicht abgeschickt. Genau dieser
        // Zustand war reproduzierbar: Eingabe wirkt, Ausgabe kommt nie an.
        //
        // Wer tippt, will zusehen. Also hängen wir hier an und spülen den Rückstand.
        if (globalManager.isDetached(msg.sessionId)) {
          logger.info(`Input on a detached session ${msg.sessionId.slice(0, 8)} — reattaching this client`);
          attachToThisClient(msg.sessionId);
        }

        // Track user input for auto-approve typing pause + pending input detection
        lastUserInputAt.set(msg.sessionId, Date.now());
        trackPendingInput(msg.sessionId, data);
        idleDetector.activity(msg.sessionId);
        resetAutopilotTimer(msg.sessionId);

        // Große Texte (Diktat, Zwischenablage) als EINEN Einfügeblock — sonst
        // zerteilt macOS sie und Claude Code zeigt nur noch den Rest (paste.policy.ts).
        if (!globalManager.write(msg.sessionId, asPaste(data, globalManager.wantsBracketedPaste(msg.sessionId)))) {
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

        // Auch eine Größenmeldung kommt nur von einem Client, der die Karte vor
        // Augen hat — dieselbe Selbstheilung wie bei der Eingabe. Die Maße
        // kennen wir hier: mitgeben, damit ein Breitenwechsel den veralteten
        // Puffer verwirft statt ihn in falscher Breite abzuspielen.
        if (globalManager.isDetached(msg.sessionId)) {
          logger.info(`Resize on a detached session ${msg.sessionId.slice(0, 8)} — reattaching this client`);
          attachToThisClient(msg.sessionId, cols, rows);
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

        captureSoon(); // ein geschlossenes Terminal darf nicht wiederkommen

        ownedSessions.delete(msg.sessionId);
        sessionGens.delete(msg.sessionId);
        clearAutoApprove(msg.sessionId);
        lastQuestionPush.delete(msg.sessionId);
        screenPromptWatcher.unwatch(msg.sessionId);
        lastUserInputAt.delete(msg.sessionId);
        pendingInputLen.delete(msg.sessionId);
        const retryT = approvalRetryTimers.get(msg.sessionId);
        if (retryT) { clearTimeout(retryT); approvalRetryTimers.delete(msg.sessionId); }
        promptDetector.unwatch(msg.sessionId);
        idleDetector.unwatch(msg.sessionId);
        aiSessions.delete(msg.sessionId);
        autopilotService.clearSession(msg.sessionId);
        forgetTitle(msg.sessionId);
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
    liveSockets.delete(ws);
    stopActivity();
    stopSpeech();
    logger.info(`Client disconnected: ${ip} — detaching ${ownedSessions.size} sessions (kept alive)`);

    // This was the browser-bridge target: no app connected → shim opens locally
    if (currentWs === ws) {
      currentWs = null;
      browserBridge.setNotifier(null); // no app connected → shim falls back to local open
    }

    for (const sessionId of ownedSessions) {
      const gen = sessionGens.get(sessionId);
      // What the pacer still held never reached the app — hand it over as missed output.
      globalManager.detachSession(sessionId, gen, pacer.take(sessionId));
    }
    pacer.dispose();
    ownedSessions.clear();
    sessionGens.clear();
  });

  ws.on('error', (err) => {
    logger.error(`WebSocket error from ${ip}: ${err.message}`);
    stopActivity();
    stopSpeech();
    if (currentWs === ws) currentWs = null;
    for (const sessionId of ownedSessions) {
      // Do NOT unwatch promptDetector — same rationale as ws.on('close')
      globalManager.detachSession(sessionId, undefined, pacer.take(sessionId));
    }
    pacer.dispose();
    ownedSessions.clear();
  });
}
