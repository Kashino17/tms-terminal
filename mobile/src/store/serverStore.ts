import { create } from 'zustand';
import { ServerProfile, ServerStatus } from '../types/server.types';
import { storageService } from '../services/storage.service';

interface ServerState {
  servers: ServerProfile[];
  statuses: Record<string, ServerStatus>;
  loading: boolean;

  loadServers: () => Promise<void>;
  addServer: (server: ServerProfile) => Promise<void>;
  updateServer: (id: string, updates: Partial<ServerProfile>) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  setStatus: (id: string, status: ServerStatus) => void;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  statuses: {},
  loading: false,

  async loadServers() {
    set({ loading: true });
    const servers = await storageService.getServers();
    set({ servers, loading: false });
  },

  async addServer(server: ServerProfile) {
    await storageService.addServer(server);
    set((state) => ({ servers: [...state.servers, server] }));
  },

  async updateServer(id: string, updates: Partial<ServerProfile>) {
    await storageService.updateServer(id, updates);
    set((state) => ({
      servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    }));
  },

  async deleteServer(id: string) {
    await storageService.deleteServer(id);
    set((state) => ({ servers: state.servers.filter((s) => s.id !== id) }));
  },

  setStatus(id: string, status: ServerStatus) {
    set((state) => ({ statuses: { ...state.statuses, [id]: status } }));
  },
}));
