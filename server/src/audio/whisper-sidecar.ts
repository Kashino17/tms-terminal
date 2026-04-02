import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const TRANSCRIBE_TIMEOUT_MS = 30_000;

// Find the server root (directory containing package.json) by walking up from __dirname.
// Works for both compiled (dist/server/src/audio/) and dev (src/audio/) contexts.
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
// Prefer the venv Python (where whisper+torch are installed) over system python3
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv', 'bin', 'python3');

let sidecar: ChildProcess | null = null;
let buffer = '';
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
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          const id = resp.id as string;
          const req = pending.get(id);
          if (!req) continue;
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
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Whisper sidecar exited unexpectedly'));
        pending.delete(id);
      }
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

export async function transcribe(audioBase64: string, language = 'de'): Promise<string> {
  await ensureRunning();

  if (!sidecar?.stdin?.writable) {
    throw new Error('Whisper sidecar is not running');
  }

  const id = `req-${++requestId}`;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Transkription Timeout (30s)'));
    }, TRANSCRIBE_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    const request = JSON.stringify({ id, audio_base64: audioBase64, language }) + '\n';
    sidecar!.stdin!.write(request);
  });
}

export function shutdown(): void {
  if (sidecar && !sidecar.killed) {
    sidecar.kill('SIGTERM');
    sidecar = null;
  }
}
