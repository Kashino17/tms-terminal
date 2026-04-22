import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManagerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  /** Session references mentioned in summaries. */
  sessions?: Array<{ sessionId: string; label: string; hasActivity: boolean }>;
  /** Actions the AI executed (e.g. wrote command to terminal). */
  actions?: Array<{ type: string; sessionId: string; detail: string }>;
  /** Which terminal was targeted (if user specified). */
  targetSessionId?: string;
  /** True for error messages. */
  isError?: boolean;
  /** Generated image filenames (served via /generated-images/). */
  images?: string[];
  /** Generated presentation filenames (served via /generated-presentations/). */
  presentations?: string[];
  /** User-uploaded attachment URIs (local file paths). */
  attachmentUris?: string[];
  /** Total response time in ms (from request to stream_end). */
  responseDuration?: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  isLocal?: boolean;
}

export interface ApiKeys {
  kimi: string;
  glm: string;
  openai: string;
}

// ── Personality ─────────────────────────────────────────────────────────────

export type PersonalityTone = 'chill' | 'professional' | 'technical' | 'friendly' | 'minimal';
export type PersonalityDetail = 'brief' | 'balanced' | 'detailed';

export interface PersonalityConfig {
  /** Display name the agent uses for itself. */
  agentName: string;
  /** Communication tone. */
  tone: PersonalityTone;
  /** How much detail in responses. */
  detail: PersonalityDetail;
  /** Use emojis in responses. */
  emojis: boolean;
  /** Proactively suggest improvements / flag issues. */
  proactive: boolean;
  /** Custom instruction from the user (free text). */
  customInstruction: string;
  /** Agent avatar image URI (local file path). */
  agentAvatarUri?: string;
}

export interface PhaseInfo {
  phase: string;
  label: string;
  duration: number;
}

export const DEFAULT_PERSONALITY: PersonalityConfig = {
  agentName: 'Manager',
  tone: 'chill',
  detail: 'balanced',
  emojis: true,
  proactive: true,
  customInstruction: '',
};

export const TONE_LABELS: Record<PersonalityTone, string> = {
  chill: 'Chill & locker',
  professional: 'Professionell',
  technical: 'Technisch & präzise',
  friendly: 'Freundlich & warm',
  minimal: 'Minimalistisch',
};

export const DETAIL_LABELS: Record<PersonalityDetail, string> = {
  brief: 'Kurz & knapp',
  balanced: 'Ausgewogen',
  detailed: 'Ausführlich',
};

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_MESSAGES = 200;
const MAX_SESSION_MESSAGES = 100;
const MAX_PERSIST_PER_BUCKET = 50;

// ── State interface ─────────────────────────────────────────────────────────

interface ManagerState {
  enabled: boolean;
  messages: ManagerMessage[];
  activeProvider: string;
  providers: ProviderInfo[];
  /** Currently loading (waiting for AI response). */
  loading: boolean;
  /** Timestamp when the current request started (survives navigation). */
  requestStartTime: number | null;
  /** Current thinking phase (null = not thinking). */
  thinking: { phase: string; detail?: string; elapsed: number } | null;
  /** Accumulated text during streaming. */
  streamingText: string;
  /** Token stats during streaming. */
  streamTokenStats: { completionTokens: number; tps: number } | null;
  /** Phase info from the last completed response. */
  lastPhases: PhaseInfo[] | null;
  /** API keys for external providers. */
  apiKeys: ApiKeys;
  /** Agent personality config. */
  personality: PersonalityConfig;
  /** Whether onboarding has been completed. */
  onboarded: boolean;
  /** Per-session message storage, keyed by sessionId or "alle". */
  sessionMessages: Record<string, ManagerMessage[]>;
  /** Currently active chat: "alle" or a sessionId. */
  activeChat: string;
  /** Which chat bucket is currently being streamed to. */
  streamingForChat: string;
  /** Delegated tasks tracked by the manager agent. */
  delegatedTasks: Array<{ id: string; description: string; sessionId: string; sessionLabel: string; status: string; createdAt: number; updatedAt: number; steps?: Array<{ label: string; status: string }> }>;
  /** LM Studio model-load status (null when no local model is loading). */
  modelStatus: {
    providerId: string;
    modelId: string;
    state: 'loading' | 'ready' | 'error';
    elapsedMs: number;
    message?: string;
    /** Wall-clock timestamp when 'ready' fired — used to pulse the online-dot for 2s then clear. */
    readyAt?: number;
  } | null;

  // Actions
  setEnabled: (enabled: boolean) => void;
  addMessage: (msg: Omit<ManagerMessage, 'id' | 'timestamp'>, chatKey?: string) => void;
  addSummary: (text: string, sessions: ManagerMessage['sessions'], timestamp: number, chatKey?: string) => void;
  addResponse: (text: string, actions?: ManagerMessage['actions'], chatKey?: string) => void;
  addError: (message: string, chatKey?: string) => void;
  setProviders: (providers: ProviderInfo[], active: string) => void;
  setActiveProvider: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setThinking: (phase: string, detail?: string, elapsed?: number, chatKey?: string) => void;
  appendStreamChunk: (token: string, tokenStats?: { completionTokens: number; tps: number }) => void;
  finishStream: (text: string, actions?: ManagerMessage['actions'], phases?: PhaseInfo[], images?: string[], presentations?: string[]) => void;
  clearMessages: () => void;
  clearSessionMessages: (chatKey: string) => void;
  deleteMessage: (id: string) => void;
  setApiKey: (provider: 'kimi' | 'glm' | 'openai', key: string) => void;
  setPersonality: (updates: Partial<PersonalityConfig>) => void;
  setOnboarded: (done: boolean) => void;
  setActiveChat: (id: string) => void;
  setDelegatedTasks: (tasks: Array<{ id: string; description: string; sessionId: string; sessionLabel: string; status: string; createdAt: number; updatedAt: number; steps?: Array<{ label: string; status: string }> }>) => void;
  setModelStatus: (status: { providerId: string; modelId: string; state: 'loading' | 'ready' | 'error'; elapsedMs?: number; message?: string } | null) => void;
  /** Latest TTS event (result/progress/error) — consumed by ManagerChatScreen */
  ttsEvent: { type: string; payload: any } | null;
  setTtsEvent: (event: { type: string; payload: any }) => void;
  /** Persisted map: messageId → { filename, duration } for TTS audio */
  ttsAudioMap: Record<string, { filename: string; duration: number }>;
  setTtsAudioEntry: (messageId: string, filename: string, duration: number) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Add a message to a session bucket, respecting the per-session limit. */
function addToSessionBucket(
  sessionMessages: Record<string, ManagerMessage[]>,
  chatKey: string,
  msg: ManagerMessage,
): Record<string, ManagerMessage[]> {
  const existing = sessionMessages[chatKey] ?? [];
  const updated = [...existing, msg].slice(-MAX_SESSION_MESSAGES);
  return { ...sessionMessages, [chatKey]: updated };
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useManagerStore = create<ManagerState>()(
  persist(
    (set, get) => ({
      enabled: false,
      messages: [],
      activeProvider: 'glm',
      providers: [],
      loading: false,
      requestStartTime: null,
      thinking: null,
      streamingText: '',
      streamTokenStats: null,
      lastPhases: null,
      apiKeys: { kimi: '', glm: '', openai: '' },
      personality: { ...DEFAULT_PERSONALITY },
      onboarded: false,
      sessionMessages: {},
      activeChat: 'alle',
      streamingForChat: 'alle',
      delegatedTasks: [],
      modelStatus: null,

      setEnabled: (enabled) => set({ enabled }),

      addMessage: (msg, chatKey = 'alle') => set((s) => {
        const newMsg: ManagerMessage = { ...msg, id: makeId(), timestamp: Date.now() };
        return {
          messages: [...s.messages, newMsg].slice(-MAX_MESSAGES),
          sessionMessages: addToSessionBucket(s.sessionMessages, chatKey, newMsg),
        };
      }),

      addSummary: (text, sessions, timestamp, chatKey = 'alle') => set((s) => {
        const newMsg: ManagerMessage = {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp,
          sessions,
        };
        return {
          messages: [...s.messages, newMsg].slice(-MAX_MESSAGES),
          sessionMessages: addToSessionBucket(s.sessionMessages, chatKey, newMsg),
          loading: false,
        };
      }),

      addResponse: (text, actions, chatKey = 'alle') => set((s) => {
        const duration = s.requestStartTime ? Date.now() - s.requestStartTime : undefined;
        const newMsg: ManagerMessage = {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp: Date.now(),
          actions,
          responseDuration: duration,
        };
        return {
          messages: [...s.messages, newMsg].slice(-MAX_MESSAGES),
          sessionMessages: addToSessionBucket(s.sessionMessages, chatKey, newMsg),
          loading: false,
          requestStartTime: null,
        };
      }),

      addError: (message, chatKey = 'alle') => set((s) => {
        const newMsg: ManagerMessage = {
          id: makeId(),
          role: 'system' as const,
          text: message,
          timestamp: Date.now(),
          isError: true,
        };
        return {
          messages: [...s.messages, newMsg].slice(-MAX_MESSAGES),
          sessionMessages: addToSessionBucket(s.sessionMessages, chatKey, newMsg),
          loading: false,
          requestStartTime: null,
        };
      }),

      setProviders: (providers, active) => set((s) => {
        // Keep the locally persisted provider if it still exists in the list
        const kept = providers.some(p => p.id === s.activeProvider) ? s.activeProvider : active;
        return { providers, activeProvider: kept };
      }),

      setActiveProvider: (id) => set({ activeProvider: id }),

      setLoading: (loading) => set({
        loading,
        requestStartTime: loading ? Date.now() : null,
      }),

      setThinking: (phase, detail, elapsed, chatKey) => set({
        thinking: { phase, detail, elapsed: elapsed ?? 0 },
        streamingForChat: chatKey ?? 'alle',
      }),

      appendStreamChunk: (token, tokenStats) => set((s) => ({
        streamingText: s.streamingText + token,
        streamTokenStats: tokenStats ?? s.streamTokenStats,
      })),

      finishStream: (text, actions, phases, images, presentations) => set((s) => {
        const chatKey = s.streamingForChat;
        const duration = s.requestStartTime ? Date.now() - s.requestStartTime : undefined;
        const newMsg: ManagerMessage = {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp: Date.now(),
          actions,
          images,
          presentations,
          responseDuration: duration,
        };
        return {
          messages: [...s.messages, newMsg].slice(-MAX_MESSAGES),
          sessionMessages: addToSessionBucket(s.sessionMessages, chatKey, newMsg),
          loading: false,
          requestStartTime: null,
          thinking: null,
          streamingText: '',
          streamTokenStats: null,
          lastPhases: phases ?? null,
        };
      }),

      clearMessages: () => set((s) => {
        const chatKey = s.activeChat;
        if (chatKey === 'alle') {
          return { messages: [] };
        }
        const sessionMessages = { ...s.sessionMessages };
        delete sessionMessages[chatKey];
        return { sessionMessages };
      }),

      clearSessionMessages: (chatKey) => set((s) => {
        if (chatKey === 'alle') {
          return { messages: [] };
        }
        const sessionMessages = { ...s.sessionMessages };
        delete sessionMessages[chatKey];
        return { sessionMessages };
      }),

      deleteMessage: (id) => set((s) => {
        // Remove from global messages
        const messages = s.messages.filter(m => m.id !== id);
        // Remove from all session buckets
        const sessionMessages: Record<string, ManagerMessage[]> = {};
        for (const [key, msgs] of Object.entries(s.sessionMessages)) {
          const filtered = msgs.filter(m => m.id !== id);
          if (filtered.length > 0) {
            sessionMessages[key] = filtered;
          }
        }
        return { messages, sessionMessages };
      }),

      setApiKey: (provider, key) => set((s) => ({
        apiKeys: { ...s.apiKeys, [provider]: key },
      })),

      setPersonality: (updates) => set((s) => ({
        personality: { ...s.personality, ...updates },
      })),

      setOnboarded: (done) => set({ onboarded: done }),

      setActiveChat: (id) => set({ activeChat: id }),
      setDelegatedTasks: (tasks) => set({ delegatedTasks: tasks }),

      setModelStatus: (status) => set(() => {
        if (!status) return { modelStatus: null };
        const elapsedMs = status.elapsedMs ?? 0;
        // Tag 'ready' with a timestamp so the UI can pulse the online-dot for 2s, then auto-clear.
        const readyAt = status.state === 'ready' ? Date.now() : undefined;
        return { modelStatus: { ...status, elapsedMs, readyAt } };
      }),
      ttsEvent: null,
      setTtsEvent: (event) => set({ ttsEvent: event }),
      ttsAudioMap: {},
      setTtsAudioEntry: (messageId, filename, duration) => set((s) => ({
        ttsAudioMap: { ...s.ttsAudioMap, [messageId]: { filename, duration } },
      })),
    }),
    {
      name: 'tms-manager',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => {
        // Limit each session bucket to last MAX_PERSIST_PER_BUCKET messages
        const persistedSessionMessages: Record<string, ManagerMessage[]> = {};
        for (const [key, msgs] of Object.entries(state.sessionMessages)) {
          persistedSessionMessages[key] = msgs.slice(-MAX_PERSIST_PER_BUCKET);
        }
        return {
          enabled: state.enabled,
          messages: state.messages.slice(-50),
          activeProvider: state.activeProvider,
          apiKeys: state.apiKeys,
          personality: state.personality,
          onboarded: state.onboarded,
          sessionMessages: persistedSessionMessages,
          activeChat: state.activeChat,
          ttsAudioMap: state.ttsAudioMap,
        };
      },
    },
  ),
);
