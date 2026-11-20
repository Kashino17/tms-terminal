import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { storageService } from './storage.service';
import { runLegacyCleanup } from './legacyCleanup.core.mjs';

// What is removed and why: see legacyCleanup.core.mjs.

/** Runs once per install; a failed run is retried on the next app start. */
export async function cleanupLegacyData(): Promise<void> {
  const cache = FileSystem.cacheDirectory;
  await runLegacyCleanup({
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    getAllKeys: () => AsyncStorage.getAllKeys(),
    multiRemove: (keys) => AsyncStorage.multiRemove(keys),
    deleteSecure: (key) => SecureStore.deleteItemAsync(key),
    serverIds: async () => (await storageService.getServers()).map((s) => s.id),
    cacheFiles: async () => (cache ? FileSystem.readDirectoryAsync(cache) : []),
    deleteCacheFile: (name) => FileSystem.deleteAsync(`${cache}${name}`, { idempotent: true }),
  });
}
