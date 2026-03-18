import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TerminalTab } from '../types/terminal.types';
import { ConnectionState } from '../types/websocket.types';

interface TerminalState {
  tabs: Record<string, TerminalTab[]>;
  connectionStates: Record<string, ConnectionState>;

  addTab: (serverId: string, tab: TerminalTab) => void;
  removeTab: (serverId: string, tabId: string) => void;
  updateTab: (serverId: string, tabId: string, updates: Partial<TerminalTab>) => void;
  setActiveTab: (serverId: string, tabId: string) => void;
  getTabs: (serverId: string) => TerminalTab[];
  setConnectionState: (serverId: string, state: ConnectionState) => void;
  clearTabs: (serverId: string) => void;
  setTabNotification: (serverId: string, sessionId: string) => void;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      tabs: {},
      connectionStates: {},

      addTab(serverId, tab) {
        const current = get().tabs[serverId] || [];
        set({
          tabs: {
            ...get().tabs,
            [serverId]: [...current.map((t) => ({ ...t, active: false })), { ...tab, active: true }],
          },
        });
      },

      removeTab(serverId, tabId) {
        const current = get().tabs[serverId] || [];
        let filtered = current.filter((t) => t.id !== tabId);
        if (filtered.length > 0 && !filtered.some((t) => t.active)) {
          filtered = filtered.map((t, i) =>
            i === filtered.length - 1 ? { ...t, active: true } : t,
          );
        }
        set({ tabs: { ...get().tabs, [serverId]: filtered } });
      },

      updateTab(serverId, tabId, updates) {
        const current = get().tabs[serverId] || [];
        set({
          tabs: {
            ...get().tabs,
            [serverId]: current.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
          },
        });
      },

      setActiveTab(serverId, tabId) {
        const current = get().tabs[serverId] || [];
        set({
          tabs: {
            ...get().tabs,
            [serverId]: current.map((t) => ({
              ...t,
              active: t.id === tabId,
              // Clear badge when tab is opened
              notificationCount: t.id === tabId ? 0 : t.notificationCount,
            })),
          },
        });
      },

      getTabs(serverId) {
        return get().tabs[serverId] || [];
      },

      setConnectionState(serverId, state) {
        set({ connectionStates: { ...get().connectionStates, [serverId]: state } });
      },

      setTabNotification(serverId, sessionId) {
        const current = get().tabs[serverId] || [];
        const tab = current.find((t) => t.sessionId === sessionId);
        // Only set badge on inactive tabs (active tab is already visible)
        if (!tab || tab.active) return;
        set({
          tabs: {
            ...get().tabs,
            [serverId]: current.map((t) =>
              t.sessionId === sessionId
                ? { ...t, notificationCount: (t.notificationCount ?? 0) + 1 }
                : t,
            ),
          },
        });
      },

      clearTabs(serverId) {
        set((state) => {
          const { [serverId]: _, ...restConn } = state.connectionStates;
          return { tabs: { ...state.tabs, [serverId]: [] }, connectionStates: restConn };
        });
      },
    }),
    {
      name: 'tms-terminal-tabs',
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist tabs (sessionIds survive app restarts), not runtime connection states
      partialize: (state) => ({ tabs: state.tabs }),
    },
  ),
);
