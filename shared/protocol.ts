// Shared WebSocket message types between server and mobile app

// ── Client → Server ──────────────────────────────────────────────

export interface TerminalCreateMessage {
  type: 'terminal:create';
  payload: { cols: number; rows: number };
}

export interface TerminalInputMessage {
  type: 'terminal:input';
  sessionId: string;
  payload: { data: string };
}

export interface TerminalResizeMessage {
  type: 'terminal:resize';
  sessionId: string;
  payload: { cols: number; rows: number };
}

export interface TerminalCloseMessage {
  type: 'terminal:close';
  sessionId: string;
}

export interface TerminalClearMessage {
  type: 'terminal:clear';
  sessionId: string;
}

export interface TerminalReattachMessage {
  type: 'terminal:reattach';
  sessionId: string;
  /** `fresh`: das Terminal des Clients ist leer (App-Kaltstart) — der Server
   *  schickt dann immer ein Vollbild mit Verlauf statt nur den Rückstand. */
  payload: { cols: number; rows: number; fresh?: boolean };
}

export interface PingMessage {
  type: 'ping';
}

export interface RegisterTokenMessage {
  type: 'client:register_token';
  payload: { token: string };
}

// ── Client control messages (Client → Server) ──────────────────
export interface ClientBackgroundingMessage {
  type: 'client:backgrounding';
}

export interface ClientSetAiSessionMessage {
  type: 'client:set_ai_session';
  sessionId: string;
  payload: { hasAi: boolean };
}

export interface ClientSetAutoApproveMessage {
  type: 'client:set_auto_approve';
  sessionId: string;
  payload: { enabled: boolean };
}

export interface ClientRttMessage {
  type: 'client:rtt';
  payload: { rtt: number };
}

/** seconds === 0 disables idle notifications entirely. */
export interface ClientSetIdleThresholdMessage {
  type: 'client:set_idle_threshold';
  payload: { seconds: number };
}

// ── System monitor messages (Client → Server) ──────────────────
export interface SystemSnapshotMessage { type: 'system:snapshot'; }
export interface SystemKillMessage     { type: 'system:kill'; payload: { pid: number; signal?: string }; }

// ── Audio messages (Client → Server) ──────────────────────────
export interface AudioTranscribeMessage {
  type: 'audio:transcribe';
  sessionId: string;
  payload: {
    audio: string;
    format: 'wav';
    /** When true, rewrite the transcript into a polished AI prompt before returning. Default: false. */
    enhance?: boolean;
  };
}

// ── Streamed dictation (Client → Server) ──────────────────────
// The app uploads the growing recording in byte-offset chunks while the user
// speaks; the server transcribes ahead. Sessions are keyed by `id`, not by
// socket, so a reconnect resumes them (see server/src/audio/dictation.ts).
/** `enhance` belonged to the removed prompt rewriter; old apps may still send it, the server ignores it. */
export interface DictationStartMessage  { type: 'dictation:start';  payload: { id: string; format: 'adts' | 'file'; enhance?: boolean } }
export interface DictationChunkMessage  { type: 'dictation:chunk';  payload: { id: string; offset: number; data: string } }
export interface DictationEndMessage    { type: 'dictation:end';    payload: { id: string; totalBytes: number } }
export interface DictationCancelMessage { type: 'dictation:cancel'; payload: { id: string } }
export interface DictationResumeMessage { type: 'dictation:resume'; payload: { id: string } }

// ── Dictation dictionary (settings page ⇄ the machine that transcribes) ──
// Every request is answered with `dict:state`; a change goes to all connected apps.
export interface DictGetMessage    { type: 'dict:get';    payload?: Record<string, never> }
export interface DictAddMessage    { type: 'dict:add';    payload: { term: string } }
export interface DictUpdateMessage { type: 'dict:update'; payload: { id: string; term?: string; heard?: string[] } }
export interface DictRemoveMessage { type: 'dict:remove'; payload: { id: string } }

// ── File Upload (Client → Server) ────────────────────────────────
export interface FileUploadMessage {
  type: 'client:file_upload';
  payload: { filename: string; data: string; /* base64 */ mimeType: string };
}

// ── App State (Client → Server) ──────────────────────────────────
export interface AppStateMessage {
  type: 'client:app_state';
  payload: { foreground: boolean };
}
/**
 * What the app is showing — the server paces terminal output by it
 * (server/src/websocket/output.pacer.ts). focus: null = several terminals
 * visible, '' = none, otherwise the session in front.
 */
export interface AttentionMessage {
  type: 'client:attention';
  payload: { foreground: boolean; focus: string | null };
}
export interface ActiveTabMessage {
  type: 'client:active_tab';
  payload: { tabId: string; sessionId?: string };
}
// Browser-Bridge (terminal→app browser). See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
export interface BrowserBridgeToggleMessage {
  type: 'browserbridge:toggle';
  payload: { enabled: boolean };
}
export interface BrowserBridgeCallbackMessage {
  type: 'browserbridge:callback';
  payload: { url: string; sessionId: string };
}

// ── Autopilot messages (Client → Server) ──────────────────────
export type AutopilotItemStatus = 'draft' | 'optimizing' | 'queued' | 'running' | 'done' | 'error';

export interface AutopilotOptimizeMessage {
  type: 'autopilot:optimize';
  sessionId: string;
  payload: { items: Array<{ id: string; text: string }>; cwd: string };
}

export interface AutopilotAddItemMessage {
  type: 'autopilot:add_item';
  sessionId: string;
  payload: {
    id: string;
    text: string;
    status?: AutopilotItemStatus;
    optimizedPrompt?: string;
  };
}

export interface AutopilotRemoveItemMessage {
  type: 'autopilot:remove_item';
  sessionId: string;
  payload: { id: string };
}

export interface AutopilotUpdateItemMessage {
  type: 'autopilot:update_item';
  sessionId: string;
  payload: {
    id: string;
    text?: string;
    optimizedPrompt?: string;
    status?: AutopilotItemStatus;
    error?: string;
    completedAt?: number;
  };
}

export interface AutopilotReorderMessage {
  type: 'autopilot:reorder';
  sessionId: string;
  payload: { itemIds: string[] };
}

export interface AutopilotQueueToggleMessage {
  type: 'autopilot:queue_toggle';
  sessionId: string;
  payload: { enabled: boolean };
}

// ── Terminal titles (Client → Server) ──────────────────────────
export interface TerminalTitlesGetMessage {
  type: 'terminal:titles_get';
}

// ── Voice: read aloud in the cloned voice (Client → Server) ────
/** Speak these parts (heading, paragraph, list item …), sentence by sentence. */
export interface SpeechSpeakMessage {
  type: 'speech:speak';
  payload: { reqId: string; parts: string[] };
}
/** The phone started playing piece `seq` — the server stays only a few pieces ahead. */
export interface SpeechPlayedMessage {
  type: 'speech:played';
  payload: { reqId: string; seq: number };
}
export interface SpeechStopMessage {
  type: 'speech:stop';
  payload: { reqId?: string };
}

// ── Reader (Client → Server) ───────────────────────────────────
/** Ask for the last answers of the AI session running in a terminal. */
export interface ReaderGetMessage {
  type: 'reader:get';
  sessionId: string;
}

export interface TerminalRenameMessage {
  type: 'terminal:rename';
  sessionId: string;
  payload: { title: string };
}

// ── Shared clipboard (Client → Server) ─────────────────────────
export interface ClipboardListMessage { type: 'clipboard:list'; }
export interface ClipboardPushMessage { type: 'clipboard:push'; payload: { text: string }; }
/** Put an older entry back on top and onto the Mac's pasteboard. */
export interface ClipboardUseMessage { type: 'clipboard:use'; payload: { id: string }; }
export interface ClipboardDeleteMessage { type: 'clipboard:delete'; payload: { id: string }; }
export interface ClipboardClearMessage { type: 'clipboard:clear'; }

// ── TTS (Client → Server) ──────────────────────────────────────
export interface TtsGenerateMessage {
  type: 'tts:generate';
  payload: { text: string; messageId: string };
}

// ── Biometric Mac Unlock & Sudo Relay (Client → Server) ────────
export interface MacUnlockStatusRequestMessage {
  type: 'mac:unlock_status';
}

export interface MacUnlockSetupMessage {
  type: 'mac:unlock_setup';
  payload: { password: string };
}

export interface MacBiometricUnlockMessage {
  type: 'mac:biometric_unlock';
  sessionId?: string;
  payload: { mode: 'remote' | 'sudo'; sessionId?: string; password?: string };
}

export type ClientMessage =
  | TerminalCreateMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalCloseMessage
  | TerminalClearMessage
  | TerminalReattachMessage
  | PingMessage
  | RegisterTokenMessage
  | SystemSnapshotMessage
  | SystemKillMessage
  | AudioTranscribeMessage
  | DictationStartMessage
  | DictationChunkMessage
  | DictationEndMessage
  | DictationCancelMessage
  | DictationResumeMessage
  | DictGetMessage
  | DictAddMessage
  | DictUpdateMessage
  | DictRemoveMessage
  | FileUploadMessage
  | AppStateMessage
  | AttentionMessage
  | ReaderGetMessage
  | SpeechSpeakMessage
  | SpeechPlayedMessage
  | SpeechStopMessage
  | ActiveTabMessage
  | BrowserBridgeToggleMessage
  | BrowserBridgeCallbackMessage
  | ClientBackgroundingMessage
  | ClientSetAiSessionMessage
  | ClientSetAutoApproveMessage
  | ClientRttMessage
  | ClientSetIdleThresholdMessage
  | AutopilotOptimizeMessage
  | AutopilotAddItemMessage
  | AutopilotRemoveItemMessage
  | AutopilotUpdateItemMessage
  | AutopilotReorderMessage
  | AutopilotQueueToggleMessage
  | TerminalTitlesGetMessage
  | TerminalRenameMessage
  | ClipboardListMessage
  | ClipboardPushMessage
  | ClipboardUseMessage
  | ClipboardDeleteMessage
  | ClipboardClearMessage
  | TtsGenerateMessage
  | MacUnlockStatusRequestMessage
  | MacUnlockSetupMessage
  | MacBiometricUnlockMessage;

// ── Server → Client ──────────────────────────────────────────────

export interface TerminalCreatedMessage {
  type: 'terminal:created';
  sessionId: string;
  payload: {
    cols: number;
    rows: number;
    label?: string;
  };
}

export interface TerminalOutputMessage {
  type: 'terminal:output';
  sessionId: string;
  payload: { data: string };
}

export interface TerminalClosedMessage {
  type: 'terminal:closed';
  sessionId: string;
  payload: { exitCode: number };
}

export interface TerminalErrorMessage {
  type: 'terminal:error';
  sessionId: string;
  payload: { message: string };
}

export interface TerminalReattachedMessage {
  type: 'terminal:reattached';
  sessionId: string;
  payload: {
    cols: number;
    rows: number;
    /** Working directory at the time the client last disconnected. */
    cwd?: string;
    /** Foreground process name at the time the client last disconnected. */
    processName?: string;
  };
}

export interface TerminalProcessMessage {
  type: 'terminal:process';
  sessionId: string;
  /** Foreground program, pushed when a full-screen TUI starts (alternate screen).
   *  Lets the page force mouse mode for OpenCode even when ConPTY (Windows)
   *  swallowed the program's own DECSET mouse sequences. */
  payload: { processName: string };
}

export interface TerminalCwdMessage {
  type: 'terminal:cwd';
  sessionId: string;
  /** Working directory, home-normalized to `~`. Pushed live when it changes. */
  payload: { cwd: string };
}

export interface TerminalPromptDetectedMessage {
  type: 'terminal:prompt_detected';
  sessionId: string;
  payload: {
    snippet: string;
    hasPendingInput?: boolean;
    /** Einstufung des Servers (prompt.classifier.ts) — auf dem echten
     *  Bildschirm ermittelt. Die App rät sie nicht mehr aus dem Textschnipsel. */
    kind?: 'permission' | 'confirm' | 'question' | 'sudo';
  };
}

export interface PongMessage {
  type: 'pong';
}

// ── Terminal titles (Server → Client) ──────────────────────────
/** Full title map — sent on connect and in answer to terminal:titles_get. */
export interface TerminalTitlesMessage {
  type: 'terminal:titles';
  payload: { titles: Record<string, string> };
}

// ── Voice (Server → Client) ────────────────────────────────────
/** One spoken piece (about a sentence), sent the moment it exists. */
export interface SpeechAudioMessage {
  type: 'speech:audio';
  payload: {
    reqId: string;
    seq: number;
    /** Which part of the request this belongs to. */
    index: number;
    /** First piece of that part. */
    first: boolean;
    /** Nothing follows. */
    last: boolean;
    format: 'mp3';
    /** base64; empty when there was nothing to speak. */
    audio: string;
    ms: number;
  };
}
export interface SpeechErrorMessage {
  type: 'speech:error';
  payload: { reqId: string; message: string };
}

// ── Activity + reader (Server → Client) ────────────────────────
/** What a terminal's AI tool is working on, read from the title it sets. */
export interface TerminalActivity {
  /** The topic in the tool's own words; '' when it names none. */
  task: string;
  state: 'working' | 'waiting' | 'done';
}
/**
 * Changed activities (null = none any more). The full state on connect, then
 * only real changes; nothing at all while the app is not on screen.
 */
export interface TerminalActivityMessage {
  type: 'terminal:activity';
  payload: {
    activities: Record<string, TerminalActivity | null>;
    /** The whole state (sent on connect): sessions missing from it have no activity. */
    full?: boolean;
  };
}
export interface ReaderAnswer {
  /** What the user typed for this round; '' when it was not started by typing. */
  prompt: string;
  /** The answer as Markdown, exactly as written. */
  md: string;
  /** ms since epoch, 0 if unknown. */
  at: number;
}
/** Answer to reader:get — newest answer last. */
export interface ReaderAnswersMessage {
  type: 'reader:answers';
  sessionId: string;
  payload: {
    answers: ReaderAnswer[];
    /** A round is running: its answer does not exist yet. */
    open: boolean;
    /** Why there is nothing to read. */
    reason?: 'no-claude' | 'no-transcript' | 'empty' | 'error';
  };
}

/** One title changed — broadcast to every connected app (title null = removed). */
export interface TerminalTitleMessage {
  type: 'terminal:title';
  sessionId: string;
  payload: { title: string | null };
}

// ── System responses (Server → Client) ──────────────────────────
export interface SystemKillResultMessage {
  type: 'system:kill_result';
  payload: { pid: number; success: boolean; message?: string };
}

// ── Audio responses (Server → Client) ──────────────────────────
export interface AudioTranscriptionMessage {
  type: 'audio:transcription';
  sessionId: string;
  payload: { text: string };
}

export interface AudioProgressMessage {
  type: 'audio:progress';
  sessionId: string;
  payload: { chunk: number; total: number; text: string };
}

export type DictationStatusName = 'receiving' | 'processing' | 'done' | 'error' | 'unknown';
export interface DictationAckMessage      { type: 'dictation:ack';      payload: { id: string; bytes: number } }
export interface DictationStateMessage    { type: 'dictation:state';    payload: { id: string; status: DictationStatusName; bytes: number; text?: string; message?: string } }
export interface DictationProgressMessage { type: 'dictation:progress'; payload: { id: string } }
export interface DictationResultMessage   { type: 'dictation:result';   payload: { id: string; text: string } }
export interface DictationErrorMessage    { type: 'dictation:error';    payload: { id: string; message: string } }

/** A dictionary entry: the right spelling and the ways it gets misheard. */
export interface DictEntryPayload { id: string; term: string; heard: string[]; source: 'seed' | 'manual' | 'learned'; uses: number; createdAt: number; /** fits into what the transcriber is told to listen for */ inPrompt?: boolean }
/** Stop -> text of the last dictations in ms (oldest first), their median and the share within 700ms. */
export interface DictSpeedPayload { count: number; medianMs: number; under700: number; waits: number[] }
export interface DictStateMessage { type: 'dict:state'; payload: { entries: DictEntryPayload[]; speed: DictSpeedPayload } }

export interface AudioErrorMessage {
  type: 'audio:error';
  sessionId: string;
  payload: { message: string };
}

// ── TTS (Text-to-Speech) ────────────────────────────────
export interface TTSResultMessage {
  type: 'tts:result';
  payload: { messageId: string; audio: string; /* base64 WAV */ duration: number };
}

export interface TTSErrorMessage {
  type: 'tts:error';
  payload: { messageId: string; message: string };
}

// ── System snapshot response (Server → Client) ──────────────────
export interface SystemSnapshotResponseMessage {
  type: 'system:snapshot';
  payload: {
    system: {
      cpuPercent: number;
      memPercent: number;
      memUsedMB: number;
      memTotalMB: number;
      diskPercent: number;
      uptime: string;
      loadAvg: number[];
    };
    processes: Array<{
      pid: number;
      name: string;
      cpu: number;
      mem: number;
      user: string;
    }>;
  };
}

// ── Shared clipboard (Server → Client) ─────────────────────────
export interface ClipboardItem {
  id: string;
  text: string;
  source: 'mac' | 'phone';
  at: number;
}

export interface ClipboardHistoryMessage {
  type: 'clipboard:history';
  payload: { items: ClipboardItem[] };
}

/** Broadcast on every change: the new top item plus the ids that dropped out. */
export interface ClipboardAddedMessage {
  type: 'clipboard:added';
  payload: { item: ClipboardItem; removed: string[] };
}

export interface ClipboardRemovedMessage {
  type: 'clipboard:removed';
  payload: { ids: string[] };
}

// ── File upload confirmation (Server → Client) ─────────────────
export interface ClientFileUploadedMessage {
  type: 'client:file_uploaded';
  payload: { path: string; filename: string };
}

// ── Autopilot responses (Server → Client) ──────────────────────
export interface AutopilotOptimizedMessage {
  type: 'autopilot:optimized';
  sessionId: string;
  payload: { id: string; optimizedPrompt: string };
}

export interface AutopilotOptimizeErrorMessage {
  type: 'autopilot:optimize_error';
  sessionId: string;
  /** error may be absent if the optimizer failed without a message (JSON.stringify drops undefined). */
  payload: { id: string; error?: string };
}

export interface AutopilotPromptSentMessage {
  type: 'autopilot:prompt_sent';
  sessionId: string;
  payload: { id: string };
}

export interface AutopilotPromptDoneMessage {
  type: 'autopilot:prompt_done';
  sessionId: string;
  payload: { id: string };
}

// ── Biometric Mac Unlock & Sudo Relay (Server → Client) ────────
export interface MacUnlockStatusMessage {
  type: 'mac:unlock_status';
  payload: { configured: boolean; supported: boolean };
}

export interface MacBiometricUnlockResultMessage {
  type: 'mac:biometric_unlock_result';
  sessionId?: string;
  payload: { ok: boolean; mode: 'remote' | 'sudo'; error?: string };
}

// Browser-Bridge (terminal→app browser). See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
export interface BrowserBridgeOpenMessage {
  type: 'browserbridge:open';
  payload: { url: string; host: string; sessionId: string };
}
export interface BrowserBridgeCallbackResultMessage {
  type: 'browserbridge:callback_result';
  payload: { status: number; html: string };
}

export type ServerMessage =
  | DictationAckMessage
  | DictationStateMessage
  | DictationProgressMessage
  | DictationResultMessage
  | DictationErrorMessage
  | DictStateMessage
  | TerminalCreatedMessage
  | TerminalOutputMessage
  | TerminalClosedMessage
  | TerminalErrorMessage
  | TerminalReattachedMessage
  | TerminalCwdMessage
  | TerminalProcessMessage
  | TerminalPromptDetectedMessage
  | PongMessage
  | SystemSnapshotResponseMessage
  | SystemKillResultMessage
  | AudioTranscriptionMessage
  | AudioProgressMessage
  | AudioErrorMessage
  | TTSResultMessage
  | TTSErrorMessage
  | BrowserBridgeOpenMessage
  | BrowserBridgeCallbackResultMessage
  | TerminalTitlesMessage
  | TerminalActivityMessage
  | ReaderAnswersMessage
  | SpeechAudioMessage
  | SpeechErrorMessage
  | TerminalTitleMessage
  | ClipboardHistoryMessage
  | ClipboardAddedMessage
  | ClipboardRemovedMessage
  | ClientFileUploadedMessage
  | AutopilotOptimizedMessage
  | AutopilotOptimizeErrorMessage
  | AutopilotPromptSentMessage
  | AutopilotPromptDoneMessage
  | MacUnlockStatusMessage
  | MacBiometricUnlockResultMessage;

// ── Remote access (its own WebSocket connection on /remote) ──────────
// Deliberately not part of ClientMessage/ServerMessage: video and input travel
// over a second connection that the page opens itself inside the WebView.

export type RemoteErrorCode =
  | 'permission_screen'
  | 'permission_input'
  | 'capture_unavailable'
  | 'helper_crashed'
  | 'disabled'
  | 'unsupported_platform'
  /** The display went to sleep — ScreenCaptureKit then reports no display at
   *  all. Its own code because that otherwise looks like a permission problem,
   *  sending the user hunting in System Settings for a checkbox that's already set. */
  | 'display_asleep'
  /** Starting the capture failed for a reason without its own code — the
   *  message says why. (capture_unavailable used to cover this too, and the
   *  app shows a fixed "ffmpeg missing" sentence for that one, hiding the
   *  real reason; unknown codes make every app version show the message.) */
  | 'capture_failed';

export type RemoteQualityPreset = 'sparsam' | 'auto' | 'scharf';

export interface RemoteStartMessage {
  type: 'remote:start';
  /** localCursor: the app draws the pointer itself (see remote:cursor).
   *  audio: play the computer's sound on the phone (muted on the computer).
   *  curtain: black screen + dimmed backlight on the computer while connected. */
  payload: { maxWidth: number; fps: number; bitrateKbps: number; localCursor?: boolean; audio?: boolean; curtain?: boolean };
}
export interface RemoteStopMessage { type: 'remote:stop' }
export interface RemoteKeyframeMessage { type: 'remote:keyframe' }
/** Sent by the app for every frame it receives (ts = the frame header's
 *  timestamp). The server bounds its queueing delay with these — see
 *  server/src/remote/flow.ts. Older apps don't send it; the server then keeps
 *  its buffer-size fallback. */
export interface RemoteAckMessage { type: 'remote:ack'; payload: { ts: number } }

// There is deliberately no `remote:quality` client message: the app switches
// quality tiers by sending remote:stop followed by remote:start with the new
// tier's options (ffmpeg on Windows can't change bitrate mid-stream, so a
// restart is required either way — see bridge.js's TMSRemote.setQuality).
// A dedicated message type and server-side handler for this existed early on
// but that code path was never reachable from the app; removed rather than
// left as dead code nobody could exercise.
/** The app shows the picture (true) or not (false: other screen, app in the
 *  background). Hidden = the session keeps running on the computer (screen
 *  off, sound on the phone ...), only the picture isn't sent. Older servers
 *  ignore it. */
export interface RemoteViewMessage { type: 'remote:view'; payload: { visible: boolean } }
export type RemoteClientMessage =
  | RemoteStartMessage | RemoteStopMessage | RemoteKeyframeMessage | RemoteAckMessage | RemoteViewMessage;

export interface RemoteStartedMessage {
  type: 'remote:started';
  /** localCursor: true = the pointer is NOT in the video; draw it from remote:cursor. */
  /** keyframeOnDemand: false = remote:keyframe can't be honoured (Windows) — the app should drop less. */
  payload: { width: number; height: number; scale: number; fps: number; codec: 'avc1'; localCursor?: boolean; keyframeOnDemand?: boolean; unlock?: boolean;
    /** What actually runs — the app shows it, a request alone is no promise. */
    audio?: boolean; curtain?: boolean };
}
/** Pointer position on the Mac, normalized 0..1 — only after a localCursor start. */
export interface RemoteCursorMessage { type: 'remote:cursor'; payload: { x: number; y: number } }
/** Mac lock screen state changed — lets the app surface a 1-tap fingerprint unlock button. */
export interface RemoteLockedMessage { type: 'remote:locked'; payload: { locked: boolean } }
export interface RemoteStoppedMessage {
  type: 'remote:stopped';
  payload: { reason: string };
}
export interface RemoteErrorMessage {
  type: 'remote:error';
  payload: { code: RemoteErrorCode; message: string };
}
export interface RemoteStatusMessage {
  type: 'remote:status';
  payload: { fps: number; kbps: number; rttMs: number; dropped: number };
}

export type RemoteServerMessage =
  | RemoteStartedMessage | RemoteStoppedMessage | RemoteErrorMessage | RemoteStatusMessage
  | RemoteCursorMessage | RemoteLockedMessage;

/** Input events: short keys, since up to 60 of these can arrive per second. */
export type RemoteInputEvent =
  | { t: 'd'; dx: number; dy: number }
  | { t: 'm'; x: number; y: number }
  | { t: 'b'; b: 'l' | 'r' | 'm'; d: boolean }
  // Scroll unit (I9): pixels of the raw touch-gesture delta, unscaled — the
  // same numbers the pointer-drag `d` event uses. macOS feeds this straight
  // into CGEvent's scroll wheel in `.pixel` units (a 1:1 match). Windows has
  // no literal pixel unit for wheel input, but its own Precision Touchpad
  // driver already sends small, sub-WHEEL_DELTA(120) mouseData values for
  // smooth scrolling — input-helper.ps1 passes this value straight through
  // as mouseData, the same idiom, rather than multiplying by 120 (which
  // treated every wire pixel as a full notch and scrolled ~120x too far).
  | { t: 's'; dx: number; dy: number }
  | { t: 'k'; c: string; d: boolean; mods: { s: boolean; c: boolean; a: boolean; m: boolean } }
  | { t: 'x'; s: string }
  // Multi-finger trackpad gesture (3+ fingers on the app's pad). The server
  // turns it into the platform's own action — see server/src/remote/gestures.ts.
  | { t: 'g'; g: RemoteGesture };

export type RemoteGesture =
  | 'swipe-left' | 'swipe-right' | 'swipe-up' | 'swipe-down' | 'pinch-in' | 'pinch-out';
