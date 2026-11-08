import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';
import { splitLines } from '../lines';
import { winCursorScriptPath } from '../paths';

/** GPU encoders first — ddagrab already hands us frames on the graphics card. */
export const ENCODER_PREFERENCE = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as const;

export function pickEncoder(available: string[]): string | null {
  return ENCODER_PREFERENCE.find((e) => available.includes(e)) ?? null;
}

/**
 * Low-latency quality flags, one set per encoder wrapper — NOT interchangeable.
 * `-preset p1 -tune ll` are NVENC-only values; QSV and AMF don't recognise
 * `p1` as a preset or `-tune` at all and ffmpeg aborts at startup if handed
 * them. Each ffmpeg encoder wrapper exposes its own option surface.
 */
function qualityArgs(encoder: string): string[] {
  switch (encoder) {
    case 'h264_nvenc':
      return ['-preset', 'p1', '-tune', 'll'];
    case 'h264_qsv':
      return ['-preset', 'veryfast', '-async_depth', '1'];
    case 'h264_amf':
      return ['-usage', 'ultralowlatency', '-quality', 'speed'];
    default: // libx264
      return ['-preset', 'veryfast', '-tune', 'zerolatency'];
  }
}

/**
 * Baseline ohne B-Frames — exakt wie der Mac-Helfer (Baseline_AutoLevel,
 * AllowFrameReordering=false). Die App öffnet den Decoder als avc1.42E01E
 * (Baseline); ohne Vorgabe lieferten die Encoder High mit B-Frames, die
 * Android-Decoder ablehnen oder nur mit Umsortier-Verzögerung zeigen.
 * AMF kennt kein reines "baseline", nur constrained_baseline.
 */
function profileArgs(encoder: string): string[] {
  return ['-profile:v', encoder === 'h264_amf' ? 'constrained_baseline' : 'baseline', '-bf', '0'];
}

export function buildFfmpegArgs(opts: CaptureOptions, encoder: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'info',
    // With a local pointer the app draws the arrow itself and the video must
    // not carry a second, delayed one (see cursor-helper.ps1).
    '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${opts.fps}${opts.localCursor ? ':draw_mouse=0' : ''}`,
    // `min(iw,${maxWidth})` — not a bare `${maxWidth}` — so the filter only
    // ever shrinks. A bare target width scales up whenever the desktop is
    // narrower than the requested tier (e.g. a 1600px desktop on the
    // `scharf` tier's 1920px target), stretching and blurring the picture
    // while the reported size below still assumed downscale-only and
    // reported the *smaller* of the two — a mismatched, distorted image and
    // a pointer rectangle that no longer matches what's on screen. Quoted so
    // the comma inside min(...) isn't read as the next filter in the chain.
    '-vf', `hwdownload,format=bgra,scale=w='min(iw,${opts.maxWidth})':h=-2,format=nv12`,
    '-c:v', encoder,
    ...qualityArgs(encoder),
    ...profileArgs(encoder),
    '-b:v', `${opts.bitrateKbps}k`,
    '-g', String(opts.fps * 2),
    '-slices', '1',
    '-bsf:v', 'dump_extra',
    '-f', 'h264', 'pipe:1',
  ];
}

/**
 * One stdout line of cursor-helper.ps1 → normalized position, or null.
 * Same shape as the macOS helper's report: {"cursor":{"x":0.5,"y":0.25}}.
 */
export function parseCursorLine(line: string): { x: number; y: number } | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const c = (JSON.parse(t) as { cursor?: { x?: unknown; y?: unknown } }).cursor;
    if (!c || typeof c.x !== 'number' || typeof c.y !== 'number' || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    return { x: Math.min(1, Math.max(0, c.x)), y: Math.min(1, Math.max(0, c.y)) };
  } catch { return null; }
}

/**
 * Video pixels per desktop pixel — the same meaning as the macOS helper's
 * `scale` (video width / display width in the units relative motion uses).
 * The app divides by it to know how far one `rel` unit moves the pointer
 * across the picture; the old fixed 1 was wrong whenever the desktop was
 * wider than the quality tier (2560 px desktop, 1600 px video: the predicted
 * pointer ran 1.6x ahead of the real one).
 */
export function captureScale(desktopWidth: number, videoWidth: number): number {
  return desktopWidth > 0 && videoWidth > 0 ? videoWidth / desktopWidth : 1;
}

/** ffmpeg reports the real (pre-filter) desktop size on stderr. */
export function parseCaptureSize(stderrLine: string): { width: number; height: number } | null {
  const m = /,\s(\d{3,5})x(\d{3,5})[,\s]/.exec(stderrLine);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * What the `-vf scale=...` filter above will actually hand the encoder,
 * given the real (pre-filter) desktop size ffmpeg reports at startup.
 * Mirrors that filter's own math exactly — including its never-upscale
 * guard and its `-2` (scale proportionally, round down to an even number) —
 * so the size reported to the client (and used for pointer mapping in
 * geometry.ts) matches what was actually encoded, not the raw desktop size.
 * `parseCaptureSize` used to be reported to the client as-is; that was the
 * bug (C4): the *full* desktop height went out even when the width got
 * capped, and the width calculation itself assumed downscale-only while the
 * old filter could still upscale — a distorted, mismatched image.
 */
export function computeOutputSize(
  opts: CaptureOptions,
  desktop: { width: number; height: number },
): { width: number; height: number } {
  if (desktop.width <= opts.maxWidth) {
    // The filter's min(iw, maxWidth) leaves the frame alone — never upscale.
    return { width: desktop.width, height: desktop.height };
  }
  const width = opts.maxWidth;
  const height = Math.floor((desktop.height * width) / desktop.width / 2) * 2;
  return { width, height };
}

function availableEncoders(): string[] {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return ENCODER_PREFERENCE.filter((e) => out.includes(e));
  } catch {
    return [];
  }
}

/** ffmpeg must report the desktop size within this long, or `start()` rejects
 *  instead of hanging forever — mirrors the macOS helper's own timeout. A
 *  torn size line that's simply never reassembled looks identical from the
 *  caller's side to ffmpeg staying silent, so both need this backstop. */
const START_TIMEOUT_MS = 10_000;

/** After this many lost pointer reporters the box gets the pointer back in
 *  the video (no onCursor → the server doesn't offer a local pointer) until
 *  the server restarts — a reporter that can't run must not cost the whole
 *  session its three restart attempts every time. */
const POINTER_GIVE_UP = 2;
let pointerFailures = 0;

export function createWin32Capture(): ScreenCapture {
  let child: ChildProcess | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  let onCursor: ((x: number, y: number) => void) | null = null;
  let pointer: ChildProcess | null = null;
  // Same as on macOS: a planned shutdown must not be reported as a crash, or the
  // restart logic from Task 18 would start the just-stopped session again.
  let stopping = false;

  /** The pointer reporter for a local pointer (cursor-helper.ps1). The video
   *  carries no pointer then — if the reporter dies, the session must restart
   *  (with the pointer back in the picture on a failing box) rather than go on
   *  without any pointer at all. */
  function startPointer(cb: (x: number, y: number) => void) {
    const p = spawn('powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winCursorScriptPath()],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    pointer = p;
    p.stdin?.on('error', () => {});
    let rest = '';
    p.stdout?.on('data', (b: Buffer) => {
      const split = splitLines(rest, b.toString());
      rest = split.rest;
      for (const line of split.lines) {
        const pos = parseCursorLine(line);
        if (pos && pointer === p) cb(pos.x, pos.y);
      }
    });
    const lost = () => {
      if (pointer !== p) return;
      pointer = null;
      if (stopping) return;
      pointerFailures++;
      onError('helper_crashed', 'Zeiger-Melder beendet');
    };
    p.on('exit', lost);
    p.on('error', lost);
  }

  function stopPointer() {
    const p = pointer;
    pointer = null;
    if (!p) return;
    try { p.stdin?.end(); } catch { /* already gone */ }
    setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, 300).unref();
  }

  const api: ScreenCapture = {
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
        let stderrRest = '';

        const settle = () => {
          settled = true;
          clearTimeout(startTimeout);
        };

        const startTimeout = setTimeout(() => {
          if (settled) return;
          settle();
          proc.kill('SIGKILL');
          reject(new Error('ffmpeg antwortet nicht (Zeitlimit ueberschritten)'));
        }, START_TIMEOUT_MS);

        proc.stdout.on('data', (b: Buffer) => onData(b));

        if (opts.localCursor && onCursor) startPointer(onCursor);

        proc.stderr.on('data', (b: Buffer) => {
          const text = b.toString();
          tail = (tail + text).slice(-4096);
          if (settled) return;
          // Buffered, not a bare split('\n'): a size line torn across two
          // `data` events must still be reassembled, or this never resolves
          // and start() hangs until the timeout above finally kills it.
          const { lines, rest } = splitLines(stderrRest, text);
          stderrRest = rest;
          for (const line of lines) {
            const size = parseCaptureSize(line);
            if (!size) continue;
            settle();
            // ddagrab captures physical pixels and Windows reports them as such,
            // so there is no Retina-style factor to undo here — but the size
            // itself must reflect what the -vf filter actually outputs, not
            // the raw pre-filter desktop size (see computeOutputSize above).
            const out = computeOutputSize(opts, size);
            resolve({ width: out.width, height: out.height, scale: captureScale(size.width, out.width) });
            return;
          }
        });

        proc.on('exit', (code) => {
          child = null;
          stopPointer();
          if (stopping) return;                      // planned shutdown
          if (!settled) { settle(); reject(new Error(`ffmpeg beendet (${code}): ${tail.slice(-200)}`)); }
          else onError('helper_crashed', `ffmpeg beendet (${code})`);
        });

        proc.on('error', () => {
          if (!settled) {
            settle();
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
      stopPointer();
      if (!proc) return;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 500);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
  if (pointerFailures < POINTER_GIVE_UP) api.onCursor = (cb) => { onCursor = cb; };
  return api;
}
