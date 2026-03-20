import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AutopilotItem {
  id: string;
  text: string;
  optimizedPrompt?: string;
  status: 'draft' | 'optimizing' | 'queued' | 'running' | 'done' | 'error';
  error?: string;
  createdAt: number;
  completedAt?: number;
}

interface AutopilotState {
  items: Record<string, AutopilotItem[]>; // keyed by sessionId
  queueEnabled: Record<string, boolean>;

  getItems: (sessionId: string) => AutopilotItem[];
  addItem: (sessionId: string, text: string) => string; // returns id
  removeItem: (sessionId: string, itemId: string) => void;
  updateItem: (sessionId: string, itemId: string, updates: Partial<AutopilotItem>) => void;
  reorderItems: (sessionId: string, itemIds: string[]) => void;
  setQueueEnabled: (sessionId: string, enabled: boolean) => void;
  isQueueEnabled: (sessionId: string) => boolean;
  clearSession: (sessionId: string) => void;

  // Stats
  getPendingCount: (sessionId: string) => number;
  getDoneCount: (sessionId: string) => number;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const useAutopilotStore = create<AutopilotState>()(
  persist(
    (set, get) => ({
      items: {},
      queueEnabled: {},

      getItems: (sessionId) => get().items[sessionId] ?? [],

      addItem: (sessionId, text) => {
        const id = makeId();
        const item: AutopilotItem = { id, text, status: 'draft', createdAt: Date.now() };
        set((s) => ({
          items: { ...s.items, [sessionId]: [...(s.items[sessionId] ?? []), item] },
        }));
        return id;
      },

      removeItem: (sessionId, itemId) => {
        set((s) => ({
          items: { ...s.items, [sessionId]: (s.items[sessionId] ?? []).filter(i => i.id !== itemId) },
        }));
      },

      updateItem: (sessionId, itemId, updates) => {
        set((s) => ({
          items: {
            ...s.items,
            [sessionId]: (s.items[sessionId] ?? []).map(i => i.id === itemId ? { ...i, ...updates } : i),
          },
        }));
      },

      reorderItems: (sessionId, itemIds) => {
        const current = get().items[sessionId] ?? [];
        const ordered: AutopilotItem[] = [];
        for (const id of itemIds) {
          const item = current.find(i => i.id === id);
          if (item) ordered.push(item);
        }
        for (const item of current) {
          if (!itemIds.includes(item.id)) ordered.push(item);
        }
        set((s) => ({ items: { ...s.items, [sessionId]: ordered } }));
      },

      setQueueEnabled: (sessionId, enabled) => {
        set((s) => ({ queueEnabled: { ...s.queueEnabled, [sessionId]: enabled } }));
      },

      isQueueEnabled: (sessionId) => get().queueEnabled[sessionId] ?? false,

      clearSession: (sessionId) => {
        set((s) => {
          const { [sessionId]: _, ...rest } = s.items;
          const { [sessionId]: __, ...restQ } = s.queueEnabled;
          return { items: rest, queueEnabled: restQ };
        });
      },

      getPendingCount: (sessionId) => (get().items[sessionId] ?? []).filter(i => i.status === 'queued').length,
      getDoneCount: (sessionId) => (get().items[sessionId] ?? []).filter(i => i.status === 'done').length,
    }),
    {
      name: 'tms-autopilot',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
