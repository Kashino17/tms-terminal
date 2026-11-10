// Streamed dictation sessions.
//
// The app uploads the growing recording in byte-offset chunks WHILE the user
// speaks; this manager decodes what has arrived, cuts pieces of 8-28s at speech
// pauses and transcribes them in the background. After the stop only the last
// few seconds are left, so the result arrives right away regardless of length.
// (Without an incremental decoder — whole-file uploads — the earlier rule
// applies: ~60s pieces, the rest after the stop.)
//
// Sessions live independently of any socket: every call rebinds the sink, so a
// reconnect (`resume`) picks up a dictation that is still uploading or still
// being transcribed, and a finished result is kept for a while to be fetched.

import { nextCut, nextCutLegacy, edgePause, hasSpeech, findPauses, encodeWav, MIN_SEGMENT_SECS } from './dictation.segment';
import type { PcmStream } from './adts-pcm';
import type { DictationStat } from './dictation.stats';

export type DictationFormat = 'adts' | 'file';
export type DictationStatus = 'receiving' | 'processing' | 'done' | 'error';

export interface DictationDeps {
  /** Decode the bytes received so far to 16 kHz mono float32. */
  decode(bytes: Buffer, format: DictationFormat): Promise<Float32Array>;
  transcribeWav(wavBase64: string): Promise<string>;
  rewrite(text: string): Promise<string>;
  /** Incremental decoder for a streamed ('adts') recording. Without it the whole upload is decoded on each pass. */
  openPcm?: () => PcmStream;
  /** Called once for every dictation that produced a result. */
  onDone?: (stat: DictationStat) => void;
  now(): number;
  log(msg: string): void;
}

export type DictationEvent =
  | { type: 'dictation:ack'; id: string; bytes: number }
  | { type: 'dictation:state'; id: string; status: DictationStatus | 'unknown'; bytes: number; text?: string; message?: string }
  | { type: 'dictation:progress'; id: string }
  | { type: 'dictation:result'; id: string; text: string }
  | { type: 'dictation:error'; id: string; message: string };

export type Sink = (ev: DictationEvent) => void;

export interface DictationOptions {
  decodeThrottleMs?: number;
  heartbeatMs?: number;
  doneTtlMs?: number;
  idleTtlMs?: number;
  /** Where streamed recordings are cut (default: the pause rule). The A/B script injects the earlier rule. */
  cut?: typeof nextCut;
}

const RATE = 16000;
// Same as nextCut's threshold (1.2 x 60s): below this nothing can be cut.
const SEGMENT_READY_SECS = 72;
// Smaller than a couple of AAC frames: decoding may legitimately fail.
const TINY_RECORDING_BYTES = 4096;
// A piece transcribed ahead takes this much of the trailing quiet along, so the last word is not clipped.
const AHEAD_PAD_SECS = 0.15;

interface Session {
  id: string;
  format: DictationFormat;
  enhance: boolean;
  sink: Sink;
  parts: Buffer[];
  pcm: PcmStream | null;      // streamed recordings: decoded incrementally, `parts` stays empty
  received: number;
  status: DictationStatus;
  endTotal: number | null;
  cursor: number;             // samples already handed to Whisper
  texts: string[];
  work: Promise<void>;        // serialized decode/transcribe passes
  passQueued: boolean;
  lastPassAt: number;
  throttleTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  cancelled: boolean;
  lastActivity: number;
  startedAt: number;
  endedAt: number;
  finishedAt: number;
  text: string;
  error: string;
  computeMs: number;
  audioSecs: number;
  bytesPerSec: number;        // measured on the last decode; 0 = unknown
  restSecs: number;           // audio left to transcribe when the stop arrived
  restMeasured: boolean;
  /** A piece transcribed ahead at a trailing pause: samples [from, to) and their text. */
  spec: { from: number; to: number; text: string } | null;
  specHit: boolean;           // the whole result was ready before the stop
}

/** Use the rewrite unless it lost more than half of the words (truncation/hallucination guard). */
export function acceptRewrite(original: string, rewritten: string): string {
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const rw = (rewritten ?? '').trim();
  if (!rw) return original;
  return words(rw) < words(original) * 0.5 ? original : rw;
}

export class DictationManager {
  private sessions = new Map<string, Session>();
  private readonly throttleMs: number;
  private readonly heartbeatMs: number;
  private readonly doneTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly cut: typeof nextCut;

  constructor(private deps: DictationDeps, opts: DictationOptions = {}) {
    this.throttleMs = opts.decodeThrottleMs ?? 500;
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.doneTtlMs = opts.doneTtlMs ?? 15 * 60_000;
    this.idleTtlMs = opts.idleTtlMs ?? 10 * 60_000;
    this.cut = opts.cut ?? nextCut;
  }

  start(id: string, format: DictationFormat, enhance: boolean, sink: Sink): void {
    let s = this.sessions.get(id);
    if (!s) {
      const now = this.deps.now();
      s = {
        id, format, enhance, sink, parts: [], pcm: format === 'adts' && this.deps.openPcm ? this.deps.openPcm() : null,
        received: 0, status: 'receiving', endTotal: null,
        cursor: 0, texts: [], work: Promise.resolve(), passQueued: false, lastPassAt: 0,
        throttleTimer: null, heartbeat: null, cancelled: false, lastActivity: now, startedAt: now,
        endedAt: 0, finishedAt: 0, text: '', error: '', computeMs: 0, audioSecs: 0, bytesPerSec: 0, restSecs: 0, restMeasured: false, spec: null, specHit: false,
      };
      this.sessions.set(id, s);
      this.deps.log(`[dictation] ${id}: start (${format}${enhance ? ', enhance' : ''})`);
    }
    s.sink = sink;
    sink({ type: 'dictation:ack', id, bytes: s.received });
  }

  chunk(id: string, offset: number, data: Buffer, sink: Sink): void {
    const s = this.sessions.get(id);
    if (!s) { sink({ type: 'dictation:state', id, status: 'unknown', bytes: 0 }); return; }
    s.sink = sink;
    s.lastActivity = this.deps.now();
    if (s.status === 'receiving' && offset <= s.received && offset + data.length > s.received) {
      const tail = data.subarray(s.received - offset);
      if (s.pcm) s.pcm.push(tail); else s.parts.push(tail);
      s.received += tail.length;
    }
    sink({ type: 'dictation:ack', id, bytes: s.received });
    if (s.status !== 'receiving') return;
    // A gap on a live socket means a chunk was dropped on the way (e.g. by the
    // rate limiter). The client only re-positions on `state` — tell it.
    if (offset > s.received) { this.sendState(s); return; }
    if (s.endTotal !== null) this.maybeFinalize(s);
    else if (s.format === 'adts') this.schedulePass(s);
  }

  end(id: string, totalBytes: number, sink: Sink): void {
    const s = this.sessions.get(id);
    if (!s) { sink({ type: 'dictation:state', id, status: 'unknown', bytes: 0 }); return; }
    s.sink = sink;
    s.lastActivity = this.deps.now();
    if (s.status !== 'receiving') { this.sendState(s); return; }
    s.endTotal = totalBytes;
    s.endedAt = this.deps.now();
    if (s.received < totalBytes) this.sendState(s); // client resends from here
    this.maybeFinalize(s);
  }

  cancel(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.cancelled = true;
    s.pcm?.release();
    this.clearTimers(s);
    this.sessions.delete(id);
    this.deps.log(`[dictation] ${id}: cancelled`);
  }

  resume(id: string, sink: Sink): void {
    const s = this.sessions.get(id);
    if (!s) { sink({ type: 'dictation:state', id, status: 'unknown', bytes: 0 }); return; }
    s.sink = sink;
    s.lastActivity = this.deps.now();
    this.sendState(s);
  }

  sweep(): void {
    const now = this.deps.now();
    for (const [id, s] of this.sessions) {
      const finished = s.status === 'done' || s.status === 'error';
      if (finished && now - s.finishedAt > this.doneTtlMs) this.sessions.delete(id);
      else if (s.status === 'receiving' && now - s.lastActivity > this.idleTtlMs) {
        this.deps.log(`[dictation] ${id}: abandoned after ${Math.round((now - s.lastActivity) / 1000)}s idle (${s.received} bytes)`);
        this.cancel(id);
      }
    }
  }

  /** Audio bytes still held in memory for a session (tests / diagnostics). */
  bufferedBytes(id: string): number {
    const s = this.sessions.get(id);
    return s ? s.parts.reduce((n, p) => n + p.length, 0) + (s.pcm?.bytes ?? 0) : 0;
  }

  /** Resolves once all queued work for the session has run (tests, E2E). */
  async idle(id: string): Promise<void> {
    for (;;) {
      const s = this.sessions.get(id);
      if (!s) return;
      const w = s.work;
      await w;
      await new Promise((r) => setImmediate(r));
      if (s.work === w && !s.throttleTimer) return;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private sendState(s: Session): void {
    const ev: DictationEvent = { type: 'dictation:state', id: s.id, status: s.status, bytes: s.received };
    if (s.status === 'done') ev.text = s.text;
    if (s.status === 'error') ev.message = s.error;
    s.sink(ev);
  }

  private emit(s: Session, ev: DictationEvent): void {
    if (!s.cancelled) s.sink(ev);
  }

  private clearTimers(s: Session): void {
    if (s.throttleTimer) { clearTimeout(s.throttleTimer); s.throttleTimer = null; }
    if (s.heartbeat) { clearInterval(s.heartbeat); s.heartbeat = null; }
  }

  private schedulePass(s: Session): void {
    if (s.passQueued || s.throttleTimer) return;
    const wait = s.lastPassAt + this.throttleMs - this.deps.now();
    if (wait > 0 && this.throttleMs > 0) {
      s.throttleTimer = setTimeout(() => { s.throttleTimer = null; this.schedulePass(s); }, wait);
      return;
    }
    s.passQueued = true;
    s.work = s.work.then(async () => {
      s.passQueued = false;
      s.lastPassAt = this.deps.now();
      if (s.cancelled || s.status !== 'receiving') return;
      // Without an incremental decoder every pass decodes the whole upload:
      // skip it while no segment can be cut yet (buffered audio estimated from
      // the byte rate measured on the last decode).
      if (!s.pcm && s.bytesPerSec > 0 && s.received / s.bytesPerSec - s.cursor / RATE <= SEGMENT_READY_SECS) return;
      try {
        const samples = await this.transcribeReady(s, false);
        if (samples && s.pcm && !s.cancelled && s.status === 'receiving') await this.transcribeAhead(s, samples);
      } catch (err) {
        // A mid-stream hiccup is retried by the next pass / the final pass.
        this.deps.log(`[dictation] ${s.id}: stream pass failed (will retry): ${(err as Error).message}`);
      }
    });
  }

  /** Transcribes every piece that can be cut now; returns the decoded samples (null if there is nothing). */
  private async transcribeReady(s: Session, final: boolean): Promise<Float32Array | null> {
    if (s.received === 0) return null; // nothing recorded
    let samples: Float32Array;
    try {
      samples = s.pcm ? await s.pcm.samples() : await this.deps.decode(Buffer.concat(s.parts), s.format);
    } catch (err) {
      // A tap too short to hold one audio frame is "nothing said", not an error.
      if (final && s.received < TINY_RECORDING_BYTES) return null;
      throw err;
    }
    s.audioSecs = samples.length / RATE;
    if (s.audioSecs > 0) s.bytesPerSec = s.received / s.audioSecs;
    if (s.spec) this.settleAhead(s, samples, final);
    if (final && !s.restMeasured) { s.restMeasured = true; s.restSecs = Math.max(0, samples.length - s.cursor) / RATE; }
    // Pause rule for streamed recordings; whole-file uploads keep the 60s pieces.
    const cutAt = s.pcm ? this.cut : nextCutLegacy;
    for (;;) {
      if (s.cancelled) return samples;
      const cut = cutAt(samples, s.cursor, RATE, final);
      if (cut === null) return samples;
      const seg = samples.subarray(s.cursor, cut);
      const t0 = Date.now();
      const text = await this.deps.transcribeWav(encodeWav(seg, RATE).toString('base64'));
      const ms = Date.now() - t0;
      s.computeMs += ms;
      this.deps.log(`[dictation] ${s.id}: segment ${s.texts.length + 1} ${(seg.length / RATE).toFixed(1)}s audio -> ${ms}ms${final ? ' (after stop)' : ''}`);
      s.texts.push(text.trim());
      s.cursor = cut;
    }
  }

  /**
   * The recording ends in a pause: transcribe what was said since the last cut
   * now. If the stop comes next, the text is already there.
   */
  private async transcribeAhead(s: Session, samples: Float32Array): Promise<void> {
    const from = s.cursor;
    const to = edgePause(samples, from, RATE);
    if (to === null) return;
    if (s.spec && s.spec.from === from && s.spec.to === to) return;
    const seg = samples.subarray(from, Math.min(samples.length, to + Math.floor(RATE * AHEAD_PAD_SECS)));
    const t0 = Date.now();
    let text: string;
    try {
      text = await this.deps.transcribeWav(encodeWav(seg, RATE).toString('base64'));
    } catch (err) {
      // Not needed yet: the normal pass after the stop transcribes it (with its retry).
      this.deps.log(`[dictation] ${s.id}: ahead failed (ignored): ${(err as Error).message}`);
      return;
    }
    const ms = Date.now() - t0;
    s.computeMs += ms;
    if (s.cancelled) return;
    s.spec = { from, to, text: text.trim() };
    this.deps.log(`[dictation] ${s.id}: ahead ${((to - from) / RATE).toFixed(1)}s audio -> ${ms}ms`);
  }

  /** Decide what the piece transcribed ahead is worth now that more audio (or the stop) has arrived. */
  private settleAhead(s: Session, samples: Float32Array, final: boolean): void {
    const spec = s.spec!;
    if (spec.from !== s.cursor) { s.spec = null; return; }
    if (!hasSpeech(samples, spec.to, samples.length, RATE, s.cursor)) {
      if (!final) return;                               // still quiet: keep waiting
      s.texts.push(spec.text);
      s.cursor = samples.length;
      s.specHit = true;
      s.spec = null;
      return;
    }
    // The speaker went on. A piece long enough to stand alone is kept and the
    // cut placed in the pause after it; a short one is transcribed again
    // together with what follows (more context, and no text twice).
    if (spec.to - spec.from >= MIN_SEGMENT_SECS * RATE) {
      const pause = findPauses(samples, spec.from, samples.length, RATE).find((p) => p.end > spec.to && p.start <= spec.to + RATE * 0.2);
      s.texts.push(spec.text);
      s.cursor = pause ? Math.floor((Math.max(pause.start, spec.to) + pause.end) / 2) : spec.to;
    }
    s.spec = null;
  }

  private maybeFinalize(s: Session): void {
    if (s.status !== 'receiving' || s.endTotal === null || s.received < s.endTotal) return;
    s.status = 'processing';
    if (s.throttleTimer) { clearTimeout(s.throttleTimer); s.throttleTimer = null; }
    s.heartbeat = setInterval(() => this.emit(s, { type: 'dictation:progress', id: s.id }), this.heartbeatMs);
    s.heartbeat.unref?.();
    s.work = s.work.then(async () => {
      try {
        try {
          await this.transcribeReady(s, true);
        } catch (err) {
          // The Whisper sidecar restarts itself after a crash/stall — one
          // retry of the remaining segments usually goes through.
          this.deps.log(`[dictation] ${s.id}: final pass failed, retrying once: ${(err as Error).message}`);
          await this.transcribeReady(s, true);
        }
        let text = s.texts.filter(Boolean).join(' ');
        if (s.enhance && text.trim() && !s.cancelled) {
          try {
            text = acceptRewrite(text, await this.deps.rewrite(text));
          } catch (err) {
            this.deps.log(`[dictation] ${s.id}: rewrite failed, using raw text: ${(err as Error).message}`);
          }
        }
        s.text = text;
        s.status = 'done';
        this.deps.log(`[dictation] ${s.id}: done — ${s.audioSecs.toFixed(1)}s audio, ${this.deps.now() - s.endedAt}ms stop->result, rest ${s.restSecs.toFixed(1)}s${s.specHit ? ' (ready ahead)' : ''}, compute ${s.computeMs}ms, ${text.length} chars`);
        this.emit(s, { type: 'dictation:result', id: s.id, text });
        if (!s.cancelled) this.deps.onDone?.({ at: s.endedAt, audioSecs: s.audioSecs, waitMs: this.deps.now() - s.endedAt, restSecs: s.restSecs, specHit: s.specHit });
      } catch (err) {
        s.error = (err as Error).message || 'Transkription fehlgeschlagen';
        s.status = 'error';
        this.deps.log(`[dictation] ${s.id}: FAILED after ${this.deps.now() - s.endedAt}ms: ${s.error}`);
        this.emit(s, { type: 'dictation:error', id: s.id, message: s.error });
      } finally {
        s.finishedAt = this.deps.now();
        s.parts = []; // keep only the result for `resume`, not the audio
        s.pcm?.release();
        this.clearTimers(s);
      }
    });
  }
}
