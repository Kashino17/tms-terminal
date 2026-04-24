import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProviderConfig } from './ai-provider';
import { encryptApiKey, decryptApiKey, isEncrypted } from '../utils/crypto';
import { logger } from '../utils/logger';

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const MANAGER_CONFIG_FILE = path.join(CONFIG_DIR, 'manager.json');

const API_KEY_FIELDS: (keyof ProviderConfig)[] = ['kimiApiKey', 'glmApiKey', 'openaiApiKey'];

/** Load manager config. API keys are transparently decrypted. */
export function loadManagerConfig(): ProviderConfig {
  try {
    if (fs.existsSync(MANAGER_CONFIG_FILE)) {
      const raw: ProviderConfig = JSON.parse(fs.readFileSync(MANAGER_CONFIG_FILE, 'utf-8'));

      // Decrypt API keys
      let needsMigration = false;
      for (const field of API_KEY_FIELDS) {
        const val = raw[field];
        if (typeof val === 'string' && val.length > 0) {
          if (isEncrypted(val)) {
            (raw as Record<string, string>)[field] = decryptApiKey(val);
          } else {
            // Plaintext key — mark for migration
            needsMigration = true;
          }
        }
      }

      // Auto-migrate: re-save with encryption if any keys were plaintext
      if (needsMigration) {
        logger.info('Manager config: migrating plaintext API keys to encrypted storage');
        saveManagerConfigRaw(raw);
      }

      return raw;
    }
  } catch (err) {
    logger.warn(`Failed to load manager config: ${err instanceof Error ? err.message : err}`);
  }
  return {};
}

/** Whether push notifications should bypass ManagerPushDecider (no screen-state check,
 *  no debounce, every manager-reply + tool-completion fires immediately). Env var
 *  `PUSH_INSTANT_MODE=1` overrides the config file. See decisions.md (2026-04-24). */
export function isPushInstantMode(): boolean {
  const env = process.env.PUSH_INSTANT_MODE;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return loadManagerConfig().pushInstantMode === true;
}

/** Save manager config. API keys are encrypted before writing to disk. */
export function saveManagerConfig(config: ProviderConfig): void {
  const existing = loadManagerConfig(); // loads + decrypts
  const merged = { ...existing, ...config };
  saveManagerConfigRaw(merged);
}

/** Internal: write config to disk with API keys encrypted. */
function saveManagerConfigRaw(config: ProviderConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  // Encrypt API keys before writing
  const toWrite = { ...config };
  for (const field of API_KEY_FIELDS) {
    const val = toWrite[field];
    if (typeof val === 'string' && val.length > 0 && !isEncrypted(val)) {
      try {
        (toWrite as Record<string, string>)[field] = encryptApiKey(val);
      } catch (err) {
        logger.warn(`Failed to encrypt ${field}: ${err instanceof Error ? err.message : err}`);
        // Keep plaintext as fallback rather than losing the key
      }
    }
  }

  fs.writeFileSync(MANAGER_CONFIG_FILE, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
}
