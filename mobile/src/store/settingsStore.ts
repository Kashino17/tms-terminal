import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsState {
  /** Idle threshold in seconds. 0 = notifications disabled. Default: 30. */
  idleThresholdSeconds: number;
  setIdleThreshold: (seconds: number) => void;
}

export const IDLE_THRESHOLD_OPTIONS = [
  { label: '30 Sekunden', value: 30 },
  { label: '1 Minute', value: 60 },
  { label: '2 Minuten', value: 120 },
  { label: '5 Minuten', value: 300 },
  { label: '10 Minuten', value: 600 },
  { label: 'Aus', value: 0 },
] as const;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      idleThresholdSeconds: 30,
      setIdleThreshold(seconds: number) {
        set({ idleThresholdSeconds: seconds });
      },
    }),
    {
      name: 'tms-settings',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
