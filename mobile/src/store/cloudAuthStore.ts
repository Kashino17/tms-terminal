import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CloudPlatform = 'render' | 'vercel';

interface CloudAuthState {
  tokens: Record<CloudPlatform, string | null>;
  activeOwnerId: Record<CloudPlatform, string | null>;
  notificationsEnabled: boolean;
  pollingIntervalMs: number;

  setToken: (platform: CloudPlatform, token: string | null) => void;
  setActiveOwnerId: (platform: CloudPlatform, ownerId: string | null) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setPollingIntervalMs: (ms: number) => void;
  clearPlatform: (platform: CloudPlatform) => void;
}

export const useCloudAuthStore = create<CloudAuthState>()(
  persist(
    (set, get) => ({
      tokens: { render: null, vercel: null },
      activeOwnerId: { render: null, vercel: null },
      notificationsEnabled: true,
      pollingIntervalMs: 120_000,

      setToken: (platform, token) =>
        set({ tokens: { ...get().tokens, [platform]: token } }),

      setActiveOwnerId: (platform, ownerId) =>
        set({ activeOwnerId: { ...get().activeOwnerId, [platform]: ownerId } }),

      setNotificationsEnabled: (enabled) =>
        set({ notificationsEnabled: enabled }),

      setPollingIntervalMs: (ms) =>
        set({ pollingIntervalMs: ms }),

      clearPlatform: (platform) =>
        set({
          tokens: { ...get().tokens, [platform]: null },
          activeOwnerId: { ...get().activeOwnerId, [platform]: null },
        }),
    }),
    {
      name: 'tms-cloud-auth',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
