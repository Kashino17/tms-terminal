import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (info: { chunk: number; total: number; text: string }) => void;
}

// Watchdog: abort a request only if a single chunk makes no progress for this long.
// Each progress message resets the timer, so total audio length is irrelevant.
const CHUNK_STALL_TIMEOUT_MS = 45_000;
const SIDECAR_START_TIMEOUT_MS = 90_000;

// Find the server root (directory containing package.json) by walking up from __dirname.
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
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'whisper_sidecar_mlx.py');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv-mlx', 'bin', 'python3');

let sidecar: ChildProcess | null = null;
let lineBuffer = '';
let requestId = 0;
const pending = new Map<string, PendingRequest>();
let startPromise: Promise<void> | null = null;

function ensureRunning(): Promise<void> {
  if (sidecar && !sidecar.killed) return Promise.resolve();
  if (startPromise) return startPromise;

  startPromise = new Promise<void>((resolve, reject) => {
    logger.info('[whisper] Starting sidecar...');

    const fs = require('fs');
    const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
    logger.info(`[whisper] Using Python: ${pythonBin}`);

    const child = spawn(pythonBin, [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    const startTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      logger.warn(`[whisper] Sidecar start timed out after ${SIDECAR_START_TIMEOUT_MS / 1000}s; killing`);
      try { child.kill('SIGKILL'); } catch {}
      sidecar = null;
      startPromise = null;
      reject(new Error(`Whisper sidecar start timed out (${SIDECAR_START_TIMEOUT_MS / 1000}s)`));
    }, SIDECAR_START_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.info(`[whisper] ${text.trim()}`);
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
          const id = resp.id as string;
          const req = pending.get(id);
          if (!req) continue;

          // Progress update (chunk completed but more to come) — reset the watchdog.
          if (resp.progress) {
            clearTimeout(req.timer);
            req.timer = setTimeout(() => {
              pending.delete(id);
              req.reject(new Error(`Transkription Timeout (${CHUNK_STALL_TIMEOUT_MS / 1000}s). Chunk haengt.`));
            }, CHUNK_STALL_TIMEOUT_MS);
            req.onProgress?.({ chunk: resp.chunk, total: resp.total, text: resp.text ?? '' });
            continue; // Don't resolve yet — more chunks coming
          }

          pending.delete(id);
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
      logger.warn(`[whisper] Sidecar exited with code ${code}`);
      clearTimeout(startTimer);
      sidecar = null;
      startPromise = null;
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Whisper sidecar exited unexpectedly'));
      }
      pending.clear();
      if (!resolved) {
        resolved = true;
        reject(new Error('Whisper sidecar failed to start'));
      }
    });

    child.on('error', (err) => {
      logger.error(`[whisper] Failed to spawn sidecar: ${err.message}`);
      clearTimeout(startTimer);
      sidecar = null;
      startPromise = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`Whisper nicht verfuegbar: ${err.message}. Installieren mit: pip3 install openai-whisper torch`));
      }
    });
  });

  return startPromise;
}

export interface TranscribeOptions {
  language?: string;
  model?: string; // 'large-v3' | 'turbo' | 'medium'
  onProgress?: (info: { chunk: number; total: number; text: string }) => void;
}

export async function transcribe(audioBase64: string, options: TranscribeOptions = {}): Promise<string> {
  await ensureRunning();

  if (!sidecar?.stdin?.writable) {
    throw new Error('Whisper sidecar is not running');
  }

  const id = `req-${++requestId}`;

  logger.info(`[whisper] Transcription request ${id}: ${(audioBase64.length / 1024).toFixed(0)} KB Base64, stallTimeout=${CHUNK_STALL_TIMEOUT_MS / 1000}s, model=${options.model ?? 'default'}`);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Transkription Timeout (${CHUNK_STALL_TIMEOUT_MS / 1000}s). Chunk haengt oder Model zu langsam.`));
    }, CHUNK_STALL_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer, onProgress: options.onProgress });

    const request = JSON.stringify({
      id,
      audio_base64: audioBase64,
      language: options.language ?? 'de',
      model: options.model,
    }) + '\n';
    sidecar!.stdin!.write(request);
  });
}

export function shutdown(): void {
  if (sidecar && !sidecar.killed) {
    sidecar.kill('SIGTERM');
    sidecar = null;
  }
}
