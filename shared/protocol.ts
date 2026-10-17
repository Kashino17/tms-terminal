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
  payload: { cols: number; rows: number };
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

// ── Watcher messages (Client → Server) ──────────────────────────
export interface WatcherListMessage { type: 'watcher:list'; payload: Record<string, never>; }
export interface WatcherCreateMessage { type: 'watcher:create'; payload: { id: string; type: string; label: string; enabled: boolean; config: Record<string, string> }; }
export interface WatcherUpdateMessage { type: 'watcher:update'; payload: { id: string; enabled?: boolean }; }
export interface WatcherDeleteMessage { type: 'watcher:delete'; payload: { id: string }; }
export interface WatcherTestMessage   { type: 'watcher:test';   payload: { id: string }; }

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

// ── Manager messages (Client → Server) ────────────────────────────
export interface ManagerChatMessage {
  type: 'manager:chat';
  payload: { text: string; targetSessionId?: string; onboarding?: boolean };
}
export interface ManagerCancelMessage {
  type: 'manager:cancel';
}
export interface ManagerToggleMessage {
  type: 'manager:toggle';
  payload: { enabled: boolean };
}
export interface ManagerSetProviderMessage {
  type: 'manager:set_provider';
  /** contextLength: desired context size when loading a local (LM Studio) model. */
  payload: { providerId: string; contextLength?: number };
}
export interface ManagerPollMessage {
  type: 'manager:poll';
  payload?: { targetSessionId?: string };
}
export interface ManagerSetApiKeyMessage {
  type: 'manager:set_api_key';
  payload: { providerId: string; apiKey: string };
}
export interface ManagerMemoryReadMessage {
  type: 'manager:memory_read';
}
export interface ManagerMemoryWriteMessage {
  type: 'manager:memory_write';
  payload: { section: string; data: unknown };
}
export interface ManagerAgendaMessage {
  type: 'manager:agenda';
  payload: { action: 'list' | 'add' | 'update' | 'delete'; args?: Record<string, string> };
}
export interface ManagerEntriesMessage {
  type: 'manager:entries';
  payload: { action: 'list' | 'add' | 'complete' | 'reopen' | 'update' | 'delete'; args?: Record<string, string> };
}
export interface ManagerOverviewMessage {
  type: 'manager:overview';
}
export interface ManagerOutboxReadMessage {
  type: 'manager:outbox_read';
}
/** Pure query for the provider/model list — does not start or stop the manager. */
export interface ManagerGetProvidersMessage {
  type: 'manager:get_providers';
}
export interface ManagerSetPersonalityMessage {
  type: 'manager:set_personality';
  payload: {
    agentName?: string;
    tone?: string;
    detail?: string;
    emojis?: boolean;
    proactive?: boolean;
    customInstruction?: string;
  };
}
/** Client pushes its tab labels so the manager can address terminals by name. */
export interface ManagerSyncLabelsMessage {
  type: 'manager:sync_labels';
  payload: { labels: Array<{ sessionId: string; name: string }> };
}

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
  | WatcherListMessage
  | WatcherCreateMessage
  | WatcherUpdateMessage
  | WatcherDeleteMessage
  | WatcherTestMessage
  | SystemSnapshotMessage
  | SystemKillMessage
  | AudioTranscribeMessage
  | ManagerChatMessage
  | ManagerCancelMessage
  | ManagerToggleMessage
  | ManagerSetProviderMessage
  | ManagerPollMessage
  | ManagerSetApiKeyMessage
  | ManagerMemoryReadMessage
  | ManagerMemoryWriteMessage
  | ManagerAgendaMessage
  | ManagerEntriesMessage
  | ManagerOverviewMessage
  | ManagerOutboxReadMessage
  | ManagerGetProvidersMessage
  | ManagerSetPersonalityMessage
  | ManagerSyncLabelsMessage
  | FileUploadMessage
  | AppStateMessage
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
    /** true when the Manager Agent (not the app) opened this terminal. */
    fromManager?: boolean;
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

/** One title changed — broadcast to every connected app (title null = removed). */
export interface TerminalTitleMessage {
  type: 'terminal:title';
  sessionId: string;
  payload: { title: string | null };
}

// ── Watcher responses (Server → Client) ──────────────────────────
export interface WatcherListResponseMessage {
  type: 'watcher:list';
  payload: { watchers: Array<{ id: string; type: string; label: string; enabled: boolean; config: Record<string, string> }> };
}

export interface WatcherCreatedMessage {
  type: 'watcher:created';
  payload: { id: string; type: string; label: string; enabled: boolean; config: Record<string, string> };
}

export interface WatcherUpdatedMessage {
  type: 'watcher:updated';
  payload: { id: string; enabled: boolean };
}

export interface WatcherDeletedMessage {
  type: 'watcher:deleted';
  payload: { id: string };
}

export interface WatcherTestResultMessage {
  type: 'watcher:test_result';
  payload: { id: string; success: boolean; message?: string };
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

// ── Manager responses (Server → Client) ──────────────────────────
export interface ManagerSummaryMessage {
  type: 'manager:summary';
  payload: {
    text: string;
    sessions: Array<{ sessionId: string; label: string; hasActivity: boolean }>;
    timestamp: number;
  };
}
export interface ManagerResponseMessage {
  type: 'manager:response';
  payload: {
    text: string;
    actions?: Array<{ type: string; sessionId: string; detail: string }>;
  };
}
export interface ManagerProvidersMessage {
  type: 'manager:providers';
  payload: {
    providers: Array<{
      id: string;
      name: string;
      configured: boolean;
      isLocal?: boolean;
      modelType?: string;
      /** Local (LM Studio) models only — live info from the model discovery,
       *  the app builds its context slider from these. */
      modelKey?: string;
      maxContext?: number;
      loadedContext?: number | null;
      loaded?: boolean;
      available?: boolean;
      savedContext?: number;
    }>;
    active: string;
  };
}
export interface ManagerErrorMessage {
  type: 'manager:error';
  payload: { message: string };
}
export interface ManagerStatusMessage {
  type: 'manager:status';
  payload: { enabled: boolean };
}
export interface ManagerMemoryDataMessage {
  type: 'manager:memory_data';
  payload: { memory: unknown };
}
export interface ManagerAgendaDataMessage {
  type: 'manager:agenda_data';
  payload: {
    items: Array<{
      id: string; title: string; note?: string; at: string; allDay: boolean;
      repeat: string; reminderOffsets: number[]; occurrenceAt: number;
    }>;
  };
}
export interface ManagerEntriesDataMessage {
  type: 'manager:entries_data';
  payload: {
    entries: Array<{
      id: string; text: string; checkable: boolean; done: boolean;
      due?: string; project?: string; updatedAt: number;
    }>;
  };
}
export interface ManagerProactiveMessage {
  type: 'manager:proactive';
  payload: {
    id: string; kind: string; text: string; createdAt: number;
    project?: string; sessionId?: string; unread: number;
  };
}
export interface ManagerUnreadMessage {
  type: 'manager:unread';
  payload: { unread: number };
}

// ── Manager streaming (Server → Client) ──────────────────────────
export interface PhaseInfo {
  phase: string;
  label: string;
  duration: number;
}

export interface ManagerThinkingMessage {
  type: 'manager:thinking';
  payload: { phase: string; detail?: string; elapsed?: number };
}

export interface ManagerStreamChunkMessage {
  type: 'manager:stream_chunk';
  /** completionTokens/tps: live token stats, only providers that report them. */
  payload: { token: string; completionTokens?: number; tps?: number };
}

export interface ManagerStreamEndMessage {
  type: 'manager:stream_end';
  payload: {
    text: string;
    actions?: Array<{ type: string; sessionId: string; detail: string }>;
    phases: PhaseInfo[];
    images?: string[];
    presentations?: string[];
    tasks?: Array<{ id: string; description: string; sessionLabel: string; status: string }>;
  };
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

// ── Manager extras (Server → Client) ───────────────────────────
export interface ManagerPersonalityConfiguredMessage {
  type: 'manager:personality_configured';
  payload: {
    agentName: string;
    tone: string;
    detail: string;
    emojis: boolean;
    proactive: boolean;
    customInstruction: string;
  };
}

export type ManagerTaskStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed';

export interface ManagerTaskStep {
  label: string;
  status: ManagerTaskStatus;
  trigger: 'manual' | 'on_create' | 'on_prompt_sent' | 'on_claude_idle' | 'on_write' | 'ai_input';
  targetTerminal?: string;
}

export interface ManagerTask {
  id: string;
  description: string;
  sessionId: string;
  sessionLabel: string;
  status: ManagerTaskStatus;
  createdAt: number;
  updatedAt: number;
  lastCheckedOutput?: string;
  pendingPrompt?: string;
  steps: ManagerTaskStep[];
  linkedTaskIds?: string[];
}

export interface ManagerTasksMessage {
  type: 'manager:tasks';
  payload: { tasks: ManagerTask[] };
}

/** A local model is being loaded/unloaded in LM Studio — the app shows a "lädt…" chip. */
export interface ManagerModelLoadingMessage {
  type: 'manager:model_loading';
  payload: { providerId: string; loading: boolean };
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

export type ServerMessage =
  | TerminalCreatedMessage
  | TerminalOutputMessage
  | TerminalClosedMessage
  | TerminalErrorMessage
  | TerminalReattachedMessage
  | TerminalCwdMessage
  | TerminalPromptDetectedMessage
  | PongMessage
  | WatcherListResponseMessage
  | WatcherCreatedMessage
  | WatcherUpdatedMessage
  | WatcherDeletedMessage
  | WatcherTestResultMessage
  | SystemSnapshotResponseMessage
  | SystemKillResultMessage
  | AudioTranscriptionMessage
  | AudioProgressMessage
  | AudioErrorMessage
  | TTSResultMessage
  | TTSErrorMessage
  | ManagerSummaryMessage
  | ManagerResponseMessage
  | ManagerProvidersMessage
  | ManagerErrorMessage
  | ManagerStatusMessage
  | ManagerMemoryDataMessage
  | ManagerAgendaDataMessage
  | ManagerEntriesDataMessage
  | ManagerProactiveMessage
  | ManagerUnreadMessage
  | ManagerThinkingMessage
  | ManagerStreamChunkMessage
  | ManagerStreamEndMessage
  | BrowserBridgeOpenMessage
  | BrowserBridgeCallbackResultMessage
  | TerminalTitlesMessage
  | TerminalTitleMessage
  | ManagerPersonalityConfiguredMessage
  | ManagerTasksMessage
  | ManagerModelLoadingMessage
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
  | 'display_asleep';

export type RemoteQualityPreset = 'sparsam' | 'auto' | 'scharf';

export interface RemoteStartMessage {
  type: 'remote:start';
  /** localCursor: the app draws the pointer itself (see remote:cursor). */
  payload: { maxWidth: number; fps: number; bitrateKbps: number; localCursor?: boolean };
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
export type RemoteClientMessage =
  | RemoteStartMessage | RemoteStopMessage | RemoteKeyframeMessage | RemoteAckMessage;

export interface RemoteStartedMessage {
  type: 'remote:started';
  /** localCursor: true = the pointer is NOT in the video; draw it from remote:cursor. */
  payload: { width: number; height: number; scale: number; fps: number; codec: 'avc1'; localCursor?: boolean };
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
