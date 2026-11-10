/**
 * The voice: a long-running sidecar that speaks one sentence per request in
 * the cloned voice (audio/voice_sidecar.py), plus the MP3 packing for the way
 * to the phone (a sentence: ~290 KB of raw sound → ~30 KB).
 *
 * The sidecar holds the model in memory (~9 GB at the peak); it is started on
 * the first request and let go after IDLE_EXIT_MS without one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../utils/logger';
import { findFfmpeg } from '../audio/ffmpeg-decode';

const MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit';
const IDLE_EXIT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;

function serverRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'audio'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..');
}

export interface VoicePaths { script: string; python: string; ref: string; refText: string; modelDir: string }

export function voicePaths(home = os.homedir(), root = serverRoot(), env: NodeJS.ProcessEnv = process.env): VoicePaths {
  const hub = env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, '.cache', 'huggingface'), 'hub');
  return {
    script: path.join(root, 'audio', 'voice_sidecar.py'),
    python: path.join(root, 'audio', '.venv-tts', 'bin', 'python3'),
    ref: path.join(home, '.tms-terminal', 'voice_24k_15s.wav'),
    refText: path.join(home, '.tms-terminal', 'voice_24k_15s.txt'),
    modelDir: path.join(hub, 'models--' + MODEL.replace('/', '--')),
  };
}

/**
 * Can this machine read aloud in the cloned voice? Everything must already be
 * there — nothing is installed or downloaded behind the user's back. The app
 * falls back to the phone's own voice when no device reports this.
 */
export function voiceAvailable(p: VoicePaths = voicePaths(), platform: NodeJS.Platform = process.platform, ffmpeg: string | null = findFfmpeg()): boolean {
  return platform === 'darwin' && !!ffmpeg && [p.script, p.python, p.ref, p.refText, p.modelDir].every((f) => fs.existsSync(f));
}

interface Pending { resolve: (r: { pcm: Buffer; rate: number; secs: number }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let lineBuffer = '';
let nextId = 0;
let idleTimer: NodeJS.Timeout | null = null;
const pending = new Map<string, Pending>();

function failAll(reason: string): void {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  pending.clear();
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && child) { logger.info('[voice] idle — releasing the model'); shutdownVoice(); }
  }, IDLE_EXIT_MS);
  idleTimer.unref?.();
}

function ensureRunning(): Promise<void> {
  if (child) return Promise.resolve();
  if (starting) return starting;
  const p = voicePaths();
  starting = new Promise<void>((resolve, reject) => {
    logger.info('[voice] starting the voice sidecar …');
    const proc = spawn(p.python, [p.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TMS_VOICE_MODEL: MODEL, TMS_VOICE_REF: p.ref, TMS_VOICE_REF_TEXT: p.refText },
    });
    let ready = false;
    const startTimer = setTimeout(() => { if (!ready) { proc.kill(); reject(new Error('voice sidecar did not start')); } }, START_TIMEOUT_MS);
    proc.stderr?.on('data', () => { /* library chatter */ });
    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { ready?: boolean; id?: string; pcm?: string; sample_rate?: number; secs?: number; error?: string };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready !== undefined && !ready) {
          clearTimeout(startTimer);
          if (msg.ready) { ready = true; child = proc; starting = null; logger.success('[voice] ready'); resolve(); }
          else { starting = null; reject(new Error(msg.error || 'voice model failed to load')); }
          continue;
        }
        const req = msg.id ? pending.get(msg.id) : undefined;
        if (!req || !msg.id) continue;
        pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.error || !msg.pcm) req.reject(new Error(msg.error || 'no audio'));
        else req.resolve({ pcm: Buffer.from(msg.pcm, 'base64'), rate: msg.sample_rate || 24000, secs: msg.secs || 0 });
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(startTimer);
      if (child === proc) child = null;
      lineBuffer = '';
      starting = null;
      failAll('voice sidecar exited');
      if (!ready) reject(new Error(`voice sidecar exited (${code})`));
    });
    proc.on('error', (err) => { clearTimeout(startTimer); starting = null; if (!ready) reject(err); });
  });
  return starting;
}

/** Raw sound (16-bit mono) → MP3. */
export function encodeMp3(pcm: Buffer, rate: number): Promise<Buffer> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.reject(new Error('ffmpeg not found'));
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    proc.stdout!.on('data', (d: Buffer) => out.push(d));
    proc.stderr!.on('data', (d: Buffer) => { if (err.length < 1000) err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const mp3 = Buffer.concat(out);
      if (code === 0 && mp3.length > 0) resolve(mp3); else reject(new Error(`mp3 encoding failed: ${err.trim() || code}`));
    });
    proc.stdin!.on('error', () => { /* ffmpeg gone — 'close' reports it */ });
    proc.stdin!.end(pcm);
  });
}

/** One sentence → MP3 in the cloned voice. */
export async function synthesize(text: string): Promise<{ audio: Buffer; ms: number }> {
  await ensureRunning();
  const proc = child;
  if (!proc?.stdin) throw new Error('voice sidecar not running');
  const id = 'v' + (++nextId);
  const raw = await new Promise<{ pcm: Buffer; rate: number; secs: number }>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('voice timed out')); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    proc.stdin!.write(JSON.stringify({ id, text }) + '\n');
  });
  armIdle();
  return { audio: await encodeMp3(raw.pcm, raw.rate), ms: Math.round(raw.secs * 1000) };
}

export function shutdownVoice(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const proc = child;
  child = null;
  if (proc) { try { proc.stdin?.end(); } catch { /* gone */ } setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 1500).unref?.(); }
}
