import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tms:port-forwards';

export interface PortForward {
  id: string;
  port: string;
  label: string;
  path?: string;
}

interface PortForwardingState {
  entries: Record<string, PortForward[]>;
  loaded: Record<string, boolean>;
  load: (serverId: string) => Promise<void>;
  getEntries: (serverId: string) => PortForward[];
  addEntry: (serverId: string) => void;
  removeEntry: (serverId: string, id: string) => void;
  updateEntry: (serverId: string, id: string, updates: Partial<Pick<PortForward, 'port' | 'label' | 'path'>>) => void;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const DEFAULTS: PortForward[] = [
  { id: 'd1', port: '3000', label: 'Dev Server' },
  { id: 'd2', port: '5173', label: 'Vite' },
  { id: 'd3', port: '8080', label: 'HTTP Alt' },
];

function save(serverId: string, entries: PortForward[]) {
  AsyncStorage.setItem(`${STORAGE_KEY}:${serverId}`, JSON.stringify(entries)).catch(() => {});
}

export const usePortForwardingStore = create<PortForwardingState>((set, get) => ({
  entries: {},
  loaded: {},

  async load(serverId) {
    if (!!get().loaded[serverId]) return;
    try {
      const raw = await AsyncStorage.getItem(`${STORAGE_KEY}:${serverId}`);
      const entries: PortForward[] = raw ? JSON.parse(raw) : DEFAULTS;
      set((s) => ({
        entries: { ...s.entries, [serverId]: entries },
        loaded: { ...s.loaded, [serverId]: true },
      }));
    } catch {
      set((s) => ({
        entries: { ...s.entries, [serverId]: DEFAULTS },
        loaded: { ...s.loaded, [serverId]: true },
      }));
    }
  },

  getEntries: (serverId) => get().entries[serverId] ?? [],

  addEntry(serverId) {
    const entry: PortForward = { id: makeId(), port: '3000', label: 'New Port' };
    set((s) => {
      const list = [...(s.entries[serverId] ?? []), entry];
      save(serverId, list);
      return { entries: { ...s.entries, [serverId]: list } };
    });
  },

  removeEntry(serverId, id) {
    set((s) => {
      const list = (s.entries[serverId] ?? []).filter((e) => e.id !== id);
      save(serverId, list);
      return { entries: { ...s.entries, [serverId]: list } };
    });
  },

  updateEntry(serverId, id, updates) {
    set((s) => {
      const list = (s.entries[serverId] ?? []).map((e) =>
        e.id === id ? { ...e, ...updates } : e,
      );
      save(serverId, list);
      return { entries: { ...s.entries, [serverId]: list } };
    });
  },
}));
