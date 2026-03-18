import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tms:notes';

export interface NoteItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

interface NotesState {
  /** Notes keyed by serverId */
  notes: Record<string, NoteItem[]>;
  loaded: boolean;

  load: () => Promise<void>;
  getItems: (serverId: string) => NoteItem[];
  addItem: (serverId: string, text: string) => void;
  updateItem: (serverId: string, id: string, text: string) => void;
  toggleItem: (serverId: string, id: string) => void;
  removeItem: (serverId: string, id: string) => void;
  clearDone: (serverId: string) => void;
}

function persist(notes: Record<string, NoteItem[]>) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(notes)).catch(() => {});
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: {},
  loaded: false,

  async load() {
    if (get().loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) set({ notes: JSON.parse(raw), loaded: true });
      else set({ loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  getItems(serverId) {
    return get().notes[serverId] || [];
  },

  addItem(serverId, text) {
    const notes = { ...get().notes };
    const items = [...(notes[serverId] || [])];
    items.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      done: false,
      createdAt: Date.now(),
    });
    notes[serverId] = items;
    set({ notes });
    persist(notes);
  },

  updateItem(serverId, id, text) {
    const notes = { ...get().notes };
    notes[serverId] = (notes[serverId] || []).map((n) =>
      n.id === id ? { ...n, text } : n,
    );
    set({ notes });
    persist(notes);
  },

  toggleItem(serverId, id) {
    const notes = { ...get().notes };
    notes[serverId] = (notes[serverId] || []).map((n) =>
      n.id === id ? { ...n, done: !n.done } : n,
    );
    set({ notes });
    persist(notes);
  },

  removeItem(serverId, id) {
    const notes = { ...get().notes };
    notes[serverId] = (notes[serverId] || []).filter((n) => n.id !== id);
    set({ notes });
    persist(notes);
  },

  clearDone(serverId) {
    const notes = { ...get().notes };
    notes[serverId] = (notes[serverId] || []).filter((n) => !n.done);
    set({ notes });
    persist(notes);
  },
}));
