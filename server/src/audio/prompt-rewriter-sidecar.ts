import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  id: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const TIMEOUT_MS = 30_000;
// Bound sidecar startup. Without this, a hung import / model load leaves
// ensureRunning() pending forever, which makes `await rewrite()` (and thus the
// whole enhanced-transcription request) hang — the client mic then sticks on
// "processing" indefinitely. Whisper's sidecar uses the same guard.
const START_TIMEOUT_MS = 60_000;

function findServerRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (require('fs').existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..');
}

const SERVER_ROOT = findServerRoot();
const SIDECAR_DIR = path.join(SERVER_ROOT, 'audio');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'prompt_rewriter_sidecar.py');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv-rewriter', 'bin', 'python3');

let sidecar: ChildProcess | null = null;
let lineBuffer = '';
let requestId = 0;
let activeRequest: PendingRequest | null = null;
let startPromise: Promise<void> | null = null;

export class RewriterBusyError extends Error {
  constructor() {
    super('Prompt-Rewrite läuft bereits. Bitte warten.');
    this.name = 'RewriterBusyError';
  }
}

function killSidecar(reason: string): void {
  if (sidecar && !sidecar.killed) {
    logger.warn(`[rewriter] Killing sidecar: ${reason}`);
    sidecar.kill('SIGKILL');
  }
  sidecar = null;
  startPromise = null;
  lineBuffer = '';
}

function failActive(err: Error): void {
  if (!activeRequest) return;
  const req = activeRequest;
  activeRequest = null;
  clearTimeout(req.timer);
  req.reject(err);
}

function ensureRunning(): Promise<void> {
  if (sidecar && !sidecar.killed) return Promise.resolve();
  if (startPromise) return startPromise;

  startPromise = new Promise<void>((resolve, reject) => {
    logger.info('[rewriter] Starting sidecar...');

    const fs = require('fs');
    const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
    logger.info(`[rewriter] Using Python: ${pythonBin}`);

    const child = spawn(pythonBin, [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    // If the sidecar never reports "Ready" (hung import / model load), reject so
    // callers fall back to the raw transcript instead of awaiting forever.
    const startTimer = setTimeout(() => {
      if (resolved) return;
      logger.warn(`[rewriter] Sidecar start timed out after ${START_TIMEOUT_MS / 1000}s; killing`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      sidecar = null;
      startPromise = null;
      reject(new Error(`Rewriter sidecar start timed out (${START_TIMEOUT_MS / 1000}s)`));
    }, START_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.info(`[rewriter] ${text.trim()}`);
      if (!resolved && text.includes('Ready for requests')) {
        resolved = true;
        clearTimeout(startTimer);
        startPromise = null;
        sidecar = child;
        resolve();
      }
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          const req = activeRequest;
          if (!req || req.id !== resp.id) continue;

          activeRequest = null;
          clearTimeout(req.timer);
          if (resp.error) {
            req.reject(new Error(resp.error));
          } else {
            req.resolve(resp.text ?? '');
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    child.on('exit', (code) => {
      clearTimeout(startTimer);
      logger.warn(`[rewriter] Sidecar exited with code ${code}`);
      const wasResolved = resolved;
      sidecar = null;
      startPromise = null;
      failActive(new Error('Rewriter sidecar exited unexpectedly'));
      if (!wasResolved) reject(new Error('Rewriter sidecar failed to start'));
    });

    child.on('error', (err) => {
      clearTimeout(startTimer);
      logger.error(`[rewriter] Failed to spawn sidecar: ${err.message}`);
      sidecar = null;
      startPromise = null;
      if (!resolved) {
        reject(new Error(`Rewriter nicht verfuegbar: ${err.message}. Installieren mit: pip install mlx-lm`));
      }
    });
  });

  return startPromise;
}

export function isBusy(): boolean {
  return activeRequest !== null;
}

export async function rewrite(transcript: string): Promise<string> {
  if (activeRequest) throw new RewriterBusyError();

  await ensureRunning();

  if (!sidecar?.stdin?.writable) {
    throw new Error('Rewriter sidecar is not running');
  }

  const id = `req-${++requestId}`;
  logger.info(`[rewriter] Request ${id}: ${transcript.length} chars`);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      killSidecar(`request ${id} timed out after ${TIMEOUT_MS}ms`);
      failActive(new Error(`Prompt-Rewrite Timeout (${Math.round(TIMEOUT_MS / 1000)}s).`));
    }, TIMEOUT_MS);

    activeRequest = { id, resolve, reject, timer };

    const request = JSON.stringify({ id, transcript }) + '\n';
    sidecar!.stdin!.write(request, (err) => {
      if (err) {
        logger.error(`[rewriter] stdin write failed: ${err.message}`);
        killSidecar('stdin write failed');
        failActive(new Error(`Prompt-Rewrite fehlgeschlagen: ${err.message}`));
      }
    });
  });
}

export function shutdown(): void {
  killSidecar('shutdown');
}
