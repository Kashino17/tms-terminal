import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const KEY_ENABLED = 'tms:lockEnabled';
const KEY_HASH    = 'tms:pinHash';

/** Application-specific salt for PIN hashing. */
const PIN_SALT = 'tms-terminal-v1:x9F!kL2m@Qp7wZrB3nYj';

/** Hash a PIN using SHA-256 with a salt for secure storage. */
async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    PIN_SALT + pin,
  );
}

interface LockState {
  /** False until loadLockConfig resolves — prevents unlock-flash on startup. */
  ready: boolean;
  isEnabled: boolean;
  pinHash: string | null;
  /** Runtime-only — true when the user has authenticated this session. */
  isUnlocked: boolean;
  /** Timestamp of last successful unlock (ms since epoch). */
  lastUnlockTime: number;

  loadLockConfig: () => Promise<void>;
  enable: (pin: string) => Promise<void>;
  disable: () => Promise<void>;
  changePin: (newPin: string) => Promise<void>;
  verifyPin: (pin: string) => Promise<boolean>;
  unlock: () => void;
  lock: () => void;
}

export const useLockStore = create<LockState>((set, get) => ({
  ready: false,
  isEnabled: false,
  pinHash: null,
  isUnlocked: true,
  lastUnlockTime: 0,

  async loadLockConfig() {
    // Defensive: after a native crash, AsyncStorage's SQLite state can be left
    // in a bad place — multiGet may hang or throw. Without this guard, `ready`
    // stays false forever and the app is stuck on a blank background screen
    // (see App.tsx gate). Race against a short timeout and fall back to
    // "start unlocked" so the user can always recover access.
    const LOAD_TIMEOUT_MS = 3_000;
    try {
      const loadPromise = AsyncStorage.multiGet([KEY_ENABLED, KEY_HASH]);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`loadLockConfig timed out after ${LOAD_TIMEOUT_MS}ms`)), LOAD_TIMEOUT_MS),
      );
      const result = await Promise.race([loadPromise, timeoutPromise]);
      const [[, enabled], [, hash]] = result;
      const isEnabled = enabled === 'true';
      set({ ready: true, isEnabled, pinHash: hash, isUnlocked: !isEnabled });
    } catch (err) {
      // In-memory fallback only — AsyncStorage is NOT modified. Next app start
      // will try loadLockConfig again; if storage has recovered, the real PIN
      // state returns. We keep pinHash=null in memory so no stale hash can be
      // treated as valid while we're in the degraded state.
      console.warn('[lockStore] loadLockConfig failed, starting with lock disabled:', err);
      set({ ready: true, isEnabled: false, pinHash: null, isUnlocked: true });
    }
  },

  async enable(pin: string) {
    const hash = await hashPin(pin);
    await AsyncStorage.multiSet([[KEY_ENABLED, 'true'], [KEY_HASH, hash]]);
    set({ isEnabled: true, pinHash: hash });
  },

  async disable() {
    await AsyncStorage.multiRemove([KEY_ENABLED, KEY_HASH]);
    set({ isEnabled: false, pinHash: null, isUnlocked: true });
  },

  async changePin(newPin: string) {
    const hash = await hashPin(newPin);
    await AsyncStorage.setItem(KEY_HASH, hash);
    set({ pinHash: hash });
  },

  async verifyPin(pin: string) {
    const { pinHash } = get();
    if (!pinHash) return false;
    const hash = await hashPin(pin);
    return hash === pinHash;
  },

  unlock() { set({ isUnlocked: true, lastUnlockTime: Date.now() }); },
  lock()   { set({ isUnlocked: false }); },
}));
