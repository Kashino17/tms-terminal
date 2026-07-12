/**
 * Season 2 UI preferences — terminal font size etc., persisted under a
 * season2-own key (classic settings untouched).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface UiPrefsState {
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
}

export const useUiPrefsStore = create<UiPrefsState>()(
  persist(
    (set) => ({
      terminalFontSize: 14,
      setTerminalFontSize(size) {
        set({ terminalFontSize: Math.min(22, Math.max(10, Math.round(size))) });
      },
    }),
    {
      name: 'tms-s2-uiprefs',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
