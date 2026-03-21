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
  queueDirectly: (sessionId: string, itemId: string) => void;
  moveToTop: (sessionId: string, itemId: string) => void;
  moveToBottom: (sessionId: string, itemId: string) => void;
  moveToPosition: (sessionId: string, itemId: string, targetPosition: number) => void;
  setQueueEnabled: (sessionId: string, enabled: boolean) => void;
  isQueueEnabled: (sessionId: string) => boolean;
  clearSession: (sessionId: string) => void;

  // Stats
  getPendingCount: (sessionId: string) => number;
  getDoneCount: (sessionId: string) => number;
  /** Remove done items older than 24 hours */
  cleanupOldDone: () => void;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const useAutopilotStore = create<AutopilotState>()(
  persist(
    (set, get) => ({
      items: {},
      queueEnabled: {},

      getItems: (sessionId) => {
        const all = get().items[sessionId] ?? [];
        // Sort: active items first (draft/optimizing/queued/running), done items at the bottom
        const active = all.filter(i => i.status !== 'done');
        const done = all.filter(i => i.status === 'done');
        return [...active, ...done];
      },

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

      queueDirectly: (sessionId, itemId) => {
        const items = get().items[sessionId] ?? [];
        const item = items.find(i => i.id === itemId);
        if (!item) return;
        set((s) => ({
          items: {
            ...s.items,
            [sessionId]: (s.items[sessionId] ?? []).map(i =>
              i.id === itemId ? { ...i, status: 'queued' as const, optimizedPrompt: i.text } : i
            ),
          },
        }));
      },

      moveToTop: (sessionId, itemId) => {
        const all = get().items[sessionId] ?? [];
        const active = all.filter(i => i.status !== 'done');
        const done = all.filter(i => i.status === 'done');
        const idx = active.findIndex(i => i.id === itemId);
        if (idx <= 0) return;
        const [item] = active.splice(idx, 1);
        active.unshift(item);
        set((s) => ({ items: { ...s.items, [sessionId]: [...active, ...done] } }));
      },

      moveToBottom: (sessionId, itemId) => {
        const all = get().items[sessionId] ?? [];
        const active = all.filter(i => i.status !== 'done');
        const done = all.filter(i => i.status === 'done');
        const idx = active.findIndex(i => i.id === itemId);
        if (idx < 0 || idx === active.length - 1) return;
        const [item] = active.splice(idx, 1);
        active.push(item);
        set((s) => ({ items: { ...s.items, [sessionId]: [...active, ...done] } }));
      },

      moveToPosition: (sessionId, itemId, targetPosition) => {
        const all = get().items[sessionId] ?? [];
        const active = all.filter(i => i.status !== 'done');
        const done = all.filter(i => i.status === 'done');
        const idx = active.findIndex(i => i.id === itemId);
        if (idx < 0) return;
        const targetIdx = Math.max(0, Math.min(targetPosition - 1, active.length - 1));
        if (idx === targetIdx) return;
        const [item] = active.splice(idx, 1);
        active.splice(targetIdx, 0, item);
        set((s) => ({ items: { ...s.items, [sessionId]: [...active, ...done] } }));
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

      /** Remove done items older than 24 hours across all sessions */
      cleanupOldDone: () => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        set((s) => {
          const cleaned: Record<string, AutopilotItem[]> = {};
          for (const [sid, items] of Object.entries(s.items)) {
            cleaned[sid] = items.filter(i => i.status !== 'done' || !i.completedAt || i.completedAt > cutoff);
          }
          return { items: cleaned };
        });
      },
    }),
    {
      name: 'tms-autopilot',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
