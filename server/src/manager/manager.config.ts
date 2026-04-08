import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProviderConfig } from './ai-provider';

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const MANAGER_CONFIG_FILE = path.join(CONFIG_DIR, 'manager.json');

export function loadManagerConfig(): ProviderConfig {
  try {
    if (fs.existsSync(MANAGER_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(MANAGER_CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // ignore parse errors
  }
  return {};
}

export function saveManagerConfig(config: ProviderConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const existing = loadManagerConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(MANAGER_CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
