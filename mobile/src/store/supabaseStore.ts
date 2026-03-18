import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'tms:supabase_v1';
const TOKEN_PREFIX = 'supabase-token-';

export interface SupabaseConnection {
  id: string;
  name: string;
  projectRef: string;   // e.g. "abcdefghijklmnop" (subdomain of *.supabase.co)
  accessToken: string;  // Personal access token from app.supabase.com/account/tokens
}

interface SupabaseState {
  connections: SupabaseConnection[];
  assignments: Record<string, string>; // serverId → connectionId
  loaded: boolean;
  load: () => Promise<void>;
  addConnection: (name: string, projectRef: string, accessToken: string) => void;
  removeConnection: (id: string) => void;
  assignToServer: (serverId: string, connectionId: string | null) => void;
  getAssigned: (serverId: string) => SupabaseConnection | undefined;
}

// ── Token helpers — SecureStore with AsyncStorage fallback ────────────────────
async function saveToken(id: string, token: string): Promise<void> {
  // Try SecureStore first (encrypted), fall back to AsyncStorage
  try {
    await SecureStore.setItemAsync(`${TOKEN_PREFIX}${id}`, token);
  } catch {
    // SecureStore unavailable (emulator etc.) — use AsyncStorage fallback
  }
  // Always save to AsyncStorage as fallback
  await AsyncStorage.setItem(`${TOKEN_PREFIX}${id}`, token).catch(() => {});
}

async function loadToken(id: string): Promise<string> {
  // Try SecureStore first
  try {
    const secure = await SecureStore.getItemAsync(`${TOKEN_PREFIX}${id}`);
    if (secure) return secure;
  } catch {
    // SecureStore unavailable
  }
  // Fall back to AsyncStorage
  try {
    const fallback = await AsyncStorage.getItem(`${TOKEN_PREFIX}${id}`);
    if (fallback) return fallback;
  } catch {
    // Both failed
  }
  return '';
}

async function deleteToken(id: string): Promise<void> {
  SecureStore.deleteItemAsync(`${TOKEN_PREFIX}${id}`).catch(() => {});
  AsyncStorage.removeItem(`${TOKEN_PREFIX}${id}`).catch(() => {});
}

// ── Persist connections (without tokens) and assignments ──────────────────────
function persist(connections: SupabaseConnection[], assignments: Record<string, string>) {
  const stripped = connections.map(({ accessToken: _, ...rest }) => rest);
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ connections: stripped, assignments })).catch(() => {});
}

export const useSupabaseStore = create<SupabaseState>((set, get) => ({
  connections: [],
  assignments: {},
  loaded: false,

  async load() {
    if (get().loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const persisted: Omit<SupabaseConnection, 'accessToken'>[] = parsed.connections ?? [];
        // Hydrate tokens from SecureStore → AsyncStorage fallback
        const connections: SupabaseConnection[] = await Promise.all(
          persisted.map(async (c) => ({
            ...c,
            accessToken: await loadToken(c.id),
          })),
        );
        set({
          connections,
          assignments: parsed.assignments ?? {},
          loaded: true,
        });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  addConnection(name, projectRef, accessToken) {
    const conn: SupabaseConnection = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name.trim(),
      projectRef: projectRef.trim(),
      accessToken: accessToken.trim(),
    };
    saveToken(conn.id, conn.accessToken);
    const connections = [...get().connections, conn];
    set({ connections });
    persist(connections, get().assignments);
  },

  removeConnection(id) {
    deleteToken(id);
    const connections = get().connections.filter((c) => c.id !== id);
    const assignments = { ...get().assignments };
    for (const key of Object.keys(assignments)) {
      if (assignments[key] === id) delete assignments[key];
    }
    set({ connections, assignments });
    persist(connections, assignments);
  },

  assignToServer(serverId, connectionId) {
    const assignments = { ...get().assignments };
    if (connectionId === null) {
      delete assignments[serverId];
    } else {
      assignments[serverId] = connectionId;
    }
    set({ assignments });
    persist(get().connections, assignments);
  },

  getAssigned(serverId) {
    const { connections, assignments } = get();
    const id = assignments[serverId];
    return id ? connections.find((c) => c.id === id) : undefined;
  },
}));
