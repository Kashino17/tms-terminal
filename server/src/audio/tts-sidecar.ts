import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  resolve: (result: { audioBase64: string; durationSecs: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (info: { chunk: number; total: number }) => void;
}

// Timeout: 15s base + 5s per 100 chars (generous for MLX on Apple Silicon)
const BASE_TIMEOUT_MS = 15_000;
const TIMEOUT_PER_100_CHARS = 5_000;

function calcTimeout(textLength: number): number {
  return Math.max(BASE_TIMEOUT_MS, BASE_TIMEOUT_MS + Math.ceil(textLength / 100) * TIMEOUT_PER_100_CHARS);
}

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
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'tts_sidecar.py');
// Use the mlx-audio venv (has Qwen3-TTS + mlx dependencies)
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv-tts', 'bin', 'python3');
// Also set HF_TOKEN for model downloads
const HF_TOKEN = process.env.HF_TOKEN || '';

let sidecar: ChildProcess | null = null;
let lineBuffer = '';
let requestId = 0;
const pending = new Map<string, PendingRequest>();
let startPromise: Promise<void> | null = null;

function ensureRunning(): Promise<void> {
  if (sidecar && !sidecar.killed) return Promise.resolve();
  if (startPromise) return startPromise;

  startPromise = new Promise<void>((resolve, reject) => {
    logger.info('[tts] Starting F5-TTS sidecar...');

    const fs = require('fs');
    const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
    logger.info(`[tts] Using Python: ${pythonBin}`);

    const child = spawn(pythonBin, [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_TOKEN },
    });

    let resolved = false;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.info(`[tts] ${text.trim()}`);
      if (!resolved && text.includes('Ready for requests')) {
        resolved = true;
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

          // Progress update
          if (resp.progress) {
            req.onProgress?.({ chunk: resp.chunk, total: resp.total });
            continue;
          }

          pending.delete(id);
          clearTimeout(req.timer);
          if (resp.error) {
            req.reject(new Error(resp.error));
          } else {
            req.resolve({
              audioBase64: resp.audio_base64 ?? '',
              durationSecs: resp.duration_secs ?? 0,
            });
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    child.on('exit', (code) => {
      logger.warn(`[tts] Sidecar exited with code ${code}`);
      sidecar = null;
      startPromise = null;
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('TTS sidecar exited unexpectedly'));
      }
      pending.clear();
      if (!resolved) {
        reject(new Error('TTS sidecar failed to start'));
      }
    });

    child.on('error', (err) => {
      logger.error(`[tts] Failed to spawn sidecar: ${err.message}`);
      sidecar = null;
      startPromise = null;
      if (!resolved) {
        reject(new Error(`TTS nicht verfuegbar: ${err.message}. Installieren mit: pip install mlx-audio`));
      }
    });
  });

  return startPromise;
}

export interface SynthesizeOptions {
  onProgress?: (info: { chunk: number; total: number }) => void;
}

export async function synthesize(text: string, options: SynthesizeOptions = {}): Promise<{ audioBase64: string; durationSecs: number }> {
  await ensureRunning();

  if (!sidecar?.stdin?.writable) {
    throw new Error('TTS sidecar is not running');
  }

  const id = `tts-${++requestId}`;
  const timeoutMs = calcTimeout(text.length);

  logger.info(`[tts] Synthesis request ${id}: ${text.length} chars, timeout=${Math.round(timeoutMs / 1000)}s`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`TTS Timeout (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer, onProgress: options.onProgress });

    const request = JSON.stringify({ id, text }) + '\n';
    sidecar!.stdin!.write(request);
  });
}

/** Check if TTS sidecar is available (venv + script exist) */
export function isAvailable(): boolean {
  const fs = require('fs');
  return fs.existsSync(SIDECAR_SCRIPT) && (fs.existsSync(VENV_PYTHON) || true);
}

export function shutdown(): void {
  if (sidecar && !sidecar.killed) {
    sidecar.kill('SIGTERM');
    sidecar = null;
  }
}
