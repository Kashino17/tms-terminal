import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger';
import type { CloudConfig } from './cloud.types';

const CONFIG_FILE = path.join(os.homedir(), '.tms-terminal', 'config.json');

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  enabled: true,
  silenceDebounceMs: 1500,
  remWriteCooldownMs: 3000,
  rateLimitMax: 5,
  rateLimitWindowMs: 120_000,
  minBufferDeltaChars: 500,
  llmProvider: 'anthropic',
  llmModel: 'claude-haiku-4-5-20251001',
  llmTimeoutMs: 5000,
  templateOnly: false,
};

export function loadCloudConfig(): CloudConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CLOUD_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const block = (raw?.cloud ?? {}) as Partial<CloudConfig>;
    return { ...DEFAULT_CLOUD_CONFIG, ...block };
  } catch (err) {
    logger.warn(`[cloud.config] Failed to load, using defaults: ${err}`);
    return { ...DEFAULT_CLOUD_CONFIG };
  }
}
