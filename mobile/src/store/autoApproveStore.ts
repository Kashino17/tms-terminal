import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface AutoApproveState {
  /** sessionId → true if auto-approve is enabled */
  enabled: Record<string, boolean>;

  /** sessionId → true while a 3×Enter sequence is running (prevents re-trigger) */
  running: Record<string, boolean>;

  /** sessionId → timestamp when user last typed in this session.
   *  Auto-approve is paused while Date.now() - lastTyped < TYPING_PAUSE_MS */
  typingUntil: Record<string, number>;

  toggle: (sessionId: string) => void;
  setEnabled: (sessionId: string, on: boolean) => void;
  isEnabled: (sessionId: string) => boolean;

  setRunning: (sessionId: string, on: boolean) => void;
  isRunning: (sessionId: string) => boolean;

  /** Mark that the user is actively typing in this session.
   *  Auto-approve pauses for TYPING_PAUSE_MS after the last keystroke. */
  markTyping: (sessionId: string) => void;

  /** Check if auto-approve is currently paused due to user typing */
  isTyping: (sessionId: string) => boolean;

  /** Clean up when a session is destroyed */
  clear: (sessionId: string) => void;

  /** Remove entries for sessions not in the active list. Call on app startup. */
  cleanup: (activeSessionIds: string[]) => void;
}

/** How long (ms) to pause auto-approve after the user's last keystroke in a session */
const TYPING_PAUSE_MS = 2000;

export const useAutoApproveStore = create<AutoApproveState>()(
  persist(
    (set, get) => ({
      enabled: {},
      running: {},
      typingUntil: {},

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

      markTyping(sessionId) {
        set({ typingUntil: { ...get().typingUntil, [sessionId]: Date.now() + TYPING_PAUSE_MS } });
      },

      isTyping(sessionId) {
        const until = get().typingUntil[sessionId];
        return !!until && Date.now() < until;
      },

      clear(sessionId) {
        set((state) => {
          const { [sessionId]: _e, ...restEnabled } = state.enabled;
          const { [sessionId]: _r, ...restRunning } = state.running;
          const { [sessionId]: _t, ...restTyping } = state.typingUntil;
          return { enabled: restEnabled, running: restRunning, typingUntil: restTyping };
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
