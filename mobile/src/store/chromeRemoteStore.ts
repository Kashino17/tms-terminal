import { create } from 'zustand';

export interface ChromeTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

export type ChromeConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'not-found';

interface ChromeRemoteState {
  status: Record<string, ChromeConnectionStatus>;
  error: Record<string, string | null>;
  tabs: Record<string, ChromeTab[]>;
  activeTargetId: Record<string, string | null>;
  frame: Record<string, { data: string; width: number; height: number } | null>;
  latency: Record<string, number>;

  setStatus: (serverId: string, status: ChromeConnectionStatus, error?: string) => void;
  setTabs: (serverId: string, tabs: ChromeTab[], activeTargetId?: string) => void;
  addTab: (serverId: string, tab: ChromeTab) => void;
  removeTab: (serverId: string, targetId: string) => void;
  updateTab: (serverId: string, targetId: string, updates: Partial<Pick<ChromeTab, 'title' | 'url'>>) => void;
  setActiveTarget: (serverId: string, targetId: string) => void;
  setFrame: (serverId: string, data: string, width: number, height: number) => void;
  setLatency: (serverId: string, latency: number) => void;
  clear: (serverId: string) => void;
}

export const useChromeRemoteStore = create<ChromeRemoteState>((set, get) => ({
  status: {},
  error: {},
  tabs: {},
  activeTargetId: {},
  frame: {},
  latency: {},

  setStatus(serverId, status, error) {
    const state = get();
    set({
      status: { ...state.status, [serverId]: status },
      error: { ...state.error, [serverId]: error ?? null },
    });
  },

  setTabs(serverId, tabs, activeTargetId) {
    const state = get();
    set({
      tabs: { ...state.tabs, [serverId]: tabs },
      ...(activeTargetId ? { activeTargetId: { ...state.activeTargetId, [serverId]: activeTargetId } } : {}),
    });
  },

  addTab(serverId, tab) {
    const state = get();
    const existing = state.tabs[serverId] ?? [];
    set({ tabs: { ...state.tabs, [serverId]: [...existing, tab] } });
  },

  removeTab(serverId, targetId) {
    const state = get();
    const existing = state.tabs[serverId] ?? [];
    set({ tabs: { ...state.tabs, [serverId]: existing.filter(t => t.targetId !== targetId) } });
  },

  updateTab(serverId, targetId, updates) {
    const state = get();
    const existing = state.tabs[serverId] ?? [];
    set({
      tabs: {
        ...state.tabs,
        [serverId]: existing.map(t => t.targetId === targetId ? { ...t, ...updates } : t),
      },
    });
  },

  setActiveTarget(serverId, targetId) {
    const state = get();
    set({ activeTargetId: { ...state.activeTargetId, [serverId]: targetId } });
  },

  setFrame(serverId, data, width, height) {
    const state = get();
    set({ frame: { ...state.frame, [serverId]: { data, width, height } } });
  },

  setLatency(serverId, latency) {
    const state = get();
    set({ latency: { ...state.latency, [serverId]: latency } });
  },

  clear(serverId) {
    const state = get();
    const { [serverId]: _s, ...restStatus } = state.status;
    const { [serverId]: _e, ...restError } = state.error;
    const { [serverId]: _t, ...restTabs } = state.tabs;
    const { [serverId]: _a, ...restActive } = state.activeTargetId;
    const { [serverId]: _f, ...restFrame } = state.frame;
    const { [serverId]: _l, ...restLatency } = state.latency;
    set({ status: restStatus, error: restError, tabs: restTabs, activeTargetId: restActive, frame: restFrame, latency: restLatency });
  },
}));
