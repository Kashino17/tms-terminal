import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';

/** GPU encoders first — ddagrab already hands us frames on the graphics card. */
export const ENCODER_PREFERENCE = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as const;

export function pickEncoder(available: string[]): string | null {
  return ENCODER_PREFERENCE.find((e) => available.includes(e)) ?? null;
}

export function buildFfmpegArgs(opts: CaptureOptions, encoder: string): string[] {
  const quality = encoder === 'libx264'
    ? ['-preset', 'veryfast', '-tune', 'zerolatency']
    : ['-preset', 'p1', '-tune', 'll'];

  return [
    '-hide_banner', '-loglevel', 'info',
    '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${opts.fps}`,
    '-vf', `hwdownload,format=bgra,scale=${opts.maxWidth}:-2,format=nv12`,
    '-c:v', encoder,
    ...quality,
    '-b:v', `${opts.bitrateKbps}k`,
    '-g', String(opts.fps * 2),
    '-slices', '1',
    '-bsf:v', 'dump_extra',
    '-f', 'h264', 'pipe:1',
  ];
}

/** ffmpeg reports the real desktop size on stderr; we need it for the pointer maths. */
export function parseCaptureSize(stderrLine: string): { width: number; height: number } | null {
  const m = /,\s(\d{3,5})x(\d{3,5})[,\s]/.exec(stderrLine);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function availableEncoders(): string[] {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return ENCODER_PREFERENCE.filter((e) => out.includes(e));
  } catch {
    return [];
  }
}

export function createWin32Capture(): ScreenCapture {
  let child: ChildProcess | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  // Same as on macOS: a planned shutdown must not be reported as a crash, or the
  // restart logic from Task 18 would start the just-stopped session again.
  let stopping = false;

  return {
    start(opts) {
      return new Promise<CaptureInfo>((resolve, reject) => {
        const encoder = pickEncoder(availableEncoders());
        if (!encoder) {
          reject(new Error(
            'ffmpeg mit H.264-Encoder nicht gefunden. Einmalig einrichten mit:  winget install ffmpeg'));
          return;
        }

        const proc = spawn('ffmpeg', buildFfmpegArgs(opts, encoder), { stdio: ['ignore', 'pipe', 'pipe'] });
        child = proc;
        let settled = false;
        let tail = '';

        proc.stdout.on('data', (b: Buffer) => onData(b));

        proc.stderr.on('data', (b: Buffer) => {
          const text = b.toString();
          tail = (tail + text).slice(-4096);
          if (settled) return;
          for (const line of text.split('\n')) {
            const size = parseCaptureSize(line);
            if (!size) continue;
            settled = true;
            // ddagrab captures physical pixels and Windows reports them as such,
            // so there is no Retina-style factor to undo here.
            resolve({ width: Math.min(opts.maxWidth, size.width), height: size.height, scale: 1 });
            return;
          }
        });

        proc.on('exit', (code) => {
          child = null;
          if (stopping) return;                      // planned shutdown
          if (!settled) { settled = true; reject(new Error(`ffmpeg beendet (${code}): ${tail.slice(-200)}`)); }
          else onError('helper_crashed', `ffmpeg beendet (${code})`);
        });

        proc.on('error', () => {
          if (!settled) {
            settled = true;
            reject(new Error('ffmpeg nicht gefunden. Einmalig einrichten mit:  winget install ffmpeg'));
          }
        });
      });
    },

    onData(cb) { onData = cb; },
    onError(cb) { onError = cb; },

    // ffmpeg can change neither the keyframe schedule nor the bitrate while
    // running — both are baked into the start arguments. Task 10 restarts the
    // capture instead when the quality preset changes, so these stay no-ops.
    requestKeyframe() { /* intentionally empty: see comment above */ },
    setBitrate() { /* intentionally empty: see comment above */ },

    async stop() {
      const proc = child;
      stopping = true;
      child = null;
      if (!proc) return;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 500);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
