import { logger } from '../../utils/logger';
import { writeSnapshot, TMS_DIR } from './snapshot.store';
import type { Snapshot, SnapshotEntry } from './snapshot.types';
import {
  resolveClaudeSession, buildProcessTable, childLookupFrom, type ClaudeSessionInfo,
} from './claude-session';

const CAPTURE_INTERVAL_MS = 30_000;

export interface SnapshotSource {
  listSessions(): Array<{ id: string; pid: number; cols: number; rows: number; cwd?: string }>;
  labelFor(id: string): string | undefined;
  autoApproveFor(id: string): boolean;
}

export interface SnapshotterDeps {
  now: () => number;
  serverPid: number;
  source: SnapshotSource;
  dir?: string;
  resolveClaude?: (shellPid: number) => Promise<ClaudeSessionInfo | null>;
  intervalMs?: number;
}

/**
 * Keeps ~/.tms-terminal/terminals.json current.
 *
 * Runs on a timer rather than only at shutdown: a crash or a power cut leaves no
 * chance to run a signal handler, and those are exactly the cases the user asked
 * to be covered.
 */
export class Snapshotter {
  private timer: NodeJS.Timeout | null = null;
  private capturing = false;

  constructor(private readonly deps: SnapshotterDeps) {}

  start(): void {
    if (this.timer !== null) return;
    void this.captureNow();
    this.timer = setInterval(() => { void this.captureNow(); }, this.deps.intervalMs ?? CAPTURE_INTERVAL_MS);
    this.timer.unref();
    logger.info('[restore] Snapshotter gestartet');
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Never throws — a failed snapshot must not take anything else down. */
  async captureNow(): Promise<void> {
    if (this.capturing) return; // a slow ps must not let runs pile up
    this.capturing = true;
    try {
      const sessions = this.deps.source.listSessions();

      // One process table for ALL terminals instead of one lookup per terminal.
      const resolve = this.deps.resolveClaude ?? await (async () => {
        const children = childLookupFrom(await buildProcessTable());
        return (pid: number) => resolveClaudeSession(pid, { children });
      })();

      const entries: SnapshotEntry[] = [];
      for (const s of sessions) {
        let claude: ClaudeSessionInfo | null = null;
        try {
          claude = await resolve(s.pid);
        } catch {
          claude = null; // no mark for this one; the terminal itself still gets saved
        }
        entries.push({
          id: s.id,
          label: this.deps.source.labelFor(s.id),
          // Claude knows where it actually runs; the pty cwd is only sampled now and then.
          cwd: claude?.cwd !== undefined && claude.cwd !== '' ? claude.cwd : (s.cwd ?? ''),
          cols: s.cols,
          rows: s.rows,
          autoApprove: this.deps.source.autoApproveFor(s.id),
          claude: claude === null ? undefined : { sessionId: claude.sessionId, status: claude.status },
        });
      }

      const snapshot: Snapshot = {
        capturedAt: this.deps.now(),
        serverPid: this.deps.serverPid,
        entries,
      };
      writeSnapshot(snapshot, this.deps.dir ?? TMS_DIR);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[restore] Aufnahme fehlgeschlagen: ${msg}`);
    } finally {
      this.capturing = false;
    }
  }
}

// ── Zugriff von aussen ───────────────────────────────────────────────────────
// ws.handler braucht nach dem Anlegen/Schliessen eines Terminals eine Aufnahme,
// hat aber keinen Zugriff auf die Instanz aus index.ts.

let active: Snapshotter | null = null;

export function setActiveSnapshotter(s: Snapshotter | null): void {
  active = s;
}

/** Fire-and-forget. Vor dem Start des Snapshotters ein No-op. */
export function captureSoon(): void {
  void active?.captureNow();
}
