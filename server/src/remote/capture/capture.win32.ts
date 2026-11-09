import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';
import { splitLines } from '../lines';
import { winCursorScriptPath, winAudioScriptPath, winCurtainScriptPath } from '../paths';
import { createOggReader, buildOpusEncoderArgs } from '../ogg';

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

/** The encoder probe runs ffmpeg once and blocks — done once per server run,
 *  not on every (re)start of a session. A failed probe is not remembered. */
let encodersCache: string[] | null = null;
function availableEncoders(): string[] {
  if (encodersCache) return encodersCache;
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const found = ENCODER_PREFERENCE.filter((e) => out.includes(e));
    if (found.length) encodersCache = found;
    return found;
  } catch {
    return [];
  }
}

/**
 * ffmpeg cannot change its bitrate while running, so on Windows a bitrate
 * change means a second ffmpeg at the new rate that takes over once it
 * delivers (see `respawn`). That costs a capture start, so not on every nudge
 * of the flow control: down only for a real cut and at most every few
 * seconds, up only for a clear step and rarely.
 *
 * Returns null = leave it, 0 = now, >0 = ask again after that many ms.
 */
export const RESPAWN_DOWN_GAP_MS = 5_000;
export const RESPAWN_UP_GAP_MS = 30_000;
export function bitrateRespawnWait(runningKbps: number, wantKbps: number, sinceSpawnMs: number): number | null {
  if (wantKbps <= runningKbps * 0.85) return Math.max(0, RESPAWN_DOWN_GAP_MS - sinceSpawnMs);
  if (wantKbps >= runningKbps * 1.3) return Math.max(0, RESPAWN_UP_GAP_MS - sinceSpawnMs);
  return null;
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

/** Sound/curtain helpers compile C# on start — give them this long to report. */
const EXTRA_READY_MS = 8_000;

function powershell(script: string, extra: string[] = []): ChildProcess {
  return spawn('powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra],
    { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Puts back mute state / brightness a killed helper left behind. */
function restoreAfterKill(script: string) {
  try { powershell(script, ['-Restore']).on('error', () => {}); } catch { /* best effort */ }
}

/** First JSON line that says ready (→ its payload) or error (→ null), on the given stream. */
function waitReady(proc: ChildProcess, stream: NodeJS.ReadableStream | null, key: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let rest = '';
    let done = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), EXTRA_READY_MS);
    stream?.on('data', (b: Buffer) => {
      if (done) return;
      const split = splitLines(rest, b.toString());
      rest = split.rest;
      for (const line of split.lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t) as { ready?: Record<string, unknown>; error?: unknown };
          if (obj.ready && obj.ready[key] === true) return finish(obj.ready);
          if (obj.error) return finish(null);
        } catch { /* noise */ }
      }
    });
    proc.on('exit', () => finish(null));
    proc.on('error', () => finish(null));
  });
}

/** Ends a helper that restores on stdin EOF; a kill instead triggers -Restore. */
function endHelper(proc: ChildProcess | null, script: string) {
  if (!proc) return;
  let exited = proc.exitCode !== null;
  proc.on('exit', () => { exited = true; });
  try { proc.stdin?.end(); } catch { /* already gone */ }
  setTimeout(() => {
    if (exited) return;
    try { proc.kill(); } catch { /* already gone */ }
    restoreAfterKill(script);
  }, 2_000).unref();
}

export function createWin32Capture(): ScreenCapture {
  /** The ffmpeg whose picture goes out. */
  let child: ChildProcess | null = null;
  /** A replacement at a new bitrate, until its first picture arrives. */
  let pending: ChildProcess | null = null;
  let running: CaptureOptions | null = null;
  let encoder: string | null = null;
  let lastSpawnAt = 0;
  let wantKbps: number | null = null;
  let respawnTimer: NodeJS.Timeout | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  let onCursor: ((x: number, y: number) => void) | null = null;
  let pointer: ChildProcess | null = null;
  let onAudio: (packet: Buffer) => void = () => {};
  let curtainProc: ChildProcess | null = null;
  let soundProc: ChildProcess | null = null;
  let opusProc: ChildProcess | null = null;
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

  /** Black curtain (curtain-helper.ps1): true once it is up and left out of the capture. */
  async function startCurtain(): Promise<boolean> {
    const p = powershell(winCurtainScriptPath());
    curtainProc = p;
    p.stdin?.on('error', () => {});
    p.stderr?.on('data', () => {});
    p.on('exit', (code) => {
      // Died by itself (not our stdin EOF): put the brightness back.
      if (curtainProc === p && code !== 0 && !stopping) restoreAfterKill(winCurtainScriptPath());
    });
    const ok = (await waitReady(p, p.stdout, 'curtain')) !== null;
    if (!ok) { endHelper(p, winCurtainScriptPath()); if (curtainProc === p) curtainProc = null; }
    return ok;
  }

  /** Sound: audio-helper.ps1 (PCM) → ffmpeg (Opus in Ogg) → packets. */
  async function startSound(): Promise<boolean> {
    const p = powershell(winAudioScriptPath());
    soundProc = p;
    p.stdin?.on('error', () => {});
    const ready = await waitReady(p, p.stderr, 'audio');
    if (!ready || stopping) { endHelper(p, winAudioScriptPath()); if (soundProc === p) soundProc = null; return false; }
    const rate = Number(ready.rate) > 0 ? Number(ready.rate) : 48000;
    const enc = spawn('ffmpeg', buildOpusEncoderArgs(rate, 2), { stdio: ['pipe', 'pipe', 'ignore'] });
    opusProc = enc;
    enc.stdin?.on('error', () => {});
    enc.on('error', () => {});
    p.stdout?.on('data', (b: Buffer) => { if (enc.stdin?.writable) enc.stdin.write(b); });
    const reader = createOggReader();
    enc.stdout?.on('data', (b: Buffer) => { for (const packet of reader.push(b)) onAudio(packet); });
    p.on('exit', (code) => {
      try { enc.stdin?.end(); } catch { /* gone */ }
      if (soundProc === p && code !== 0 && !stopping) restoreAfterKill(winAudioScriptPath());
    });
    return true;
  }

  function stopExtras() {
    const c = curtainProc, a = soundProc, o = opusProc;
    curtainProc = null; soundProc = null; opusProc = null;
    endHelper(c, winCurtainScriptPath());
    endHelper(a, winAudioScriptPath());
    if (o) setTimeout(() => { try { o.kill(); } catch { /* gone */ } }, 2_500).unref();
  }

  function launch(opts: CaptureOptions, enc: string): ChildProcess {
    lastSpawnAt = Date.now();
    return spawn('ffmpeg', buildFfmpegArgs(opts, enc), { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** The live ffmpeg died on its own: same report as before. */
  function lostLive(proc: ChildProcess, code: number | null) {
    if (child !== proc) return;
    child = null;
    stopPointer();
    stopExtras();
    if (!stopping) onError('helper_crashed', `ffmpeg beendet (${code})`);
  }

  /**
   * New bitrate = second ffmpeg. The running one keeps delivering until the
   * new one's first data arrives (a fresh ffmpeg always opens with SPS/PPS +
   * keyframe), then it takes over and the old one is stopped — no gap, and
   * the switch itself ends any freeze. If the replacement fails (Windows
   * limits desktop duplications per session), the old one simply stays.
   */
  function respawn(kbps: number) {
    if (stopping || !child || !running || !encoder || pending) return;
    const opts = { ...running, bitrateKbps: kbps };
    const proc = launch(opts, encoder);
    pending = proc;
    proc.stderr?.on('data', () => { /* drained; nothing to parse after start */ });
    proc.stdout?.on('data', (b: Buffer) => {
      if (pending === proc) {
        const old = child;
        pending = null;
        child = proc;
        running = opts;
        if (old) { try { old.kill('SIGTERM'); } catch { /* already gone */ } }
      }
      if (child === proc) onData(b);
    });
    const gone = (code: number | null) => {
      if (pending === proc) { pending = null; return; } // never took over: keep the old one
      lostLive(proc, code);
    };
    proc.on('exit', gone);
    proc.on('error', () => gone(null));
  }

  function evaluateBitrate() {
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (stopping || !running || wantKbps === null) return;
    const wait = bitrateRespawnWait(running.bitrateKbps, wantKbps, Date.now() - lastSpawnAt);
    if (wait === null) return;
    if (wait === 0) { if (!pending) respawn(wantKbps); return; }
    respawnTimer = setTimeout(evaluateBitrate, wait);
    respawnTimer.unref();
  }

  const api: ScreenCapture = {
    keyframeOnDemand: false,

    async start(opts) {
      // Curtain and sound start alongside ffmpeg; the session waits for their
      // answer (bounded) so remote:started can say what actually runs.
      const extras = Promise.all([
        opts.curtain ? startCurtain().catch(() => false) : Promise.resolve(false),
        opts.audio ? startSound().catch(() => false) : Promise.resolve(false),
      ]);
      let info: CaptureInfo;
      try {
        info = await startVideo(opts);
      } catch (e) {
        stopExtras();
        throw e;
      }
      const [curtain, audio] = await extras;
      return {
        ...info,
        ...(opts.curtain ? { curtain } : {}),
        ...(opts.audio ? { audio } : {}),
      };
    },

    onData(cb) { onData = cb; },
    onError(cb) { onError = cb; },
    onAudio(cb) { onAudio = cb; },

    // ffmpeg cannot cut a keyframe on request (keyframeOnDemand: false tells
    // the flow control to drop less and never drop a keyframe); a bitrate
    // change goes through a replacement ffmpeg, see respawn().
    requestKeyframe() { /* not possible with ffmpeg: see keyframeOnDemand */ },
    setBitrate(kbps) { wantKbps = kbps; evaluateBitrate(); },

    async stop() {
      const proc = child;
      const next = pending;
      stopping = true;
      child = null;
      pending = null;
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      stopPointer();
      stopExtras();
      if (next) { try { next.kill('SIGTERM'); } catch { /* already gone */ } }
      if (!proc) return;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 500);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };

  function startVideo(opts: CaptureOptions): Promise<CaptureInfo> {
      return new Promise<CaptureInfo>((resolve, reject) => {
        const enc = pickEncoder(availableEncoders());
        if (!enc) {
          reject(new Error(
            'ffmpeg mit H.264-Encoder nicht gefunden. Einmalig einrichten mit:  winget install ffmpeg'));
          return;
        }
        encoder = enc;
        running = opts;

        const proc = launch(opts, enc);
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

        proc.stdout?.on('data', (b: Buffer) => { if (child === proc) onData(b); });

        if (opts.localCursor && onCursor) startPointer(onCursor);

        proc.stderr?.on('data', (b: Buffer) => {
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
          if (!settled) {
            child = null;
            stopPointer();
            if (stopping) return;
            settle();
            reject(new Error(`ffmpeg beendet (${code}): ${tail.slice(-200)}`));
            return;
          }
          lostLive(proc, code);
        });

        proc.on('error', () => {
          if (!settled) {
            settle();
            reject(new Error('ffmpeg nicht gefunden. Einmalig einrichten mit:  winget install ffmpeg'));
          }
        });
      });
  }

  if (pointerFailures < POINTER_GIVE_UP) api.onCursor = (cb) => { onCursor = cb; };
  return api;
}
