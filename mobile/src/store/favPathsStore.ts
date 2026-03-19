import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface FavPath {
  path: string;
  label: string;
}

interface FavPathsState {
  paths: FavPath[];
  add: (path: string, label?: string) => void;
  remove: (path: string) => void;
  isFav: (path: string) => boolean;
}

export const useFavPathsStore = create<FavPathsState>()(
  persist(
    (set, get) => ({
      paths: [],

      add(path, label) {
        if (get().paths.some((p) => p.path === path)) return;
        const name = label || path.split('/').filter(Boolean).pop() || path;
        set((s) => ({ paths: [...s.paths, { path, label: name }] }));
      },

      remove(path) {
        set((s) => ({ paths: s.paths.filter((p) => p.path !== path) }));
      },

      isFav(path) {
        return get().paths.some((p) => p.path === path);
      },
    }),
    {
      name: 'tms-fav-paths',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
