import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { createDurableStorage, DurableMirror } from './durableStorage.core.mjs';

// Rules and the reason for this file: see durableStorage.core.mjs.
// Only for small keys (servers, settings, terminal tabs) — every write also
// lands on disk. Big data (scrollback, chat history) stays AsyncStorage-only.

const DIR = `${FileSystem.documentDirectory}durable/`;
const fileOf = (key: string) => `${DIR}${encodeURIComponent(key)}.json`;

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch((e) => {
      dirReady = null;
      throw e;
    });
  }
  return dirReady;
}

/** A file only counts when it holds complete JSON — a write cut off mid-way must not be served. */
async function readValid(uri: string): Promise<string | null> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return null;
  const text = await FileSystem.readAsStringAsync(uri);
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

const fileMirror: DurableMirror = {
  async read(key) {
    const uri = fileOf(key);
    // The temp file is the fallback for a crash between writing it and the move.
    return (await readValid(uri)) ?? (await readValid(`${uri}.tmp`));
  },
  async write(key, value) {
    await ensureDir();
    const uri = fileOf(key);
    // Write next to the target, then swap: the old copy stays intact until the
    // new one is complete.
    await FileSystem.writeAsStringAsync(`${uri}.tmp`, value);
    await FileSystem.deleteAsync(uri, { idempotent: true });
    await FileSystem.moveAsync({ from: `${uri}.tmp`, to: uri });
  },
  async remove(key) {
    const uri = fileOf(key);
    await FileSystem.deleteAsync(uri, { idempotent: true });
    await FileSystem.deleteAsync(`${uri}.tmp`, { idempotent: true });
  },
};

export const durableStorage = createDurableStorage(AsyncStorage, fileMirror);

/** "Alle Daten löschen" must clear the copies too, or they would come back. */
export async function clearDurableStorage(): Promise<void> {
  await FileSystem.deleteAsync(DIR, { idempotent: true });
  dirReady = null;
}
