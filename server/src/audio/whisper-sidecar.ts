import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  id: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (info: { chunk: number; total: number; text: string }) => void;
}

// Dynamic timeout: 30s base + 10s per MB of Base64 audio.
const BASE_TIMEOUT_MS = 30_000;
const TIMEOUT_PER_MB_BASE64 = 10_000;

function calcTimeout(base64Length: number): number {
  const mbSize = base64Length / (1024 * 1024);
  return Math.max(BASE_TIMEOUT_MS, Math.round(BASE_TIMEOUT_MS + mbSize * TIMEOUT_PER_MB_BASE64));
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
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'whisper_sidecar.py');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv', 'bin', 'python3');

let sidecar: ChildProcess | null = null;
let lineBuffer = '';
let requestId = 0;
let activeRequest: PendingRequest | null = null; // only ONE in flight at a time
let startPromise: Promise<void> | null = null;

export class WhisperBusyError extends Error {
  constructor() {
    super('Transkription läuft bereits. Bitte warten.');
    this.name = 'WhisperBusyError';
  }
}

function killSidecar(reason: string): void {
  if (sidecar && !sidecar.killed) {
    logger.warn(`[whisper] Killing sidecar: ${reason}`);
    sidecar.kill('SIGKILL'); // hard kill — SIGTERM may be ignored during MPS work
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
          const req = activeRequest;
          if (!req || req.id !== id) continue; // stale response from killed request

          if (resp.progress) {
            req.onProgress?.({ chunk: resp.chunk, total: resp.total, text: resp.text ?? '' });
            continue;
          }

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
      logger.warn(`[whisper] Sidecar exited with code ${code}`);
      const wasResolved = resolved;
      sidecar = null;
      startPromise = null;
      failActive(new Error('Whisper sidecar exited unexpectedly'));
      if (!wasResolved) reject(new Error('Whisper sidecar failed to start'));
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
  onProgress?: (info: { chunk: number; total: number; text: string }) => void;
}

export function isBusy(): boolean {
  return activeRequest !== null;
}

export async function transcribe(audioBase64: string, options: TranscribeOptions = {}): Promise<string> {
  if (activeRequest) {
    throw new WhisperBusyError();
  }

  await ensureRunning();

  if (!sidecar?.stdin?.writable) {
    throw new Error('Whisper sidecar is not running');
  }

  const id = `req-${++requestId}`;
  const timeoutMs = calcTimeout(audioBase64.length);

  logger.info(`[whisper] Request ${id}: ${(audioBase64.length / 1024).toFixed(0)} KB Base64, timeout=${Math.round(timeoutMs / 1000)}s`);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const secs = Math.round(timeoutMs / 1000);
      // Hard-kill so the next request starts fresh — otherwise Python keeps chewing
      // on the stale request and blocks the next one.
      killSidecar(`request ${id} timed out after ${secs}s`);
      failActive(new Error(`Transkription Timeout (${secs}s). Bitte erneut versuchen.`));
    }, timeoutMs);

    activeRequest = { id, resolve, reject, timer, onProgress: options.onProgress };

    const request = JSON.stringify({
      id,
      audio_base64: audioBase64,
      language: options.language ?? 'de',
    }) + '\n';
    sidecar!.stdin!.write(request, (err) => {
      if (err) {
        logger.error(`[whisper] stdin write failed: ${err.message}`);
        killSidecar('stdin write failed');
        failActive(new Error(`Transkription fehlgeschlagen: ${err.message}`));
      }
    });
  });
}

export function shutdown(): void {
  killSidecar('shutdown');
}
