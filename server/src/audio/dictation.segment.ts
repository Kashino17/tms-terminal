// Segmentation for streamed dictation. Mirrors split_audio/_find_pause_split in
// audio/whisper_sidecar_mlx.py so streamed audio is cut at exactly the same
// kind of boundary as a whole-file upload (no accuracy change), just earlier.

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

/**
 * End index of the next complete segment starting at `cursor`, or null when
 * there is nothing to cut yet. While recording (final=false) a segment is only
 * cut once more than 1.2x CHUNK_SECS are buffered, so the cut always has a
 * full search window of real audio after it.
 */
export function nextCut(samples: Float32Array, cursor: number, rate: number, final: boolean): number | null {
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
