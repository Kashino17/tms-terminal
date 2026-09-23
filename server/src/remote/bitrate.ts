/**
 * Backpressure governor for the remote screen stream.
 *
 * When the network stalls, the socket's send buffer grows. Piling more frames
 * on top would show seconds-old images; instead we drop inter frames, then step
 * the bitrate down, and creep back up once the buffer stays empty.
 *
 * Pure state machine — no socket, no timers — so every branch is testable.
 */
const DROP_ABOVE = 512 * 1024;
const HALVE_ABOVE = 1024 * 1024;
const CALM_BELOW = 128 * 1024;
const CALM_MS = 3000;
const MIN_KBPS = 300;

export interface GovernorDecision { send: boolean; bitrateKbps: number | null }

export interface BitrateGovernor {
  decide(au: { keyframe: boolean }, bufferedBytes: number, nowMs: number): GovernorDecision;
  setTarget(kbps: number): void;
}

export function createBitrateGovernor(targetKbps: number): BitrateGovernor {
  let target = targetKbps;
  let current = targetKbps;
  let calmSince: number | null = null;

  return {
    setTarget(kbps) { target = kbps; },

    decide(au, bufferedBytes, nowMs) {
      let bitrateKbps: number | null = null;

      if (bufferedBytes > HALVE_ABOVE) {
        calmSince = null;
        const next = Math.max(MIN_KBPS, Math.floor(current / 2));
        if (next !== current) { current = next; bitrateKbps = current; }
      } else if (bufferedBytes < CALM_BELOW) {
        if (calmSince === null) calmSince = nowMs;
        else if (nowMs - calmSince >= CALM_MS) {
          calmSince = nowMs;
          const next = Math.min(target, Math.floor(current * 1.25));
          if (next !== current) { current = next; bitrateKbps = current; }
        }
      } else {
        calmSince = null;
      }

      const send = bufferedBytes <= DROP_ABOVE || au.keyframe;
      return { send, bitrateKbps };
    },
  };
}
