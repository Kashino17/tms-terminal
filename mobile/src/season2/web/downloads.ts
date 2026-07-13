// Real downloads land in a user-granted folder (Android SAF), asked once.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

const DIR_KEY = 'tms:downloadsDirUri';
const SAF = FileSystem.StorageAccessFramework;

export async function ensureDownloadsDir(): Promise<string | null> {
  const saved = await AsyncStorage.getItem(DIR_KEY);
  if (saved) return saved;
  const perm = await SAF.requestDirectoryPermissionsAsync();
  if (!perm.granted) return null;
  await AsyncStorage.setItem(DIR_KEY, perm.directoryUri);
  return perm.directoryUri;
}

/** Copy a finished cache download into the granted folder. Throws on failure. */
export async function saveToDownloads(cacheUri: string, filename: string, mime: string): Promise<void> {
  const dir = await ensureDownloadsDir();
  if (!dir) throw new Error('saf-denied');
  const target = await SAF.createFileAsync(dir, filename, mime);
  try {
    // Native stream copy — no JS memory involved.
    await FileSystem.copyAsync({ from: cacheUri, to: target });
  } catch {
    // Fallback via base64 for small files only (JS bridge limit).
    const info = await FileSystem.getInfoAsync(cacheUri);
    if (!info.exists || (info.size ?? 0) > 100 * 1024 * 1024) throw new Error('copy-failed');
    const b64 = await FileSystem.readAsStringAsync(cacheUri, { encoding: FileSystem.EncodingType.Base64 });
    await SAF.writeAsStringAsync(target, b64, { encoding: FileSystem.EncodingType.Base64 });
  }
}
