import { create } from 'zustand';

export interface SQLEntry {
  id: string;
  sql: string;
  detectedAt: number;
  sessionId: string;
}

interface SQLState {
  entries: Record<string, SQLEntry[]>; // sessionId → SQLEntry[]
  addEntry: (sessionId: string, sql: string) => void;
  removeEntry: (sessionId: string, id: string) => void;
  clearSession: (sessionId: string) => void;
  getEntries: (sessionId: string) => SQLEntry[];
}

// In-memory only — SQL entries are session-scoped and don't need to survive app restarts
export const useSQLStore = create<SQLState>()((set, get) => ({
  entries: {},

  addEntry(sessionId, sql) {
    const prev = get().entries[sessionId] ?? [];
    const entry: SQLEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      sql,
      detectedAt: Date.now(),
      sessionId,
    };
    set({ entries: { ...get().entries, [sessionId]: [entry, ...prev] } });
  },

  removeEntry(sessionId, id) {
    const prev = get().entries[sessionId] ?? [];
    set({
      entries: {
        ...get().entries,
        [sessionId]: prev.filter((e) => e.id !== id),
      },
    });
  },

  clearSession(sessionId) {
    const next = { ...get().entries };
    delete next[sessionId];
    set({ entries: next });
  },

  getEntries(sessionId) {
    return get().entries[sessionId] ?? [];
  },
}));
