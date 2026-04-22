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
  payload: { audio: string; format: 'wav' };
}

// ── Manager messages (Client → Server) ────────────────────────────
export interface ManagerChatMessage {
  type: 'manager:chat';
  payload: { text: string; targetSessionId?: string };
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
  payload: { providerId: string };
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

// ── Chrome Remote Control (Client → Server) ─────────────────────
export interface ChromeConnectMessage {
  type: 'chrome:connect';
}
export interface ChromeDisconnectMessage {
  type: 'chrome:disconnect';
}
export interface ChromeInputMessage {
  type: 'chrome:input';
  payload: {
    action: 'click' | 'dblclick' | 'rightclick' | 'scroll' | 'key';
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    key?: string;
    code?: string;
    text?: string;
    modifiers?: number;
  };
}
export interface ChromeNavigateMessage {
  type: 'chrome:navigate';
  payload: { url: string };
}
export interface ChromeTabSwitchMessage {
  type: 'chrome:tab:switch';
  payload: { targetId: string };
}
export interface ChromeTabOpenMessage {
  type: 'chrome:tab:open';
  payload: { url?: string };
}
export interface ChromeTabCloseMessage {
  type: 'chrome:tab:close';
  payload: { targetId: string };
}
export interface ChromeQualityMessage {
  type: 'chrome:quality';
  payload: { quality: number; maxFps: number };
}
export interface ChromePauseMessage {
  type: 'chrome:pause';
}
export interface ChromeResumeMessage {
  type: 'chrome:resume';
}
export interface ChromeResizeMessage {
  type: 'chrome:resize';
  payload: { width: number; height: number };
}
export interface ChromeGoBackMessage {
  type: 'chrome:back';
}
export interface ChromeGoForwardMessage {
  type: 'chrome:forward';
}
export interface ChromeReloadMessage {
  type: 'chrome:reload';
}

// ── Voice Chat (Client → Server) ───────────────────────────────────────────

export interface VoiceStartMsg { type: 'voice:start'; payload?: {} }
export interface VoiceAudioChunkMsg { type: 'voice:audio_chunk'; payload: { audio: string /* base64 PCM */ } }
export interface VoiceEndTurnMsg { type: 'voice:end_turn'; payload?: {} }
export interface VoicePauseMsg { type: 'voice:pause'; payload?: {} }
export interface VoiceResumeMsg { type: 'voice:resume'; payload?: { strategy?: 'clean' | 'with_interjection' } }
export interface VoiceCancelMsg { type: 'voice:cancel'; payload?: {} }
export interface VoiceStopMsg { type: 'voice:stop'; payload?: {} }

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
  | FileUploadMessage
  | AppStateMessage
  | ActiveTabMessage
  | ChromeConnectMessage
  | ChromeDisconnectMessage
  | ChromeInputMessage
  | ChromeNavigateMessage
  | ChromeTabSwitchMessage
  | ChromeTabOpenMessage
  | ChromeTabCloseMessage
  | ChromeQualityMessage
  | ChromePauseMessage
  | ChromeResumeMessage
  | ChromeResizeMessage
  | ChromeGoBackMessage
  | ChromeGoForwardMessage
  | ChromeReloadMessage
  | VoiceStartMsg
  | VoiceAudioChunkMsg
  | VoiceEndTurnMsg
  | VoicePauseMsg
  | VoiceResumeMsg
  | VoiceCancelMsg
  | VoiceStopMsg;

// ── Server → Client ──────────────────────────────────────────────

export interface TerminalCreatedMessage {
  type: 'terminal:created';
  sessionId: string;
  payload: { cols: number; rows: number };
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

export interface TerminalPromptDetectedMessage {
  type: 'terminal:prompt_detected';
  sessionId: string;
  payload: { snippet: string; hasPendingInput?: boolean };
}

export interface PongMessage {
  type: 'pong';
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
    providers: Array<{ id: string; name: string; configured: boolean }>;
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

// ── Manager streaming (Server → Client) ──────────────────────────
export interface PhaseInfo {
  phase: string;
  label: string;
  duration: number;
}

export interface ManagerThinkingMessage {
  type: 'manager:thinking';
  payload: { phase: string; detail?: string; elapsed: number };
}

export interface ManagerStreamChunkMessage {
  type: 'manager:stream_chunk';
  payload: { token: string };
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

export interface ManagerModelStatusMessage {
  type: 'manager:model_status';
  payload: {
    providerId: string;
    modelId: string;
    state: 'loading' | 'ready' | 'error';
    elapsedMs?: number;
    message?: string;
  };
}

// ── Chrome Remote Control (Server → Client) ─────────────────────
export interface ChromeStatusMessage {
  type: 'chrome:status';
  payload: {
    state: 'connected' | 'disconnected' | 'not-found' | 'busy' | 'connecting';
    reason?: string;
    activeClient?: string;
  };
}
export interface ChromeFrameMessage {
  type: 'chrome:frame';
  payload: {
    data: string;
    width: number;
    height: number;
    timestamp: number;
  };
}
export interface ChromeTabsMessage {
  type: 'chrome:tabs';
  payload: {
    tabs: Array<{ targetId: string; title: string; url: string; faviconUrl?: string }>;
    activeTargetId?: string;
  };
}
export interface ChromeTabCreatedMessage {
  type: 'chrome:tab:created';
  payload: { targetId: string; title: string; url: string };
}
export interface ChromeTabRemovedMessage {
  type: 'chrome:tab:removed';
  payload: { targetId: string };
}
export interface ChromeTabUpdatedMessage {
  type: 'chrome:tab:updated';
  payload: { targetId: string; title?: string; url?: string };
}

// ── Voice Chat (Server → Client) ───────────────────────────────────────────

export type VoicePhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking'
  | 'tool_call' | 'speaking' | 'paused';

export interface VoicePhaseMsg { type: 'voice:phase'; payload: { phase: VoicePhase } }
export interface VoiceTranscriptMsg { type: 'voice:transcript'; payload: { text: string; final: boolean } }
export interface VoiceAiDeltaMsg { type: 'voice:ai_delta'; payload: { text: string } }
export interface VoiceTtsChunkMsg {
  type: 'voice:tts_chunk';
  payload: { chunkIdx: number; audio: string /* base64 WAV */; sentence: string; isLast: boolean }
}
export interface VoiceAckAudioMsg {
  type: 'voice:ack_audio';
  payload: { kind: 'pause' | 'resume'; audio: string /* base64 WAV */ }
}
export interface VoiceErrorMsg { type: 'voice:error'; payload: { message: string; recoverable: boolean } }

export type ServerMessage =
  | TerminalCreatedMessage
  | TerminalOutputMessage
  | TerminalClosedMessage
  | TerminalErrorMessage
  | TerminalReattachedMessage
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
  | AudioErrorMessage
  | ManagerSummaryMessage
  | ManagerResponseMessage
  | ManagerProvidersMessage
  | ManagerErrorMessage
  | ManagerStatusMessage
  | ManagerMemoryDataMessage
  | ManagerThinkingMessage
  | ManagerStreamChunkMessage
  | ManagerStreamEndMessage
  | ManagerModelStatusMessage
  | ChromeStatusMessage
  | ChromeFrameMessage
  | ChromeTabsMessage
  | ChromeTabCreatedMessage
  | ChromeTabRemovedMessage
  | ChromeTabUpdatedMessage
  | VoicePhaseMsg
  | VoiceTranscriptMsg
  | VoiceAiDeltaMsg
  | VoiceTtsChunkMsg
  | VoiceAckAudioMsg
  | VoiceErrorMsg;
