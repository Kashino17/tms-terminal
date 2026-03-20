import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tms:browser-tabs';

export interface BrowserTab {
  id: string;
  port: string;
  label: string;
  /** Optional URL path appended after port (e.g. "/login") */
  path?: string;
  /** Last navigated URL — persisted so the tab resumes where the user left off */
  lastUrl?: string;
}

interface BrowserTabsState {
  /** Tabs keyed by serverId */
  tabs: Record<string, BrowserTab[]>;
  /** Active tab id keyed by serverId */
  activeTab: Record<string, string>;
  loaded: Record<string, boolean>;

  load: (serverId: string) => Promise<void>;
  getTabs: (serverId: string) => BrowserTab[];
  getActive: (serverId: string) => BrowserTab | undefined;
  addTab: (serverId: string, port?: string) => void;
  removeTab: (serverId: string, tabId: string) => void;
  setActive: (serverId: string, tabId: string) => void;
  updateTab: (serverId: string, tabId: string, updates: Partial<Pick<BrowserTab, 'port' | 'label' | 'path' | 'lastUrl'>>) => void;
}

function persist(serverId: string, tabs: BrowserTab[], activeTab: string) {
  AsyncStorage.setItem(
    `${STORAGE_KEY}:${serverId}`,
    JSON.stringify({ tabs, activeTab }),
  ).catch(() => {});
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const useBrowserTabsStore = create<BrowserTabsState>((set, get) => ({
  tabs: {},
  activeTab: {},
  loaded: {},

  async load(serverId) {
    if (!!get().loaded[serverId]) return;
    try {
      const raw = await AsyncStorage.getItem(`${STORAGE_KEY}:${serverId}`);
      if (raw) {
        const data = JSON.parse(raw) as { tabs: BrowserTab[]; activeTab: string };
        const state = get();
        set({
          tabs: { ...state.tabs, [serverId]: data.tabs },
          activeTab: { ...state.activeTab, [serverId]: data.activeTab },
          loaded: { ...state.loaded, [serverId]: true },
        });
      } else {
        // First time — create default tab
        const tab: BrowserTab = { id: makeId(), port: '3000', label: 'Tab 1' };
        const state = get();
        set({
          tabs: { ...state.tabs, [serverId]: [tab] },
          activeTab: { ...state.activeTab, [serverId]: tab.id },
          loaded: { ...state.loaded, [serverId]: true },
        });
        persist(serverId, [tab], tab.id);
      }
    } catch {
      const tab: BrowserTab = { id: makeId(), port: '3000', label: 'Tab 1' };
      const state = get();
      set({
        tabs: { ...state.tabs, [serverId]: [tab] },
        activeTab: { ...state.activeTab, [serverId]: tab.id },
        loaded: { ...state.loaded, [serverId]: true },
      });
    }
  },

  getTabs(serverId) {
    return get().tabs[serverId] || [];
  },

  getActive(serverId) {
    const tabs = get().tabs[serverId] || [];
    const activeId = get().activeTab[serverId];
    return tabs.find((t) => t.id === activeId) || tabs[0];
  },

  addTab(serverId, port = '3000') {
    const state = get();
    const existing = state.tabs[serverId] || [];
    const tab: BrowserTab = {
      id: makeId(),
      port,
      label: `Tab ${existing.length + 1}`,
    };
    const newTabs = [...existing, tab];
    set({
      tabs: { ...state.tabs, [serverId]: newTabs },
      activeTab: { ...state.activeTab, [serverId]: tab.id },
    });
    persist(serverId, newTabs, tab.id);
  },

  removeTab(serverId, tabId) {
    const state = get();
    const existing = state.tabs[serverId] || [];
    if (existing.length <= 1) return; // Keep at least one tab
    const newTabs = existing.filter((t) => t.id !== tabId);
    let newActive = state.activeTab[serverId];
    if (newActive === tabId) {
      // Switch to adjacent tab
      const removedIdx = existing.findIndex((t) => t.id === tabId);
      const nextIdx = Math.min(removedIdx, newTabs.length - 1);
      newActive = newTabs[nextIdx].id;
    }
    set({
      tabs: { ...state.tabs, [serverId]: newTabs },
      activeTab: { ...state.activeTab, [serverId]: newActive },
    });
    persist(serverId, newTabs, newActive);
  },

  setActive(serverId, tabId) {
    const state = get();
    set({ activeTab: { ...state.activeTab, [serverId]: tabId } });
    persist(serverId, state.tabs[serverId] || [], tabId);
  },

  updateTab(serverId, tabId, updates) {
    const state = get();
    const newTabs = (state.tabs[serverId] || []).map((t) =>
      t.id === tabId ? { ...t, ...updates } : t,
    );
    set({ tabs: { ...state.tabs, [serverId]: newTabs } });
    persist(serverId, newTabs, state.activeTab[serverId] || '');
  },
}));
