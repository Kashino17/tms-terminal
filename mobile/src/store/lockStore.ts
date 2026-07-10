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

  async loadLockConfig() {
    const [[, enabled], [, hash]] = await AsyncStorage.multiGet([KEY_ENABLED, KEY_HASH]);
    const isEnabled = enabled === 'true';
    set({ ready: true, isEnabled, pinHash: hash, isUnlocked: !isEnabled });
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

  unlock() { set({ isUnlocked: true }); },
  lock()   { set({ isUnlocked: false }); },
}));
