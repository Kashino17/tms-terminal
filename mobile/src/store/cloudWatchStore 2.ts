import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CloudPlatform } from './cloudAuthStore';
import type { DeploymentStatus } from '../services/cloud.types';

export interface WatchedDeployment {
  deployId: string;
  projectId: string;
  projectName: string;
  platform: CloudPlatform;
  status: DeploymentStatus;
  addedAt: number;
}

interface CloudWatchState {
  watched: WatchedDeployment[];

  addWatch: (deploy: WatchedDeployment) => void;
  removeWatch: (deployId: string) => void;
  updateStatus: (deployId: string, status: DeploymentStatus) => void;
  getActiveWatches: () => WatchedDeployment[];
  clearAll: () => void;
}

export const useCloudWatchStore = create<CloudWatchState>()(
  persist(
    (set, get) => ({
      watched: [],

      addWatch: (deploy) => {
        const existing = get().watched.find((w) => w.deployId === deploy.deployId);
        if (existing) return;
        set({ watched: [...get().watched, deploy] });
      },

      removeWatch: (deployId) =>
        set({ watched: get().watched.filter((w) => w.deployId !== deployId) }),

      updateStatus: (deployId, status) =>
        set({
          watched: get().watched.map((w) =>
            w.deployId === deployId ? { ...w, status } : w,
          ),
        }),

      getActiveWatches: () =>
        get().watched.filter((w) => w.status === 'building' || w.status === 'queued'),

      clearAll: () => set({ watched: [] }),
    }),
    {
      name: 'tms-cloud-watch',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
