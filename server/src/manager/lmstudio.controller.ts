import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Controls LM Studio via the `lms` CLI: loads the selected model, unloads all
 * others so VRAM is freed. Operations are serialized so rapid provider switches
 * don't race each other.
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
  switchTo(modelId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.lmsPath) return;
      if (this.lastTarget === modelId) {
        logger.info(`LM Studio: ${modelId} already targeted, skipping switch`);
        return;
      }
      this.lastTarget = modelId;
      try {
        await this.run(['unload', '--all']);
        await this.run(['load', modelId, '-y']);
        logger.info(`LM Studio: activated ${modelId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`LM Studio: failed to activate ${modelId}: ${msg}`);
        this.lastTarget = null;
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

  private resolveLmsPath(): string | null {
    // Common install locations for the `lms` CLI
    const candidates = [
      path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
      path.join(os.homedir(), '.cache', 'lm-studio', 'bin', 'lms'),
      '/usr/local/bin/lms',
      '/opt/homebrew/bin/lms',
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
    }
    // Fallback: trust PATH — spawn('lms') will fail cleanly if missing
    return 'lms';
  }
}
