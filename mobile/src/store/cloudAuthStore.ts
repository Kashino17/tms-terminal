import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export type CloudPlatform = 'render' | 'vercel';

// API keys live in the OS keychain/keystore (like the server tokens in
// storage.service.ts), NOT in the AsyncStorage JSON this store persists.
const SECURE_PREFIX = 'tms_cloud_token_';
const PLATFORMS: CloudPlatform[] = ['render', 'vercel'];

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

      setToken: (platform, token) => {
        if (token) SecureStore.setItemAsync(SECURE_PREFIX + platform, token).catch(() => {});
        else SecureStore.deleteItemAsync(SECURE_PREFIX + platform).catch(() => {});
        set({ tokens: { ...get().tokens, [platform]: token } });
      },

      setActiveOwnerId: (platform, ownerId) =>
        set({ activeOwnerId: { ...get().activeOwnerId, [platform]: ownerId } }),

      setNotificationsEnabled: (enabled) =>
        set({ notificationsEnabled: enabled }),

      setPollingIntervalMs: (ms) =>
        set({ pollingIntervalMs: ms }),

      clearPlatform: (platform) => {
        SecureStore.deleteItemAsync(SECURE_PREFIX + platform).catch(() => {});
        set({
          tokens: { ...get().tokens, [platform]: null },
          activeOwnerId: { ...get().activeOwnerId, [platform]: null },
        });
      },
    }),
    {
      name: 'tms-cloud-auth',
      storage: createJSONStorage(() => AsyncStorage),
      // Tokens are deliberately NOT part of the persisted JSON.
      partialize: (s) => ({
        activeOwnerId: s.activeOwnerId,
        notificationsEnabled: s.notificationsEnabled,
        pollingIntervalMs: s.pollingIntervalMs,
      }) as CloudAuthState,
    },
  ),
);

/**
 * Loads tokens from SecureStore into the store. One-time migration: tokens
 * that older versions persisted in the AsyncStorage JSON are moved into
 * SecureStore and stripped from the JSON.
 */
export async function hydrateCloudTokens(): Promise<void> {
  const tokens: Record<CloudPlatform, string | null> = { render: null, vercel: null };
  for (const p of PLATFORMS) {
    tokens[p] = await SecureStore.getItemAsync(SECURE_PREFIX + p).catch(() => null);
  }
  try {
    const raw = await AsyncStorage.getItem('tms-cloud-auth');
    if (raw) {
      const parsed = JSON.parse(raw);
      const legacy = parsed?.state?.tokens as Partial<Record<CloudPlatform, string>> | undefined;
      if (legacy) {
        for (const p of PLATFORMS) {
          if (!tokens[p] && legacy[p]) {
            tokens[p] = legacy[p]!;
            await SecureStore.setItemAsync(SECURE_PREFIX + p, legacy[p]!);
          }
        }
        delete parsed.state.tokens;
        await AsyncStorage.setItem('tms-cloud-auth', JSON.stringify(parsed));
      }
    }
  } catch { /* corrupt legacy JSON: keep whatever SecureStore had */ }
  useCloudAuthStore.setState({ tokens });
}

hydrateCloudTokens().catch(() => {});
