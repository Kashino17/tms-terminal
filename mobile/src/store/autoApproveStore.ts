import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface AutoApproveState {
  /** sessionId → true if auto-approve is enabled */
  enabled: Record<string, boolean>;

  /** sessionId → true while a 3×Enter sequence is running (prevents re-trigger) */
  running: Record<string, boolean>;

  toggle: (sessionId: string) => void;
  setEnabled: (sessionId: string, on: boolean) => void;
  isEnabled: (sessionId: string) => boolean;

  setRunning: (sessionId: string, on: boolean) => void;
  isRunning: (sessionId: string) => boolean;

  /** Clean up when a session is destroyed */
  clear: (sessionId: string) => void;

  /** Remove entries for sessions not in the active list. Call on app startup. */
  cleanup: (activeSessionIds: string[]) => void;
}

export const useAutoApproveStore = create<AutoApproveState>()(
  persist(
    (set, get) => ({
      enabled: {},
      running: {},

      toggle(sessionId) {
        const prev = get().enabled[sessionId] ?? false;
        set({ enabled: { ...get().enabled, [sessionId]: !prev } });
      },

      setEnabled(sessionId, on) {
        set({ enabled: { ...get().enabled, [sessionId]: on } });
      },

      isEnabled(sessionId) {
        return get().enabled[sessionId] ?? false;
      },

      setRunning(sessionId, on) {
        set({ running: { ...get().running, [sessionId]: on } });
      },

      isRunning(sessionId) {
        return get().running[sessionId] ?? false;
      },

      clear(sessionId) {
        set((state) => {
          const { [sessionId]: _e, ...restEnabled } = state.enabled;
          const { [sessionId]: _r, ...restRunning } = state.running;
          return { enabled: restEnabled, running: restRunning };
        });
      },

      cleanup(activeSessionIds) {
        const activeSet = new Set(activeSessionIds);
        set((state) => {
          const enabled: Record<string, boolean> = {};
          const running: Record<string, boolean> = {};
          for (const id of Object.keys(state.enabled)) {
            if (activeSet.has(id)) enabled[id] = state.enabled[id];
          }
          for (const id of Object.keys(state.running)) {
            if (activeSet.has(id)) running[id] = state.running[id];
          }
          return { enabled, running };
        });
      },
    }),
    {
      name: 'tms-auto-approve',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);
