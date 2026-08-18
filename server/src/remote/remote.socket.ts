import type {
  RemoteClientMessage, RemoteServerMessage, RemoteErrorCode, RemoteQualityPreset,
} from '../../../shared/protocol';
import type { ScreenCapture, CaptureOptions } from './capture/capture.types';
import type { InputInjector } from './input/input.types';
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

export function handleRemoteConnection(ws: RemoteWs, deps: RemoteDeps): void {
  let capture: ScreenCapture | null = null;
  let input: InputInjector | null = null;

  const reply = (msg: RemoteServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const fail = (code: RemoteErrorCode, message: string) => reply({
    type: 'remote:error', payload: { code, message },
  });

  async function stop(reason: string, tell = true) {
    const c = capture, i = input;
    capture = null; input = null;
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
      c.onError((code, message) => { fail(code, message); enqueue(() => stop('fehler', false)); });
      const info = await c.start(opts);
      capture = c;
      input = deps.makeInput();
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
    let msg: RemoteClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof (msg as { type?: unknown }).type !== 'string') return;

    switch (msg.type) {
      case 'remote:start':
        enqueue(() => start(msg.payload));
        break;
      case 'remote:stop':
        enqueue(() => stop('vom Nutzer beendet'));
        break;
      case 'remote:quality': {
        const preset = QUALITY_PRESETS[msg.payload?.preset];
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
