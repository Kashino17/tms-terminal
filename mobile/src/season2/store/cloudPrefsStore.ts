/**
 * Season 2 cloud preferences — favorite projects (float to top), persisted
 * under a season2-own key. Keyed `${platform}:${projectId}`.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface CloudPrefsState {
  favorites: Record<string, true>;
  /** User-managed folder per project key (original user pain point). */
  folders: Record<string, string>;
  toggleFavorite: (key: string) => void;
  isFavorite: (key: string) => boolean;
  setFolder: (key: string, folder: string | null) => void;
}

export const useCloudPrefsStore = create<CloudPrefsState>()(
  persist(
    (set, get) => ({
      favorites: {},
      folders: {},
      toggleFavorite(key) {
        set((s) => {
          const next = { ...s.favorites };
          if (next[key]) delete next[key];
          else next[key] = true;
          return { favorites: next };
        });
      },
      isFavorite(key) {
        return !!get().favorites[key];
      },
      setFolder(key, folder) {
        set((s) => {
          const next = { ...s.folders };
          const name = folder?.trim();
          if (!name) delete next[key];
          else next[key] = name;
          return { folders: next };
        });
      },
    }),
    {
      name: 'tms-s2-cloud',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
