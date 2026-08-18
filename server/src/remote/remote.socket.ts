import type {
  RemoteClientMessage, RemoteServerMessage, RemoteErrorCode, RemoteQualityPreset,
  RemoteInputEvent,
} from '../../../shared/protocol';
import type { ScreenCapture, CaptureOptions } from './capture/capture.types';
import type { InputInjector } from './input/input.types';
import { createAnnexBSplitter, type AccessUnit } from './annexb';
import { createBitrateGovernor } from './bitrate';
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
  readyState: number;
  bufferedAmount: number;
  on(event: 'message', cb: (raw: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
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

function applyInput(input: InputInjector, ev: RemoteInputEvent): void {
  switch (ev.t) {
    case 'd': input.moveRelative(ev.dx, ev.dy); break;
    case 'm': input.moveAbsolute(ev.x, ev.y); break;
    case 'b': input.button(ev.b === 'r' ? 'right' : ev.b === 'm' ? 'middle' : 'left', ev.d); break;
    case 's': input.scroll(ev.dx, ev.dy); break;
    case 'k': input.key(ev.c, ev.d, ev.mods); break;
    case 'x': input.text(ev.s); break;
    default: break;
  }
}

export function handleRemoteConnection(ws: RemoteWs, deps: RemoteDeps): void {
  let capture: ScreenCapture | null = null;
  let input: InputInjector | null = null;
  let splitter: ReturnType<typeof createAnnexBSplitter> | null = null;
  let governor: ReturnType<typeof createBitrateGovernor> | null = null;
  let startedAt = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let framesSent = 0;
  let bytesSent = 0;
  let dropped = 0;

  const reply = (msg: RemoteServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const fail = (code: RemoteErrorCode, message: string) => reply({
    type: 'remote:error', payload: { code, message },
  });

  async function stop(reason: string, tell = true) {
    const c = capture, i = input;
    capture = null; input = null;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    splitter = null;
    governor = null;
    if (c) await c.stop().catch(() => {});
    if (i) await i.stop().catch(() => {});
    if (tell && (c || i)) reply({ type: 'remote:stopped', payload: { reason } });
  }

  async function start(opts: CaptureOptions) {
    if (!deps.isEnabled()) {
      fail('disabled', 'Fernzugriff ist auf diesem Server abgeschaltet.');
      return;
    }
    // A stray second `remote:start` replaces the running session — stop the
    // previous capture first so it never keeps running orphaned.
    await stop('neustart', false);

    // Everything that can throw — including building the capture and wiring its
    // error callback — stays inside the try. The placeholder factory (and any
    // real platform backend that fails to initialize) throws synchronously here;
    // without the try around it the client got neither `remote:started` nor
    // `remote:error` and the connection just hung silently.
    try {
      const c = deps.makeCapture();
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
        fail(code, message);
        enqueue(async () => { if (capture === c) await stop('fehler', false); });
      });
      const info = await c.start(opts);
      capture = c;
      const injector = deps.makeInput();
      input = injector;

      splitter = createAnnexBSplitter();
      governor = createBitrateGovernor(opts.bitrateKbps);
      startedAt = Date.now();
      framesSent = 0; bytesSent = 0; dropped = 0;

      const emit = (units: AccessUnit[]) => {
        for (const au of units) {
          if (!governor || ws.readyState !== 1) return;
          const decision = governor.decide(au, ws.bufferedAmount, Date.now());
          if (decision.bitrateKbps !== null) capture?.setBitrate(decision.bitrateKbps);
          if (!decision.send) { dropped++; continue; }
          const frame = packAccessUnit(au, Date.now() - startedAt);
          // Already compressed — a second pass would only cost CPU time.
          ws.send(frame, { compress: false });
          framesSent++;
          bytesSent += frame.length;
        }
      };

      c.onData((chunk) => { if (splitter) emit(splitter.push(chunk, Date.now())); });

      // A frame only ends at the next start code; without this idle flush every
      // frame hangs until the one after it (33 ms of extra latency at 30 fps).
      idleTimer = setInterval(() => { if (splitter) emit(splitter.tick(Date.now())); }, 4);
      idleTimer.unref();

      statusTimer = setInterval(() => {
        reply({
          type: 'remote:status',
          payload: {
            fps: framesSent,
            kbps: Math.round((bytesSent * 8) / 1000),
            rttMs: 0,
            dropped,
          },
        });
        framesSent = 0; bytesSent = 0; dropped = 0;
      }, 1000);
      statusTimer.unref();

      // Wait for the input backend to actually confirm it is reading before
      // telling the client the session is live. Without this, the app's
      // first burst of pointer/keyboard events can arrive while the platform
      // helper is still starting up (process launch, permission check,
      // before its own read loop runs) and vanish silently — measured on
      // macOS as roughly the first 100ms of motion getting lost. `ready` is
      // optional: not every backend has this startup race (see
      // input.win32.ts). This await must stay inside the surrounding try —
      // a rejected `ready` has to reach the client as `remote:error`, not
      // hang the connection silently (already a Critical once in this file,
      // for a synchronously-throwing capture factory).
      await injector.ready;

      reply({
        type: 'remote:started',
        payload: { ...info, fps: opts.fps, codec: 'avc1' },
      });
      logger.info(`Remote: Sitzung gestartet (${info.width}x${info.height} @${opts.fps})`);
    } catch (e) {
      fail('capture_unavailable', e instanceof Error ? e.message : String(e));
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
        enqueue(() => stop('vom Nutzer beendet'));
        break;
      case 'remote:quality': {
        const preset = QUALITY_PRESETS[clientMsg.payload?.preset];
        if (preset && capture) capture.setBitrate(preset.bitrateKbps);
        break;
      }
      case 'remote:keyframe':
        capture?.requestKeyframe();
        break;
      default:
        break;                                   // silently discard unknown message types
    }
  });

  ws.on('close', () => { enqueue(() => stop('Verbindung getrennt', false)); });

  // A dropped/reset connection fires 'error' on this EventEmitter. Node throws
  // synchronously for an 'error' event with no listener, which lands in the
  // process-wide uncaughtException handler and kills the whole server (see
  // server/src/index.ts) — taking every other terminal session down with it.
  // Treat it exactly like a close: log it, tear the session down, never crash.
  ws.on('error', (err) => {
    logger.error(`Remote: socket error — ${err.message}`);
    enqueue(() => stop('Socket-Fehler', false));
  });
}
