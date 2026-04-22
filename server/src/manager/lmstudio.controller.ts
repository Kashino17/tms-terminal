import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';

export type ModelStatusEvent =
  | { state: 'starting'; modelId: string }
  | { state: 'loading'; modelId: string; elapsedMs: number; progress?: number }
  | { state: 'ready'; modelId: string; elapsedMs: number }
  | { state: 'error'; modelId: string; elapsedMs: number; message: string };

export type ModelStatusListener = (ev: ModelStatusEvent) => void;

/**
 * Controls LM Studio via the `lms` CLI: loads the selected model, unloads all
 * others so VRAM is freed. Operations are serialized so rapid provider switches
 * don't race each other. Emits status events so the UI can show a loading
 * banner and fire a "ready" indicator.
 */
export class LmStudioController {
  private lmsPath: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastTarget: string | null = null;

  constructor() {
    this.lmsPath = this.resolveLmsPath();
    if (!this.lmsPath) {
      logger.warn('LM Studio: `lms` CLI not found — auto load/unload disabled. Install with: npx lmstudio install-cli');
    } else {
      logger.info(`LM Studio: CLI found at ${this.lmsPath}`);
    }
  }

  /** Switch to a specific model: unload everything else, ensure target is loaded. */
  switchTo(modelId: string, onStatus?: ModelStatusListener): Promise<void> {
    return this.enqueue(async () => {
      if (!this.lmsPath) {
        onStatus?.({ state: 'error', modelId, elapsedMs: 0, message: '`lms` CLI not installed' });
        return;
      }
      if (this.lastTarget === modelId) {
        logger.info(`LM Studio: ${modelId} already targeted, skipping switch`);
        // Still emit 'ready' so the UI can clear any stale loading state.
        onStatus?.({ state: 'ready', modelId, elapsedMs: 0 });
        return;
      }
      this.lastTarget = modelId;
      const started = Date.now();
      onStatus?.({ state: 'starting', modelId });
      const elapsedTimer = onStatus
        ? setInterval(() => onStatus({ state: 'loading', modelId, elapsedMs: Date.now() - started }), 500)
        : null;
      try {
        await this.run(['unload', '--all']);
        await this.runWithProgress(['load', modelId, '-y'], (progress) => {
          onStatus?.({ state: 'loading', modelId, elapsedMs: Date.now() - started, progress });
        });
        logger.info(`LM Studio: activated ${modelId} in ${Date.now() - started}ms`);
        onStatus?.({ state: 'ready', modelId, elapsedMs: Date.now() - started });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`LM Studio: failed to activate ${modelId}: ${msg}`);
        this.lastTarget = null;
        onStatus?.({ state: 'error', modelId, elapsedMs: Date.now() - started, message: msg });
      } finally {
        if (elapsedTimer) clearInterval(elapsedTimer);
      }
    });
  }

  /** Unload all models (e.g. when switching to a cloud provider). */
  unloadAll(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.lmsPath) return;
      this.lastTarget = null;
      try {
        await this.run(['unload', '--all']);
        logger.info('LM Studio: all local models unloaded');
      } catch (err) {
        logger.warn(`LM Studio: unload --all failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.lmsPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stdout?.on('data', () => {});
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(err));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`lms ${args.join(' ')} exited ${code}: ${stderr.slice(0, 300).trim()}`));
      });
    });
  }

  /** Like run(), but parses `lms load` progress output ("XX%") and reports it. */
  private runWithProgress(args: string[], onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.lmsPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      const parsePct = (chunk: string) => {
        const matches = chunk.match(/(\d+(?:\.\d+)?)\s*%/g);
        if (!matches) return;
        const last = matches[matches.length - 1];
        const n = parseFloat(last);
        if (!Number.isNaN(n) && n >= 0 && n <= 100) onProgress(n);
      };
      proc.stdout?.on('data', (d) => parsePct(d.toString()));
      proc.stderr?.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        parsePct(s);
      });
      proc.on('error', (err) => reject(err));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`lms ${args.join(' ')} exited ${code}: ${stderr.slice(0, 300).trim()}`));
      });
    });
  }

  private resolveLmsPath(): string | null {
    const candidates = [
      path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
      path.join(os.homedir(), '.cache', 'lm-studio', 'bin', 'lms'),
      '/usr/local/bin/lms',
      '/opt/homebrew/bin/lms',
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
    }
    return 'lms';
  }
}
