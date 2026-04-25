import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsState {
  /** Idle threshold in seconds. 0 = notifications disabled. Default: 30. */
  idleThresholdSeconds: number;
  setIdleThreshold: (seconds: number) => void;
  /** Terminal color theme id. Default: 'default'. */
  terminalTheme: string;
  setTerminalTheme: (id: string) => void;
  /** Whether the microphone button is shown in the toolbar. Default: true. */
  audioInputEnabled: boolean;
  setAudioInputEnabled: (enabled: boolean) => void;
  /** Whether virtual keyboard is suppressed in terminal (for external keyboards). Default: false. */
  externalKeyboardMode: boolean;
  setExternalKeyboardMode: (enabled: boolean) => void;
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

export const IDLE_THRESHOLD_OPTIONS = [
  { label: '30 Sekunden', value: 30 },
  { label: '1 Minute', value: 60 },
  { label: '2 Minuten', value: 120 },
  { label: '5 Minuten', value: 300 },
  { label: '10 Minuten', value: 600 },
  { label: 'Aus', value: 0 },
] as const;

export const LOCK_GRACE_OPTIONS = [
  { label: 'Immer sperren', value: 0 },
  { label: '5 Minuten', value: 300 },
  { label: '10 Minuten', value: 600 },
  { label: '1 Stunde', value: 3600 },
  { label: '2 Stunden', value: 7200 },
] as const;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      idleThresholdSeconds: 30,
      setIdleThreshold(seconds: number) {
        set({ idleThresholdSeconds: seconds });
      },
      terminalTheme: 'default',
      setTerminalTheme(id: string) {
        set({ terminalTheme: id });
      },
      audioInputEnabled: true,
      setAudioInputEnabled(enabled: boolean) {
        set({ audioInputEnabled: enabled });
      },
      externalKeyboardMode: false,
      setExternalKeyboardMode(enabled: boolean) {
        set({ externalKeyboardMode: enabled });
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
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
