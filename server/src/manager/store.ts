import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

/** All Stufe-1 manager state lives here. */
export const MANAGER_DIR = path.join(os.homedir(), '.tms-terminal', 'manager');

/** Corruption notices waiting to be reported to the user. Drained by the caller. */
const corruptionReports: string[] = [];

export function takeCorruptionReports(): string[] {
  return corruptionReports.splice(0, corruptionReports.length);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Read a JSON store. A missing file yields the fallback silently.
 * A corrupt file is moved aside (never deleted) and reported — user data must
 * never disappear without the user hearing about it.
 */
export function readStore<T>(fileName: string, fallback: T, dir: string = MANAGER_DIR): T {
  const file = path.join(dir, fileName);
  if (!fs.existsSync(file)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, quarantine);
      corruptionReports.push(
        `Die Datei ${fileName} war beschädigt. Sie liegt jetzt als ${path.basename(quarantine)} daneben, ` +
        `und ich habe leer neu angefangen.`,
      );
      logger.error(`[manager-store] ${fileName} corrupt → quarantined as ${path.basename(quarantine)}`);
    } catch (renameErr) {
      const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      logger.error(`[manager-store] could not quarantine ${fileName}: ${msg}`);
    }
    return fallback;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written store. */
export function writeStore<T>(fileName: string, data: T, dir: string = MANAGER_DIR): void {
  ensureDir(dir);
  const file = path.join(dir, fileName);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
