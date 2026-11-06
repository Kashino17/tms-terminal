/**
 * Latency-bounded flow control for the remote screen stream.
 *
 * The old governor (bitrate.ts) only looked at ws.bufferedAmount and reacted
 * above 512 KB — at 1.5 Mbit/s that is ~2.7 s of stale picture, and the
 * kernel's TCP send buffer (autotuned up to 4 MB on macOS) sits behind it
 * where bufferedAmount can't see it at all. Over a Tailscale DERP relay the
 * picture could lag seconds behind the pointer.
 *
 * Instead the app acknowledges every frame it receives (`remote:ack` with the
 * frame's timestamp). Queueing delay = age of the oldest unacknowledged frame
 * minus the smallest round trip seen recently. Above QUEUE_BUDGET_MS the
 * frames are dropped rather than queued; once the pipe drains, a keyframe is
 * requested (dropped inter frames leave the decoder without a reference) and
 * inter frames are held back until it arrives.
 *
 * Clients without acks (app v1.110.0) fall back to the old governor, so an
 * older phone never loses its picture.
 *
 * Pure state machine — no socket, no timers — so every branch is testable.
 */
import { createBitrateGovernor } from './bitrate';

/** Queueing allowed on top of the base round trip before frames are dropped. */
export const QUEUE_BUDGET_MS = 120;
/** Data stuck in our own send buffer counts as congestion regardless of acks. */
const BUFFER_LIMIT = 256 * 1024;
/** The base round trip is the minimum over this window, so it can follow a path change. */
const RTT_WINDOW_MS = 10_000;
const KEY_RETRY_MS = 500;
const CUT_EVERY_MS = 1000;
const CALM_MS = 3000;
const MIN_KBPS = 300;

export interface FlowDecision { send: boolean; requestKeyframe: boolean; bitrateKbps: number | null }

export interface FrameFlow {
  decide(au: { keyframe: boolean }, nowMs: number, bufferedBytes: number): FlowDecision;
  onSent(ts: number, nowMs: number): void;
  onAck(ts: number, nowMs: number): void;
  setTarget(kbps: number): void;
}

export function createFrameFlow(targetKbps: number): FrameFlow {
  const legacy = createBitrateGovernor(targetKbps);
  let target = targetKbps;
  let current = targetKbps;
  let acksSeen = false;
  const inflight: { ts: number; sentAt: number }[] = [];
  const rtts: { at: number; rtt: number }[] = [];
  let needKey = false;
  let lastKeyRequest = -Infinity;
  let lastCut = -Infinity;
  let calmSince: number | null = null;

  function baseRtt(now: number): number | null {
    while (rtts.length && rtts[0].at < now - RTT_WINDOW_MS) rtts.shift();
    if (!rtts.length) return null;
    let min = Infinity;
    for (const r of rtts) if (r.rtt < min) min = r.rtt;
    return min;
  }

  return {
    setTarget(kbps) { target = kbps; legacy.setTarget(kbps); },

    onSent(ts, nowMs) { inflight.push({ ts, sentAt: nowMs }); },

    onAck(ts, nowMs) {
      acksSeen = true;
      while (inflight.length && inflight[0].ts <= ts) {
        const f = inflight.shift()!;
        if (f.ts === ts) rtts.push({ at: nowMs, rtt: nowMs - f.sentAt });
      }
    },

    decide(au, nowMs, bufferedBytes) {
      if (!acksSeen) {
        const d = legacy.decide(au, bufferedBytes, nowMs);
        return { send: d.send, requestKeyframe: false, bitrateKbps: d.bitrateKbps };
      }

      const base = baseRtt(nowMs);
      const queueDelay = base !== null && inflight.length ? nowMs - inflight[0].sentAt - base : 0;
      const congested = queueDelay > QUEUE_BUDGET_MS || bufferedBytes > BUFFER_LIMIT;

      if (congested) {
        needKey = true;
        calmSince = null;
        let bitrateKbps: number | null = null;
        if (nowMs - lastCut >= CUT_EVERY_MS) {
          lastCut = nowMs;
          const next = Math.max(MIN_KBPS, Math.floor(current * 0.7));
          if (next !== current) { current = next; bitrateKbps = current; }
        }
        return { send: false, requestKeyframe: false, bitrateKbps };
      }

      if (needKey) {
        if (!au.keyframe) {
          const ask = nowMs - lastKeyRequest >= KEY_RETRY_MS;
          if (ask) lastKeyRequest = nowMs;
          return { send: false, requestKeyframe: ask, bitrateKbps: null };
        }
        needKey = false;
        lastKeyRequest = -Infinity;
      }

      let bitrateKbps: number | null = null;
      if (calmSince === null) calmSince = nowMs;
      else if (nowMs - calmSince >= CALM_MS) {
        calmSince = nowMs;
        const next = Math.min(target, Math.floor(current * 1.15));
        if (next !== current) { current = next; bitrateKbps = current; }
      }
      return { send: true, requestKeyframe: false, bitrateKbps };
    },
  };
}
