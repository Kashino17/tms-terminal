// Decode recorded audio to 16 kHz mono float32 for the streamed-dictation path.
//
// 'adts' (AAC frames, what the app writes while recording) is a stream format:
// it goes through a stdin pipe and a half-written last frame is expected —
// ffmpeg then exits non-zero but its output up to that frame is valid.
// 'file' (MP4/m4a/WAV …) may need seeking (moov atom at the end), so it goes
// through a temp file, exactly like whisper_sidecar_mlx.py does.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function findFfmpeg(): string | null {
  // node may run with a PATH that omits Homebrew.
  for (const dir of (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) {
    if (!dir) continue;
    const p = path.join(dir, 'ffmpeg');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export function decodeToFloat32(bytes: Buffer, format: 'adts' | 'file'): Promise<Float32Array> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.reject(new Error('ffmpeg not found'));
  let tmp: string | null = null;
  if (format === 'file') {
    tmp = path.join(os.tmpdir(), `tms-dictation-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmp, bytes);
  }
  const input = format === 'adts' ? ['-f', 'aac', '-i', 'pipe:0'] : ['-i', tmp!];
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-loglevel', 'error', ...input, '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], {
      stdio: [format === 'adts' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('close', (code) => {
      cleanup();
      const all = Buffer.concat(out);
      const usable = all.length - (all.length % 4);
      if (usable === 0) {
        reject(new Error(`ffmpeg decode failed (exit ${code}): ${err.trim().slice(0, 300) || 'no output'}`));
        return;
      }
      // Copy into an aligned buffer — Float32Array needs a 4-byte aligned offset.
      const aligned = new Uint8Array(usable);
      aligned.set(all.subarray(0, usable));
      resolve(new Float32Array(aligned.buffer));
    });
    if (format === 'adts') {
      child.stdin!.on('error', () => { /* ffmpeg may close early on garbage */ });
      child.stdin!.end(bytes);
    }
    function cleanup() { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } tmp = null; } }
  });
}
