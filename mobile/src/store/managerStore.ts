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

interface ManagerState {
  enabled: boolean;
  messages: ManagerMessage[];
  activeProvider: string;
  providers: ProviderInfo[];
  /** Currently loading (waiting for AI response). */
  loading: boolean;
  /** API keys for external providers. */
  apiKeys: ApiKeys;

  // Actions
  setEnabled: (enabled: boolean) => void;
  addMessage: (msg: Omit<ManagerMessage, 'id' | 'timestamp'>) => void;
  addSummary: (text: string, sessions: ManagerMessage['sessions'], timestamp: number) => void;
  addResponse: (text: string, actions?: ManagerMessage['actions']) => void;
  addError: (message: string) => void;
  setProviders: (providers: ProviderInfo[], active: string) => void;
  setActiveProvider: (id: string) => void;
  setLoading: (loading: boolean) => void;
  clearMessages: () => void;
  setApiKey: (provider: 'kimi' | 'glm', key: string) => void;
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
      activeProvider: 'claude',
      providers: [],
      loading: false,
      apiKeys: { kimi: '', glm: '' },

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

      clearMessages: () => set({ messages: [] }),

      setApiKey: (provider, key) => set((s) => ({
        apiKeys: { ...s.apiKeys, [provider]: key },
      })),
    }),
    {
      name: 'tms-manager',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        messages: state.messages.slice(-50), // persist only last 50 messages
        activeProvider: state.activeProvider,
        apiKeys: state.apiKeys,
      }),
    },
  ),
);
