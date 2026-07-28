import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger';
import type { Snapshot } from './snapshot.types';

export const TMS_DIR = path.join(os.homedir(), '.tms-terminal');
export const SNAPSHOT_FILE = 'terminals.json';

/**
 * Read the snapshot. A corrupt file is moved aside rather than deleted — it may
 * be the only record of what was open, and a human can still look at it.
 */
export function readSnapshot(dir: string = TMS_DIR): Snapshot | null {
  const file = path.join(dir, SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Snapshot;
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.renameSync(file, `${file}.corrupt-${stamp}`);
      logger.warn(`[restore] ${SNAPSHOT_FILE} war beschädigt — beiseitegelegt`);
    } catch { /* nothing we can do */ }
    return null;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves half a snapshot. */
export function writeSnapshot(snapshot: Snapshot, dir: string = TMS_DIR): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, SNAPSHOT_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Read and immediately remove. The content is in memory by then, and deleting
 * before anything is created means a crash mid-restore cannot repeat forever.
 */
export function consumeSnapshot(dir: string = TMS_DIR): Snapshot | null {
  const snapshot = readSnapshot(dir);
  if (snapshot === null) return null;
  try {
    fs.unlinkSync(path.join(dir, SNAPSHOT_FILE));
  } catch { /* already gone — fine */ }
  return snapshot;
}
