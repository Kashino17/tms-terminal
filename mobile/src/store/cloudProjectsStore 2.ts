import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CloudPlatform } from './cloudAuthStore';
import type { Project } from '../services/cloud.types';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedProjects {
  items: Project[];
  cursor?: string;
  fetchedAt: number;
}

interface CloudProjectsState {
  cache: Record<string, CachedProjects>;
  selectedProjectId: Record<CloudPlatform, string | null>;

  getCacheKey: (platform: CloudPlatform, ownerId: string) => string;
  getProjects: (platform: CloudPlatform, ownerId: string) => CachedProjects | null;
  isStale: (platform: CloudPlatform, ownerId: string) => boolean;
  setProjects: (platform: CloudPlatform, ownerId: string, data: CachedProjects) => void;
  appendProjects: (platform: CloudPlatform, ownerId: string, items: Project[], cursor?: string) => void;
  setSelectedProjectId: (platform: CloudPlatform, projectId: string | null) => void;
  clearCache: (platform: CloudPlatform) => void;
}

export const useCloudProjectsStore = create<CloudProjectsState>()(
  persist(
    (set, get) => ({
      cache: {},
      selectedProjectId: { render: null, vercel: null },

      getCacheKey: (platform, ownerId) => `${platform}:${ownerId}`,

      getProjects: (platform, ownerId) => {
        const key = `${platform}:${ownerId}`;
        return get().cache[key] ?? null;
      },

      isStale: (platform, ownerId) => {
        const key = `${platform}:${ownerId}`;
        const cached = get().cache[key];
        if (!cached) return true;
        return Date.now() - cached.fetchedAt > CACHE_TTL_MS;
      },

      setProjects: (platform, ownerId, data) => {
        const key = `${platform}:${ownerId}`;
        set({ cache: { ...get().cache, [key]: data } });
      },

      appendProjects: (platform, ownerId, items, cursor) => {
        const key = `${platform}:${ownerId}`;
        const existing = get().cache[key];
        if (!existing) return;
        set({
          cache: {
            ...get().cache,
            [key]: {
              ...existing,
              items: [...existing.items, ...items],
              cursor,
            },
          },
        });
      },

      setSelectedProjectId: (platform, projectId) =>
        set({ selectedProjectId: { ...get().selectedProjectId, [platform]: projectId } }),

      clearCache: (platform) => {
        const newCache = { ...get().cache };
        for (const key of Object.keys(newCache)) {
          if (key.startsWith(`${platform}:`)) delete newCache[key];
        }
        set({ cache: newCache, selectedProjectId: { ...get().selectedProjectId, [platform]: null } });
      },
    }),
    {
      name: 'tms-cloud-projects',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ cache: state.cache }),
    },
  ),
);
