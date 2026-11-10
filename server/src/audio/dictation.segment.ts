// Segmentation for streamed dictation: the audio is cut at speech pauses into
// pieces of 8-28s while the user is still talking, so that after the stop only
// a few seconds are left to transcribe. `nextCutLegacy` is the earlier 60s rule
// (mirrors split_audio/_find_pause_split in audio/whisper_sidecar_mlx.py); it
// stays for the A/B measurement in scripts/dictation-e2e.ts.

/** A piece is never cut shorter than this: Whisper needs some context. */
export const MIN_SEGMENT_SECS = 8;
/** ...and never longer: one Whisper window is 30s. */
export const MAX_SEGMENT_SECS = 28;
/** Quiet for at least this long counts as a speech pause. */
export const PAUSE_MIN_SECS = 0.3;
/**
 * A pause this long is taken for the end of a sentence. Pieces are cut there
 * by preference: cutting at any short breath pause tripled the word errors on
 * a 6-minute dictation, cutting at sentence pauses kept them where they were.
 */
export const SENTENCE_PAUSE_SECS = 0.4;
/** Without a sentence pause for this long, a short pause has to do. */
export const SETTLE_SECS = 16;
/** The recording ending in this much quiet is worth transcribing ahead: the stop may be next. */
export const SPEC_PAUSE_SECS = 0.4;
const SPEC_MIN_SPEECH_SECS = 0.5;
const SPEECH_MIN_SECS = 0.2;
// Absolute floor (same as trim_silence in the sidecar) and the share of the
// speaking level below which a 100ms frame counts as quiet. Relative, so quiet
// speakers are not mistaken for silence and a noisy room still has pauses.
const QUIET_FLOOR_RMS = 0.003;
const QUIET_RATIO = 0.12;
const FORCED_SEARCH_SECS = 3;

/** Sample indices, [start, end). */
export interface Pause { start: number; end: number }

export const CHUNK_SECS = 60;
// A rest up to 1.2x the chunk length stays one segment (same as the sidecar).
const MAX_REST_FACTOR = 1.2;
const SEARCH_SECS = 6;
const PAUSE_WINDOW_SECS = 0.1;

/** Index of the lowest-energy 100ms window within ±searchSecs of targetIdx. */
export function findPauseSplit(samples: Float32Array, targetIdx: number, rate: number, searchSecs = SEARCH_SECS): number {
  const n = samples.length;
  const half = Math.floor(rate * searchSecs);
  const lo = Math.max(1, targetIdx - half);
  const hi = Math.min(n - 1, targetIdx + half);
  const frame = Math.max(1, Math.floor(rate * PAUSE_WINDOW_SECS));
  if (hi - lo <= frame * 2) return targetIdx;
  const nFrames = Math.floor((hi - lo) / frame);
  if (nFrames < 2) return targetIdx;
  let best = 0;
  let bestE = Infinity;
  let worstE = -Infinity;
  for (let f = 0; f < nFrames; f++) {
    let e = 0;
    const base = lo + f * frame;
    for (let i = 0; i < frame; i++) { const v = samples[base + i]; e += v * v; }
    e /= frame;
    if (e < bestE) { bestE = e; best = f; }
    if (e > worstE) worstE = e;
  }
  if (worstE - bestE < 1e-12) return targetIdx;
  return lo + best * frame + Math.floor(frame / 2);
}

/** RMS of each complete 100ms frame in [from, to). */
function frameRms(samples: Float32Array, from: number, to: number, frame: number): Float32Array {
  const n = Math.max(0, Math.floor((to - from) / frame));
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    const base = from + f * frame;
    for (let i = 0; i < frame; i++) { const v = samples[base + i]; e += v * v; }
    out[f] = Math.sqrt(e / frame);
  }
  return out;
}

/** RMS below which a frame is quiet, relative to the speaking level of these frames (their 90th percentile). */
function quietBelow(rms: Float32Array): number {
  const level = Float32Array.from(rms).sort()[Math.min(rms.length - 1, Math.floor(rms.length * 0.9))];
  // No speech at all in the range: everything is quiet.
  return level < QUIET_FLOOR_RMS ? Infinity : Math.max(QUIET_FLOOR_RMS, QUIET_RATIO * level);
}

/** Seconds of non-quiet audio in [from, to); "quiet" is judged against the level of [ref, to). */
function speechSecs(samples: Float32Array, from: number, to: number, rate: number, ref: number): number {
  const frame = Math.max(1, Math.floor(rate * PAUSE_WINDOW_SECS));
  const end = Math.min(to, samples.length);
  const all = frameRms(samples, ref, end, frame);
  if (all.length === 0) return 0;
  const threshold = quietBelow(all);
  let loud = 0;
  for (let f = Math.max(0, Math.ceil((from - ref) / frame)); f < all.length; f++) if (all[f] >= threshold) loud++;
  return loud * PAUSE_WINDOW_SECS;
}

/** True if [from, to) holds speech (at least 0.2s that is not quiet, judged against the level since `ref`). */
export function hasSpeech(samples: Float32Array, from: number, to: number, rate: number, ref = from): boolean {
  return speechSecs(samples, from, to, rate, ref) >= SPEECH_MIN_SECS;
}

/**
 * Where the trailing silence starts, if the audio after `cursor` ends in at
 * least `minSecs` of quiet with at least half a second of speech before it;
 * else null. That spot is where the speaker may be about to stop.
 */
export function edgePause(samples: Float32Array, cursor: number, rate: number, minSecs = SPEC_PAUSE_SECS): number | null {
  const pauses = findPauses(samples, cursor, samples.length, rate, minSecs);
  const last = pauses[pauses.length - 1];
  if (!last) return null;
  const frame = Math.max(1, Math.floor(rate * PAUSE_WINDOW_SECS));
  if (last.end + frame <= samples.length) return null;   // speech has resumed after it
  if (speechSecs(samples, cursor, last.start, rate, cursor) < SPEC_MIN_SPEECH_SECS) return null;
  return last.start;
}

/**
 * Speech pauses in [from, to): runs of quiet 100ms frames lasting at least
 * `minSecs`. "Quiet" is relative to the speaking level of that range (its
 * 90th percentile), with an absolute floor.
 */
export function findPauses(samples: Float32Array, from: number, to: number, rate: number, minSecs = PAUSE_MIN_SECS): Pause[] {
  const frame = Math.max(1, Math.floor(rate * PAUSE_WINDOW_SECS));
  const rms = frameRms(samples, from, Math.min(to, samples.length), frame);
  if (rms.length === 0) return [];
  const threshold = quietBelow(rms);
  const minFrames = Math.max(1, Math.round(minSecs / PAUSE_WINDOW_SECS));
  const pauses: Pause[] = [];
  let run = -1;
  for (let f = 0; f <= rms.length; f++) {
    const quiet = f < rms.length && rms[f] < threshold;
    if (quiet && run < 0) run = f;
    if (!quiet && run >= 0) {
      if (f - run >= minFrames) pauses.push({ start: from + run * frame, end: from + f * frame });
      run = -1;
    }
  }
  return pauses;
}

/**
 * End index of the next piece starting at `cursor`, or null when there is
 * nothing to cut yet. A piece ends in the middle of a speech pause that lies
 * 8-28s after the cursor and after which speech has resumed: the last
 * sentence-length pause, or — once 16s are buffered without one — the last
 * short pause. Without any pause it is cut by force before 28s (lowest-energy
 * spot). On `final` a rest of up to 28s is taken whole.
 */
export function nextCut(samples: Float32Array, cursor: number, rate: number, final: boolean): number | null {
  const rest = samples.length - cursor;
  if (rest <= 0) return null;
  const min = Math.floor(rate * MIN_SEGMENT_SECS);
  const max = Math.floor(rate * MAX_SEGMENT_SECS);
  if (final && rest <= max) return samples.length;
  if (!final && rest < min) return null;
  const frame = Math.max(1, Math.floor(rate * PAUSE_WINDOW_SECS));
  const sentence = Math.floor(rate * SENTENCE_PAUSE_SECS);
  let atSentence: number | null = null;
  let atShort: number | null = null;
  for (const p of findPauses(samples, cursor, samples.length, rate)) {
    if (p.end + frame > samples.length) continue;       // still open at the live edge
    const mid = Math.floor((p.start + p.end) / 2);
    if (mid < cursor + min || mid > cursor + max) continue;
    if (p.end - p.start >= sentence) atSentence = mid; else atShort = mid;
  }
  if (atSentence !== null) return atSentence;
  if (atShort !== null && (final || rest > Math.floor(rate * SETTLE_SECS))) return atShort;
  if (rest <= max) return null;
  return findPauseSplit(samples, cursor + Math.floor(rate * (MAX_SEGMENT_SECS - FORCED_SEARCH_SECS)), rate, FORCED_SEARCH_SECS);
}

/**
 * The earlier rule: ~60s pieces. While recording (final=false) a segment is
 * only cut once more than 1.2x CHUNK_SECS are buffered, so the cut always has
 * a full search window of real audio after it.
 */
export function nextCutLegacy(samples: Float32Array, cursor: number, rate: number, final: boolean): number | null {
  const remaining = samples.length - cursor;
  if (remaining <= 0) return null;
  const chunk = Math.floor(rate * CHUNK_SECS);
  if (remaining <= chunk * MAX_REST_FACTOR) return final ? samples.length : null;
  return findPauseSplit(samples, cursor + chunk, rate);
}

/** 16-bit PCM mono RIFF WAV — hits the sidecar's no-ffmpeg fast path. */
export function encodeWav(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);   // byte rate
  buf.writeUInt16LE(2, 32);          // block align
  buf.writeUInt16LE(16, 34);         // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}
