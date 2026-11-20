import type {
  RemoteClientMessage, RemoteServerMessage, RemoteErrorCode, RemoteQualityPreset,
  RemoteInputEvent,
} from '../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture/capture.types';
import { RemoteCaptureError } from './capture/capture.types';
import type { InputInjector } from './input/input.types';
import { createAnnexBSplitter, type AccessUnit } from './annexb';
import { createFrameFlow, type FrameFlow } from './flow';
import { nextRestartDelay } from './restart';
import { logger } from '../utils/logger';

/** Fixed rungs from the design doc. `auto` is the default. */
export const QUALITY_PRESETS: Record<RemoteQualityPreset, CaptureOptions> = {
  sparsam: { maxWidth: 1280, fps: 24, bitrateKbps: 800 },
  auto:    { maxWidth: 1600, fps: 30, bitrateKbps: 1500 },
  scharf:  { maxWidth: 1920, fps: 30, bitrateKbps: 3000 },
};

/** The upgrade handler routes every path to the terminal handler — this splits it off. */
export function isRemotePath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0];
  return path === '/remote' || path === '/remote/';
}

export interface RemoteWs {
  send(data: string | Buffer, opts?: { compress?: boolean }): void;
  close(): void;
  /** Used to measure round-trip time for the header's "fps · ms" readout —
   *  the data payload is echoed back verbatim in the matching 'pong'. */
  ping(data?: Buffer): void;
  readyState: number;
  bufferedAmount: number;
  on(event: 'message', cb: (raw: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'pong', cb: (data: Buffer) => void): void;
}

export interface RemoteDeps {
  makeCapture: () => ScreenCapture;
  makeInput: () => InputInjector;
  isEnabled: () => boolean;
}

/**
 * Wire format for one frame:
 *   byte 0    0x01 = video access unit, bit 0x80 = keyframe
 *   byte 1-4  milliseconds since session start (uint32 BE)
 *   byte 5..  H.264 Annex-B payload
 */
export function packAccessUnit(au: AccessUnit, tsMs: number): Buffer {
  const head = Buffer.alloc(5);
  head[0] = 0x01 | (au.keyframe ? 0x80 : 0);
  head.writeUInt32BE(Math.max(0, Math.floor(tsMs)) >>> 0, 1);
  return Buffer.concat([head, au.data]);
}

/**
 * Wire format for one sound packet (the computer's audio on the phone):
 *   byte 0    0x02 = Opus packet (48 kHz stereo, 20 ms)
 *   byte 1-4  milliseconds since session start (uint32 BE)
 *   byte 5..  the Opus packet
 */
export function packAudio(packet: Buffer, tsMs: number): Buffer {
  const head = Buffer.alloc(5);
  head[0] = 0x02;
  head.writeUInt32BE(Math.max(0, Math.floor(tsMs)) >>> 0, 1);
  return Buffer.concat([head, packet]);
}

/** Sound is tiny next to the picture; only a link that is truly stuck skips it. */
export const AUDIO_SKIP_BUFFERED = 1_000_000;

// ── A session outlives its connection ─────────────────────────────────────
// The user wants remote access to stay on until THEY close it — not end when
// the phone switches screens, goes to the background or its network drops for
// a moment. So a connection that goes away without `remote:stop` leaves its
// session here ("resting"): the computer keeps its state (screen off / virtual
// display, sound muted), and the next `remote:start` with the same options
// picks it up instead of starting over. One per server — the app runs one
// session per computer. As a safety net it ends after hours without any phone.

/** A resting session ends by itself after this long without a connection. */
export const PARK_MAX_MS = 6 * 60 * 60_000;

interface Parked {
  capture: ScreenCapture;
  input: InputInjector;
  opts: CaptureOptions;
  info: CaptureInfo;
  timer: NodeJS.Timeout;
}
let parked: Parked | null = null;

/** Ends the resting session (if any); true if there was one. */
export async function endParked(): Promise<boolean> {
  const p = parked;
  if (!p) return false;
  parked = null;
  clearTimeout(p.timer);
  await p.capture.stop().catch(() => {});
  await p.input.stop().catch(() => {});
  logger.info('Remote: ruhende Sitzung beendet');
  return true;
}

/** The connection whose session is running right now (one per server). A
 *  `remote:stop` from another connection — the app's "end" in the ⋮ menu,
 *  while its own picture connection is only paused or already half dead —
 *  must reach this session too, not just a resting one. */
let live: { end: () => Promise<void> } | null = null;

/** Test hook: is there a resting session? */
export function hasParkedSession(): boolean { return parked !== null; }

/** Same request = the resting session can be picked up as it is. */
export function sameRemoteOpts(a: CaptureOptions, b: CaptureOptions): boolean {
  return a.maxWidth === b.maxWidth && a.fps === b.fps && a.bitrateKbps === b.bitrateKbps
    && !!a.localCursor === !!b.localCursor && !!a.audio === !!b.audio && !!a.curtain === !!b.curtain;
}

function applyInput(input: InputInjector, ev: RemoteInputEvent): void {
  switch (ev.t) {
    case 'd': input.moveRelative(ev.dx, ev.dy); break;
    case 'm': input.moveAbsolute(ev.x, ev.y); break;
    case 'b': input.button(ev.b === 'r' ? 'right' : ev.b === 'm' ? 'middle' : 'left', ev.d); break;
    case 's': input.scroll(ev.dx, ev.dy); break;
    case 'k': input.key(ev.c, ev.d, ev.mods); break;
    case 'x': input.text(ev.s); break;
    case 'g': input.gesture(ev.g); break;
    default: break;
  }
}

/**
 * Round-trip time from a ping's embedded send timestamp to now. Pulled out
 * as a pure function so the arithmetic is unit-testable without faking
 * WebSocket ping/pong timing or real 1-second intervals.
 */
export function computeRttMs(pingPayload: Buffer, now: number): number | null {
  // N3 (Nachprüfung): an empty payload must not fall through to Number() —
  // Number('') is 0, which Number.isFinite() happily accepts as "the epoch
  // start". The server-wide 15s heartbeat in ws.server.ts calls ws.ping()
  // with no payload at all, so its pong slipped past the old guard and set
  // rttMs to roughly Date.now() itself — visible as the header reading
  // something like "30 fps · 1786…ms" once every 15 seconds.
  if (pingPayload.length === 0) return null;
  const sentAt = Number(pingPayload.toString());
  if (!Number.isFinite(sentAt)) return null;
  return Math.max(0, now - sentAt);
}

/** Keep-alive ping while the picture is hidden (visible: once a second). */
const HIDDEN_PING_MS = 25_000;

export function handleRemoteConnection(ws: RemoteWs, deps: RemoteDeps, ip = 'unknown'): void {
  let capture: ScreenCapture | null = null;
  let input: InputInjector | null = null;
  let splitter: ReturnType<typeof createAnnexBSplitter> | null = null;
  let flow: FrameFlow | null = null;
  let startedAt = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let framesSent = 0;
  let bytesSent = 0;
  let dropped = 0;
  let rttMs = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  // Helper-restart bookkeeping (Task 18): a crashed helper and a display whose
  // resolution changed underneath the running capture both die the same way —
  // `onError('helper_crashed', ...)` — and get the same answer, a fresh
  // capture built from the same options that were last requested.
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let lastOpts: CaptureOptions | null = null;
  let lastInfo: CaptureInfo | null = null;
  /** The app shows the picture (remote:view). Hidden: no video is sent. */
  let visible = true;
  /** What this connection last told its capture (see syncPause). */
  let capturePaused = false;
  /** Feeds finished frames to the app; set while a capture is running. */
  let flushFrames: (() => void) | null = null;

  /**
   * The computer captures and encodes only while someone can see the picture.
   * Before this, a hidden picture (working on in the terminal, app in the
   * background) cost the computer a full screen capture + H.264 encode, frame
   * after frame, just to throw every frame away.
   */
  function syncPause() {
    const want = !visible;
    if (!capture || want === capturePaused) return;
    capturePaused = want;
    capture.setPaused?.(want);
  }

  const sendPing = () => { if (ws.readyState === 1) ws.ping(Buffer.from(String(Date.now()))); };

  /**
   * Timers follow visibility too. Visible: frame flush every 4 ms, status and
   * ping once a second (the header shows them). Hidden: nobody reads a status,
   * so none is sent — and the connection is only kept alive. Each of those
   * messages woke the phone's radio once a second for as long as a session
   * was merely kept.
   */
  function armTimers() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!visible) {
      pingTimer = setInterval(sendPing, HIDDEN_PING_MS);
      pingTimer.unref();
      return;
    }
    // A frame only ends at the next start code; without this idle flush every
    // frame hangs until the one after it (33 ms of extra latency at 30 fps).
    idleTimer = setInterval(() => { flushFrames?.(); }, 4);
    idleTimer.unref();
    statusTimer = setInterval(() => {
      reply({
        type: 'remote:status',
        payload: {
          fps: framesSent,
          kbps: Math.round((bytesSent * 8) / 1000),
          rttMs,
          dropped,
        },
      });
      framesSent = 0; bytesSent = 0; dropped = 0;
    }, 1000);
    statusTimer.unref();
    // Ping right away (not just on the first 1s tick) so the header's
    // latency reading isn't stuck at 0 for the first second of a session,
    // then once a second after — same cadence as remote:status. The send
    // timestamp travels in the payload itself (see computeRttMs) so a
    // stray pong from the server-wide heartbeat can't be misread as one
    // of these.
    sendPing();
    pingTimer = setInterval(sendPing, 1000);
    pingTimer.unref();
  }
  /** The app said remote:stop — then a closing connection really ends it. */
  let userStopped = false;

  const reply = (msg: RemoteServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const fail = (code: RemoteErrorCode, message: string) => reply({
    type: 'remote:error', payload: { code, message },
  });

  // The control connection can measure its own latency — no need to leave
  // the header's "· ms" reading permanently at 0. Echoing a send timestamp
  // in the ping payload (rather than relying on ordering) means a stray pong
  // from the server-wide 15s heartbeat in ws.server.ts can't be mistaken for
  // one of these.
  ws.on('pong', (data: Buffer) => {
    const r = computeRttMs(data, Date.now());
    if (r !== null) rttMs = r;
  });

  /** This connection as the server's running session (see `live` above). */
  const me = { end: async () => { userStopped = true; await stop('vom Nutzer beendet'); } };

  async function stop(reason: string, tell = true) {
    const c = capture, i = input;
    capture = null; input = null;
    flushFrames = null;
    if (live === me) live = null;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    rttMs = 0;
    // A pending restart belongs to the capture being torn down here — without
    // this, a user-issued stop (or a fresh explicit start) that lands while a
    // crash-recovery backoff is still ticking would leave that timer alive,
    // and it would later revive a session nobody asked for.
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    splitter = null;
    flow = null;
    if (c) await c.stop().catch(() => {});
    if (i) await i.stop().catch(() => {});
    if (tell && (c || i)) reply({ type: 'remote:stopped', payload: { reason } });
  }

  /** The connection is gone but nobody closed the session: let it rest
   *  (see Parked above) instead of ending it. False if there is nothing to keep. */
  function park(): boolean {
    const c = capture, i = input;
    if (!c || !i || !lastOpts || !lastInfo) return false;
    capture = null; input = null;
    flushFrames = null;
    // Nobody is connected: the computer stops capturing until someone is.
    if (!capturePaused) c.setPaused?.(true);
    if (live === me) live = null;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    splitter = null;
    flow = null;
    // Nobody to send to; a crash while resting just ends it.
    c.onData(() => {});
    c.onAudio?.(() => {});
    c.onCursor?.(() => {});
    c.onLockChange?.(() => {});
    c.onError(() => { if (parked && parked.capture === c) void endParked(); });
    if (parked) void endParked();
    const timer = setTimeout(() => { void endParked(); }, PARK_MAX_MS);
    timer.unref();
    parked = { capture: c, input: i, opts: lastOpts, info: lastInfo, timer };
    logger.info(`Remote: Verbindung weg, Sitzung ruht (${ip}) — bleibt an, bis sie geschlossen wird`);
    return true;
  }

  // `isRestart` is set only by the crash-recovery retry below, never by a
  // client-issued `remote:start`. It decides whether a successful start resets
  // the crash-backoff counter (see `restartAttempt` just below): if every
  // successful start reset it, a helper stuck in a crash loop could never
  // reach the give-up threshold, because each restart's own success would
  // erase the count moments before the next crash could ever be observed —
  // becoming ready is always required before a capture can crash again, so
  // the reset would immediately precede and cancel out the very thing it's
  // meant to be counted against. Only a deliberate, externally-requested
  // start (a genuinely fresh session) gets a clean slate.
  async function start(opts: CaptureOptions, isRestart = false) {
    if (!deps.isEnabled()) {
      fail('disabled', 'Fernzugriff ist auf diesem Server abgeschaltet.');
      return;
    }
    // A stray second `remote:start` replaces the running session — stop the
    // previous capture first so it never keeps running orphaned.
    await stop('neustart', false);
    userStopped = false;

    // A resting session with the same options is picked up as it is; one
    // with other options (quality, sound, screen off changed) is ended first.
    let adopt: Parked | null = null;
    if (!isRestart && parked) {
      if (sameRemoteOpts(parked.opts, opts)) {
        adopt = parked;
        parked = null;
        clearTimeout(adopt.timer);
      } else {
        await endParked();
      }
    }

    // Everything that can throw — including building the capture and wiring its
    // error callback — stays inside the try. The placeholder factory (and any
    // real platform backend that fails to initialize) throws synchronously here;
    // without the try around it the client got neither `remote:started` nor
    // `remote:error` and the connection just hung silently.
    try {
      // Remembered so a crash-recovery restart (below) and a stray delayed
      // 'helper_crashed' can both rebuild the capture from the options that
      // were actually last requested, not some earlier quality tier.
      lastOpts = opts;
      const c = adopt ? adopt.capture : deps.makeCapture();
      // Errors can arrive well after this capture has been replaced by a newer
      // session — real platform backends report crashes and dropped helper
      // processes asynchronously, often several ticks later. Both checks below
      // compare by identity, not by order: the first drops an error from an
      // already-replaced capture outright (`capture === null` is let through —
      // nothing has been assigned yet while `start()` is still running); the
      // second re-checks identity at the moment the queued task actually runs,
      // since a newer session's start can complete in the meantime.
      c.onError((code, message) => {
        if (capture !== null && capture !== c) return;

        // A crashed helper is the normal case, not the end of the world — the
        // same path also covers a display whose resolution changed underneath
        // the running capture, which dies the exact same way. Try to bring it
        // back with growing backoff before bothering the user; only once that
        // has failed enough times in a row does this fall through to `fail`.
        if (code === 'helper_crashed' && lastOpts) {
          const delay = nextRestartDelay(restartAttempt++);
          if (delay !== null) {
            const opts2 = lastOpts;
            enqueue(async () => {
              // Re-checked at execution time, same as the give-up path below —
              // the queue may run this well after `c` was replaced by a newer
              // session (an explicit remote:start, or a previous restart).
              if (capture !== c) return;
              await stop('neustart', false);
              restartTimer = setTimeout(() => { enqueue(() => start(opts2, true)); }, delay);
              restartTimer.unref();
            });
            return;
          }
        }

        fail(code, message);
        enqueue(async () => { if (capture === c) await stop('fehler', false); });
      });
      // The app asked to draw the pointer itself; only honoured where the
      // backend can report the position (macOS). Everywhere else the pointer
      // stays in the video, exactly as before.
      const localCursor = !!opts.localCursor && typeof c.onCursor === 'function';
      if (localCursor) {
        // Same identity rule as onError above: `capture === null` is let
        // through, because the helper's FIRST report (sent once, right after
        // it is ready) arrives before `capture = c` below — and on a still
        // pointer it would be the only one.
        c.onCursor!((x, y) => {
          if (capture !== null && capture !== c) return;
          if (!visible) return; // nobody draws a pointer while the picture is hidden
          reply({ type: 'remote:cursor', payload: { x, y } });
        });
      }
      if (typeof c.onAudio === 'function') {
        // Not through the frame flow control: 20 ms packets of a few hundred
        // bytes — dropping them only makes crackle, and they never cause the
        // congestion the flow control reacts to.
        c.onAudio((packet) => {
          if (capture !== c || ws.readyState !== 1) return;
          if (ws.bufferedAmount > AUDIO_SKIP_BUFFERED) return;
          ws.send(packAudio(packet, Date.now() - startedAt), { compress: false });
        });
      }
      if (typeof c.onLockChange === 'function') {
        c.onLockChange((locked) => {
          if (capture !== null && capture !== c) return;
          reply({ type: 'remote:locked', payload: { locked } });
        });
      }
      const info = adopt ? adopt.info : await c.start({ ...opts, localCursor });
      lastInfo = info;
      capture = c;
      const injector = adopt ? adopt.input : deps.makeInput();
      input = injector;
      live = me;
      const resumed = adopt !== null;
      adopt = null; // owned by this connection now

      splitter = createAnnexBSplitter();
      flow = createFrameFlow(opts.bitrateKbps, { keyframeOnDemand: c.keyframeOnDemand !== false });
      startedAt = Date.now();
      // Only a fresh, externally-requested session clears the crash-backoff
      // count — see the comment on `isRestart` above for why a restart's own
      // success must not clear it.
      if (!isRestart) restartAttempt = 0;
      framesSent = 0; bytesSent = 0; dropped = 0;

      const emit = (units: AccessUnit[]) => {
        for (const au of units) {
          if (!flow || ws.readyState !== 1) return;
          if (!visible) continue; // picture not shown: the session runs on, nothing sent
          const now = Date.now();
          const decision = flow.decide(au, now, ws.bufferedAmount);
          if (decision.bitrateKbps !== null) capture?.setBitrate(decision.bitrateKbps);
          if (decision.requestKeyframe) capture?.requestKeyframe();
          if (!decision.send) { dropped++; continue; }
          // The same integer the app will echo back in remote:ack (see flow.ts).
          const ts = Math.max(0, Math.floor(now - startedAt));
          const frame = packAccessUnit(au, ts);
          // Already compressed — a second pass would only cost CPU time.
          ws.send(frame, { compress: false });
          flow.onSent(ts, now);
          framesSent++;
          bytesSent += frame.length;
        }
      };

      c.onData((chunk) => { if (splitter) emit(splitter.push(chunk, Date.now())); });

      flushFrames = () => { if (splitter) emit(splitter.tick(Date.now())); };
      // A picked-up session was paused while it rested (see park()).
      capturePaused = resumed;
      syncPause();
      armTimers();

      // Wait for the input backend to actually confirm it is reading before
      // telling the client the session is live. Without this, the app's
      // first burst of pointer/keyboard events can arrive while the platform
      // helper is still starting up (process launch, permission check,
      // before its own read loop runs) and vanish silently — measured on
      // macOS as roughly the first 100ms of motion getting lost. Both
      // platform backends actually have this startup race (see the doc on
      // InputInjector.ready in input.types.ts) and both provide it; `ready`
      // is typed optional only for a hypothetical future backend without
      // one. This await must stay inside the surrounding try — a rejected
      // `ready` has to reach the client as `remote:error`, not hang the
      // connection silently (already a Critical once in this file, for a
      // synchronously-throwing capture factory).
      await injector.ready;

      reply({
        type: 'remote:started',
        payload: { ...info, fps: opts.fps, codec: 'avc1', localCursor, keyframeOnDemand: c.keyframeOnDemand !== false,
          // Fingerabdruck-Entsperren gibt es nur, wo der Sperrbildschirm gemeldet wird (Mac).
          unlock: typeof c.onLockChange === 'function',
          audio: info.audio === true, curtain: info.curtain === true },
      });
      // Section 9 of the spec requires logging time + source IP for every
      // session start — `logger.info` timestamps its own lines, `ip` comes
      // from the HTTP upgrade in ws.server.ts.
      logger.info(`Remote: Sitzung ${resumed ? 'fortgesetzt' : 'gestartet'} von ${ip} (${info.width}x${info.height} @${opts.fps})`);
      // A picked-up session's encoder is mid-stream: the new decoder needs a keyframe.
      if (resumed) c.requestKeyframe();
    } catch (e) {
      // A RemoteCaptureError carries the code the helper actually reported
      // (permission_screen, permission_input, display_asleep, ...) through
      // to the client. Anything else — a timeout, an unexpected exit — has
      // no known code and falls back to the generic capture_unavailable,
      // same as before.
      // Failed before the picked-up session was taken over: don't leak it.
      if (adopt) {
        const a = adopt as Parked;
        await a.capture.stop().catch(() => {});
        await a.input.stop().catch(() => {});
      }
      const code = e instanceof RemoteCaptureError ? e.code : 'capture_failed';
      const message = e instanceof Error ? e.message : String(e);
      // Logged too: the phone only shows it briefly, and a failed start
      // otherwise left no trace at all in the server log.
      logger.warn(`Remote: Start fehlgeschlagen (${code}) fuer ${ip}: ${message}`);
      fail(code, message);
    }
  }

  // `remote:start` / `remote:stop` mutate session state — serialize them so two
  // frames landing in the same TCP read (or a `stop` immediately followed by a
  // `start` on a quality-tier switch) never run concurrently and race on
  // `capture`/`input`. `fn` doubles as both the fulfilled and rejected handler so
  // the chain keeps moving even if a previous task somehow rejected.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => { queue = queue.then(fn, fn); };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;                       // the app only ever sends text frames
    let msg: unknown;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Input events carry `t`, not `type` — short keys because pointer movement
    // alone can produce up to 60 messages per second. This must be checked
    // before the `type` guard below, or every input event gets discarded.
    if (msg && typeof (msg as { t?: unknown }).t === 'string') {
      if (input) applyInput(input, msg as RemoteInputEvent);
      return;
    }

    if (!msg || typeof (msg as { type?: unknown }).type !== 'string') return;
    const clientMsg = msg as RemoteClientMessage;

    switch (clientMsg.type) {
      case 'remote:start':
        enqueue(() => start(clientMsg.payload));
        break;
      case 'remote:stop':
        enqueue(async () => {
          userStopped = true;
          // Closing from the app ends the session wherever it is: resting, or
          // still held by another connection (the app's paused picture
          // connection — "Beenden" in the ⋮ menu opens a fresh one). Always
          // confirmed, so the app only shows "beendet" once it really is.
          if (!capture && !input) {
            if (parked) await endParked();
            else if (live && live !== me) await live.end();
            reply({ type: 'remote:stopped', payload: { reason: 'vom Nutzer beendet' } });
            return;
          }
          await stop('vom Nutzer beendet');
        });
        break;
      case 'remote:view': {
        const v = (clientMsg.payload as { visible?: unknown } | undefined)?.visible;
        const was = visible;
        visible = v !== false;
        if (visible === was) break;
        // Continue capturing BEFORE asking for the keyframe, then timers.
        syncPause();
        // Shown again: the decoder needs a fresh keyframe to start from.
        if (visible) capture?.requestKeyframe();
        if (capture) armTimers();
        break;
      }
      case 'remote:keyframe':
        capture?.requestKeyframe();
        break;
      case 'remote:ack': {
        // One per received frame — feeds the queueing-delay measurement in flow.ts.
        const ts = (clientMsg.payload as { ts?: unknown } | undefined)?.ts;
        if (typeof ts === 'number' && Number.isFinite(ts)) flow?.onAck(ts, Date.now());
        break;
      }
      default:
        break;                                   // silently discard unknown message types
    }
  });

  // Gone without remote:stop (screen switch, background, network): the
  // session rests and waits for the phone (see park()).
  ws.on('close', () => { enqueue(async () => { if (userStopped || !park()) await stop('Verbindung getrennt', false); }); });

  // A dropped/reset connection fires 'error' on this EventEmitter. Node throws
  // synchronously for an 'error' event with no listener, which lands in the
  // process-wide uncaughtException handler and kills the whole server (see
  // server/src/index.ts) — taking every other terminal session down with it.
  // Treat it exactly like a close: log it, tear the session down, never crash.
  ws.on('error', (err) => {
    logger.error(`Remote: socket error — ${err.message}`);
    enqueue(async () => { if (userStopped || !park()) await stop('Socket-Fehler', false); });
  });

  // N2 (Nachprüfung): reject up front instead of accepting the connection
  // and only finding out once the client bothers to send `remote:start` —
  // but only AFTER every listener above is registered, 'error' included.
  // This used to run — and `return` — right after the 'pong' listener,
  // before 'message'/'close'/'error' were ever attached; a disabled
  // connection had no error listener at all for its entire lifetime, which
  // is exactly the crash this file otherwise guards against everywhere else.
  if (!deps.isEnabled()) {
    fail('disabled', 'Fernzugriff ist auf diesem Server abgeschaltet.');
    ws.close();
  }
}
