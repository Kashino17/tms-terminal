import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { durableStorage } from '../services/durableStorage';
import { createPersistHydration } from './persistHydration';

/** The UI must not mount before the stored settings have been read from disk. */
export const settingsHydration = createPersistHydration();

interface SettingsState {
  /** Route http(s) browser-opens from terminals to the in-app browser. Default: false. */
  browserBridgeEnabled: boolean;
  setBrowserBridgeEnabled: (enabled: boolean) => void;
  /** Grace period in seconds after unlock before re-locking. 0 = always lock. Default: 0. */
  lockGraceSeconds: number;
  setLockGrace: (seconds: number) => void;
  /** Keep WebSocket connection alive when app is backgrounded/closed. Default: true. */
  persistentConnection: boolean;
  setPersistentConnection: (enabled: boolean) => void;
  /** When true, voice transcripts are rewritten into polished AI prompts via the local rewriter sidecar. Default: false. */
  voicePromptEnhanceEnabled: boolean;
  setVoicePromptEnhanceEnabled: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      browserBridgeEnabled: false,
      setBrowserBridgeEnabled(enabled: boolean) {
        set({ browserBridgeEnabled: enabled });
      },
      lockGraceSeconds: 0,
      setLockGrace(seconds: number) {
        set({ lockGraceSeconds: seconds });
      },
      persistentConnection: true,
      setPersistentConnection(enabled: boolean) {
        set({ persistentConnection: enabled });
      },
      voicePromptEnhanceEnabled: false,
      setVoicePromptEnhanceEnabled(enabled: boolean) {
        set({ voicePromptEnhanceEnabled: enabled });
      },
    }),
    {
      name: 'tms-settings',
      // Also mirrored to a file: an AsyncStorage wipe must not lose this (durableStorage.core.mjs).
      storage: createJSONStorage(() => durableStorage),
      // Called on success AND on a failed read; finishHydration does not fire on errors.
      onRehydrateStorage: () => () => settingsHydration.complete(),
    },
  ),
);
