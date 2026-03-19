import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CERTS_DIR = path.join(__dirname, '..', 'certs');

export interface ServerConfig {
  passwordHash?: string;
  jwtSecret: string;
  port: number;
  certFingerprint?: string;
  jwtExpiry?: string;
}

export const config = {
  port: parseInt(process.env.PORT || '8767', 10),
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiry: '24h',
  configDir: CONFIG_DIR,
  configFile: CONFIG_FILE,
  certsDir: CERTS_DIR,
  certFile: path.join(CERTS_DIR, 'server.crt'),
  keyFile: path.join(CERTS_DIR, 'server.key'),
  rateLimitWindow: 60 * 1000, // 1 minute
  rateLimitMax: 5,
  rateLimitBlock: 15 * 60 * 1000, // 15 minutes
  outputBufferMs: 32, // batch more data per message — fewer WS frames, better for mobile
};

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadServerConfig(): Partial<ServerConfig> {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    console.warn(`Warning: failed to parse ${CONFIG_FILE}, using empty config`);
    return {};
  }
}

export function saveServerConfig(cfg: Partial<ServerConfig>): void {
  ensureConfigDir();
  const existing = loadServerConfig();
  const merged = { ...existing, ...cfg };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
