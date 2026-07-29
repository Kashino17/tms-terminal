import { logger } from '../../utils/logger';
import type { Snapshot, SnapshotEntry } from './snapshot.types';

/** Older than this and the snapshot is not restored — you do not want yesterday's terminals. */
export const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000;
/** If a shell never looks ready, send anyway rather than hanging forever. */
export const READY_TIMEOUT_MS = 5000;

export interface RestoreResult {
  restored: string[];
  resumed: string[];
  /** Sessions that were cut off mid-work — they now wait for input. */
  interrupted: string[];
  failed: Array<{ id: string; reason: string }>;
  skipped?: 'none' | 'stale' | 'other-server';
}

export interface RestoreDeps {
  now: () => number;
  takeSnapshot: () => Snapshot | null;
  isPidAlive: (pid: number) => boolean;
  /** Returns false when the session could not be created. */
  createSession: (
    entry: { id: string; cwd: string; cols: number; rows: number },
    onOutput: (data: string) => void,
  ) => boolean;
  writeToSession: (id: string, data: string) => void;
  /** Writes a line into the OUTPUT stream — not into the shell, so it stays out of the history. */
  markSession: (id: string, text: string) => void;
  /** Setzt den gespeicherten Auto-Approve-Schalter wieder. */
  applyAutoApprove?: (id: string, on: boolean) => void;
  maxSessions: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

/**
 * A freshly spawned shell is not ready at once — zsh loads .zshrc, plugins and
 * prompt themes. Writing too early loses the command.
 *
 * Same approach as the delegated-task machinery in manager.service.ts: wait for
 * the EVENT (prompt-looking output), not for a clock. A fixed delay would be
 * wrong on both ends — 200 ms warm, seconds with a cold cache.
 */
export function looksReady(chunk: string): boolean {
  const tail = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
  if (tail === '') return false;
  return /[$%>#❯›]$/.test(tail);
}

export async function restoreTerminals(deps: RestoreDeps): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], resumed: [], interrupted: [], failed: [] };

  const snapshot = deps.takeSnapshot();
  if (snapshot === null) {
    result.skipped = 'none';
    return result;
  }

  const age = deps.now() - snapshot.capturedAt;
  if (age > MAX_SNAPSHOT_AGE_MS) {
    logger.info(`[restore] Aufnahme ist ${Math.round(age / 60_000)} Min alt — verworfen`);
    result.skipped = 'stale';
    return result;
  }

  if (deps.isPidAlive(snapshot.serverPid)) {
    logger.warn(`[restore] Server ${snapshot.serverPid} lebt noch — keine Wiederherstellung`);
    result.skipped = 'other-server';
    return result;
  }

  const schedule = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));

  for (const entry of snapshot.entries) {
    if (result.restored.length >= deps.maxSessions) {
      result.failed.push({ id: entry.id, reason: 'Sitzungs-Grenze erreicht' });
      continue;
    }
    restoreOne(entry, deps, result, schedule);
  }

  logger.info(
    `[restore] ${result.restored.length} Terminal(s) wiederhergestellt, ` +
    `${result.resumed.length} Claude-Sitzung(en) fortgesetzt, ${result.failed.length} Fehler`,
  );
  return result;
}

function restoreOne(
  entry: SnapshotEntry,
  deps: RestoreDeps,
  result: RestoreResult,
  schedule: (fn: () => void, ms: number) => unknown,
): void {
  const command = entry.claude !== undefined
    ? `claude --resume ${entry.claude.sessionId}\r`
    : null;

  let sent = false;
  const sendOnce = (): void => {
    if (sent || command === null) return;
    sent = true;
    try {
      deps.writeToSession(entry.id, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ id: entry.id, reason: `Resume fehlgeschlagen: ${msg}` });
    }
  };

  const ok = deps.createSession(
    { id: entry.id, cwd: entry.cwd, cols: entry.cols, rows: entry.rows },
    (data) => { if (looksReady(data)) sendOnce(); },
  );

  if (!ok) {
    result.failed.push({ id: entry.id, reason: 'Session ließ sich nicht anlegen' });
    return;
  }

  result.restored.push(entry.id);

  if (entry.autoApprove !== undefined) deps.applyAutoApprove?.(entry.id, entry.autoApprove);

  if (entry.claude !== undefined) {
    result.resumed.push(entry.id);
    if (entry.claude.status === 'busy') result.interrupted.push(entry.id);
    // Safety net: an exotic shell that never prints a recognisable prompt must
    // not block the restore for good.
    schedule(() => sendOnce(), READY_TIMEOUT_MS);
  }

  deps.markSession(entry.id, entry.claude !== undefined
    ? '— nach Neustart wiederhergestellt · Claude-Sitzung wird fortgesetzt —'
    : '— nach Neustart wiederhergestellt —');
}
