import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (info: { chunk: number; total: number; text: string }) => void;
}

// Dynamic timeout: 30s base + 15s per estimated minute of audio.
// Base64 WAV at 16kHz/16bit/mono: ~1.33 MB per minute → ~1.78 MB Base64 per minute.
const BASE_TIMEOUT_MS = 30_000;
const TIMEOUT_PER_MB_BASE64 = 10_000; // 10s per MB of Base64 data

function calcTimeout(base64Length: number): number {
  const mbSize = base64Length / (1024 * 1024);
  return Math.max(BASE_TIMEOUT_MS, Math.round(BASE_TIMEOUT_MS + mbSize * TIMEOUT_PER_MB_BASE64));
}

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
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'whisper_sidecar.py');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv', 'bin', 'python3');

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

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.info(`[whisper] ${text.trim()}`);
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

          // Progress update (chunk completed but more to come)
          if (resp.progress) {
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
      sidecar = null;
      startPromise = null;
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Whisper sidecar exited unexpectedly'));
      }
      pending.clear();
      if (!resolved) {
        reject(new Error('Whisper sidecar failed to start'));
      }
    });

    child.on('error', (err) => {
      logger.error(`[whisper] Failed to spawn sidecar: ${err.message}`);
      sidecar = null;
      startPromise = null;
      if (!resolved) {
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
  const timeoutMs = calcTimeout(audioBase64.length);

  logger.info(`[whisper] Transcription request ${id}: ${(audioBase64.length / 1024).toFixed(0)} KB Base64, timeout=${Math.round(timeoutMs / 1000)}s, model=${options.model ?? 'default'}`);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const secs = Math.round(timeoutMs / 1000);
      reject(new Error(`Transkription Timeout (${secs}s). Audio zu lang oder Model zu langsam.`));
    }, timeoutMs);

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
