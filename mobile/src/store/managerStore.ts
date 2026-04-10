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
}

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
}

export interface ApiKeys {
  kimi: string;
  glm: string;
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

interface ManagerState {
  enabled: boolean;
  messages: ManagerMessage[];
  activeProvider: string;
  providers: ProviderInfo[];
  /** Currently loading (waiting for AI response). */
  loading: boolean;
  /** Current thinking phase (null = not thinking). */
  thinking: { phase: string; detail?: string; elapsed: number } | null;
  /** Accumulated text during streaming. */
  streamingText: string;
  /** Phase info from the last completed response. */
  lastPhases: PhaseInfo[] | null;
  /** API keys for external providers. */
  apiKeys: ApiKeys;
  /** Agent personality config. */
  personality: PersonalityConfig;
  /** Whether onboarding has been completed. */
  onboarded: boolean;

  // Actions
  setEnabled: (enabled: boolean) => void;
  addMessage: (msg: Omit<ManagerMessage, 'id' | 'timestamp'>) => void;
  addSummary: (text: string, sessions: ManagerMessage['sessions'], timestamp: number) => void;
  addResponse: (text: string, actions?: ManagerMessage['actions']) => void;
  addError: (message: string) => void;
  setProviders: (providers: ProviderInfo[], active: string) => void;
  setActiveProvider: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setThinking: (phase: string, detail?: string, elapsed?: number) => void;
  appendStreamChunk: (token: string) => void;
  finishStream: (text: string, actions?: ManagerMessage['actions'], phases?: PhaseInfo[]) => void;
  clearMessages: () => void;
  deleteMessage: (id: string) => void;
  setApiKey: (provider: 'kimi' | 'glm', key: string) => void;
  setPersonality: (updates: Partial<PersonalityConfig>) => void;
  setOnboarded: (done: boolean) => void;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const MAX_MESSAGES = 200;

export const useManagerStore = create<ManagerState>()(
  persist(
    (set, get) => ({
      enabled: false,
      messages: [],
      activeProvider: 'glm',
      providers: [],
      loading: false,
      thinking: null,
      streamingText: '',
      lastPhases: null,
      apiKeys: { kimi: '', glm: '' },
      personality: { ...DEFAULT_PERSONALITY },
      onboarded: false,

      setEnabled: (enabled) => set({ enabled }),

      addMessage: (msg) => set((s) => {
        const messages = [...s.messages, { ...msg, id: makeId(), timestamp: Date.now() }];
        return { messages: messages.slice(-MAX_MESSAGES) };
      }),

      addSummary: (text, sessions, timestamp) => set((s) => {
        const messages = [...s.messages, {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp,
          sessions,
        }];
        return { messages: messages.slice(-MAX_MESSAGES), loading: false };
      }),

      addResponse: (text, actions) => set((s) => {
        const messages = [...s.messages, {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp: Date.now(),
          actions,
        }];
        return { messages: messages.slice(-MAX_MESSAGES), loading: false };
      }),

      addError: (message) => set((s) => {
        const messages = [...s.messages, {
          id: makeId(),
          role: 'system' as const,
          text: message,
          timestamp: Date.now(),
        }];
        return { messages: messages.slice(-MAX_MESSAGES), loading: false };
      }),

      setProviders: (providers, active) => set({ providers, activeProvider: active }),

      setActiveProvider: (id) => set({ activeProvider: id }),

      setLoading: (loading) => set({ loading }),

      setThinking: (phase, detail, elapsed) => set({
        thinking: { phase, detail, elapsed: elapsed ?? 0 },
      }),

      appendStreamChunk: (token) => set((s) => ({
        streamingText: s.streamingText + token,
      })),

      finishStream: (text, actions, phases) => set((s) => {
        const messages = [...s.messages, {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp: Date.now(),
          actions,
        }];
        return {
          messages: messages.slice(-MAX_MESSAGES),
          loading: false,
          thinking: null,
          streamingText: '',
          lastPhases: phases ?? null,
        };
      }),

      clearMessages: () => set({ messages: [] }),

      deleteMessage: (id) => set((s) => ({
        messages: s.messages.filter(m => m.id !== id),
      })),

      setApiKey: (provider, key) => set((s) => ({
        apiKeys: { ...s.apiKeys, [provider]: key },
      })),

      setPersonality: (updates) => set((s) => ({
        personality: { ...s.personality, ...updates },
      })),

      setOnboarded: (done) => set({ onboarded: done }),
    }),
    {
      name: 'tms-manager',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        messages: state.messages.slice(-50),
        activeProvider: state.activeProvider,
        apiKeys: state.apiKeys,
        personality: state.personality,
        onboarded: state.onboarded,
      }),
    },
  ),
);
