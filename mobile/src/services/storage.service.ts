import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { ServerProfile } from '../types/server.types';

const SERVERS_KEY = 'tms_servers';
const TOKEN_PREFIX = 'tms_token_';

export const storageService = {
  async getServers(): Promise<ServerProfile[]> {
    try {
      const data = await AsyncStorage.getItem(SERVERS_KEY);
      const servers: ServerProfile[] = data ? JSON.parse(data) : [];
      // Hydrate tokens from SecureStore
      for (const server of servers) {
        const token = await getToken(server.id);
        if (token) {
          server.token = token;
        }
      }
      return servers;
    } catch {
      return [];
    }
  },

  async saveServers(servers: ServerProfile[]): Promise<void> {
    // Strip tokens before writing to AsyncStorage
    const stripped = servers.map(({ token: _, ...rest }) => rest);
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(stripped));
  },

  async addServer(server: ServerProfile): Promise<void> {
    // Save token to SecureStore if present
    if (server.token) {
      await saveToken(server.id, server.token);
    }
    const servers = await this.getServers();
    servers.push(server);
    await this.saveServers(servers);
  },

  async updateServer(id: string, updates: Partial<ServerProfile>): Promise<void> {
    // If updating the token, save it to SecureStore
    if (updates.token) {
      await saveToken(id, updates.token);
    }
    const servers = await this.getServers();
    const index = servers.findIndex((s) => s.id === id);
    if (index >= 0) {
      servers[index] = { ...servers[index], ...updates };
      await this.saveServers(servers);
    }
  },

  async deleteServer(id: string): Promise<void> {
    const servers = await this.getServers();
    await this.saveServers(servers.filter((s) => s.id !== id));
    // Also remove token from SecureStore
    await deleteToken(id);
  },
};

// ── Secure token storage ────────────────────────────────────────────────────
// Tokens are stored in the OS keychain/keystore via expo-secure-store,
// NOT in AsyncStorage. Server profiles in AsyncStorage have their token field
// stripped; callers should use these functions to read/write tokens separately.

/** Store a server token securely in the OS keychain/keystore. */
export async function saveToken(serverId: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(`${TOKEN_PREFIX}${serverId}`, token);
}

/** Retrieve a server token from secure storage. Returns null if not found. */
export async function getToken(serverId: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${TOKEN_PREFIX}${serverId}`);
}

/** Delete a server token from secure storage. */
export async function deleteToken(serverId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${TOKEN_PREFIX}${serverId}`);
}
