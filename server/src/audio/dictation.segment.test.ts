import { test } from 'node:test';
import assert from 'node:assert';
import { findPauseSplit, findPauses, nextCut, nextCutLegacy, edgePause, hasSpeech, speechAbove, quietFrom, encodeWav, CHUNK_SECS } from './dictation.segment';

const RATE = 16000;

// Deterministic "speech": loud pseudo-noise, with optional silent gaps.
function speech(secs: number, gaps: Array<[number, number]> = []): Float32Array {
  const out = new Float32Array(Math.round(secs * RATE));
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5;
  }
  for (const [a, b] of gaps) out.fill(0, Math.round(a * RATE), Math.round(b * RATE));
  return out;
}

// Cutting mid-word costs accuracy — the cut must land in the speech pause.
test('findPauseSplit lands in the silent gap near the target', () => {
  const s = speech(80, [[61, 61.4]]);
  const cut = findPauseSplit(s, 60 * RATE, RATE);
  assert.ok(cut >= 61 * RATE && cut <= 61.4 * RATE, `cut at ${cut / RATE}s`);
});

test('nextCutLegacy waits while less than 1.2x chunk is buffered (not final)', () => {
  assert.strictEqual(nextCutLegacy(speech(70), 0, RATE, false), null);
});

test('nextCutLegacy cuts a ~60s segment once more than 72s are buffered', () => {
  const s = speech(75, [[59, 59.3]]);
  const cut = nextCutLegacy(s, 0, RATE, false);
  assert.ok(cut !== null && cut >= 59 * RATE && cut <= 59.3 * RATE, `cut ${cut}`);
});

test('nextCutLegacy respects the cursor', () => {
  const s = speech(150, [[121, 121.3]]);
  const cut = nextCutLegacy(s, 60 * RATE, RATE, false);
  assert.ok(cut !== null && cut >= 121 * RATE && cut <= 121.3 * RATE, `cut ${cut}`);
});

test('nextCutLegacy on final takes the whole rest when it is at most 72s', () => {
  const s = speech(130);
  assert.strictEqual(nextCutLegacy(s, 60 * RATE, RATE, true), s.length);
});

test('nextCutLegacy on final still splits a rest longer than 72s', () => {
  const s = speech(100);
  const cut = nextCutLegacy(s, 0, RATE, true);
  assert.ok(cut !== null && cut < s.length && cut > (CHUNK_SECS - 6) * RATE);
});

test('nextCutLegacy on final with nothing left returns null', () => {
  const s = speech(10);
  assert.strictEqual(nextCutLegacy(s, s.length, RATE, true), null);
});

// ── Pause-based cutting (8-28s pieces) ─────────────────────────────────
const tone = (secs: number, level: number) => new Float32Array(Math.round(secs * RATE)).fill(level);
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test('findPauses finds a 0.5s gap and ignores a 0.2s gap', () => {
  const s = concat(tone(3, 0.3), tone(0.2, 0), tone(3, 0.3), tone(0.5, 0), tone(3, 0.3));
  const p = findPauses(s, 0, s.length, RATE);
  assert.strictEqual(p.length, 1);
  assert.ok(Math.abs(p[0].start / RATE - 6.2) < 0.15 && Math.abs(p[0].end / RATE - 6.7) < 0.15, JSON.stringify(p));
});

// Quiet speakers must not be mistaken for silence — the cut would land mid-word.
test('findPauses works for quiet speech (level 0.01)', () => {
  const s = concat(tone(3, 0.01), tone(0.5, 0), tone(3, 0.01));
  assert.strictEqual(findPauses(s, 0, s.length, RATE).length, 1);
});

test('findPauses treats a low noise floor between words as a pause', () => {
  const s = concat(tone(3, 0.3), tone(0.5, 0.004), tone(3, 0.3));
  assert.strictEqual(findPauses(s, 0, s.length, RATE).length, 1);
});

test('nextCut waits while less than 8s are buffered', () => {
  assert.strictEqual(nextCut(concat(tone(5, 0.3), tone(0.5, 0), tone(1, 0.3)), 0, RATE, false), null);
});

test('nextCut cuts in the middle of the last closed pause between 8s and 28s', () => {
  const s = concat(tone(9, 0.3), tone(0.5, 0), tone(5, 0.3), tone(0.5, 0), tone(2, 0.3));
  const cut = nextCut(s, 0, RATE, false);
  assert.ok(cut !== null && Math.abs(cut / RATE - 14.75) < 0.15, `cut ${cut}`);
});

// Measured (scripts/dictation-e2e.ts, 6 min): cutting at any short breath pause
// tripled the word errors; cutting at sentence pauses kept them as before.
test('nextCut prefers a sentence-length pause over a later short one', () => {
  const s = concat(tone(9, 0.3), tone(0.5, 0), tone(3, 0.3), tone(0.3, 0), tone(2, 0.3));
  const cut = nextCut(s, 0, RATE, false);
  assert.ok(cut !== null && Math.abs(cut / RATE - 9.25) < 0.15, `cut ${cut}`);
});

test('nextCut waits for a sentence pause while fewer than 16s are buffered', () => {
  const s = concat(tone(9, 0.3), tone(0.3, 0), tone(3, 0.3));
  assert.strictEqual(nextCut(s, 0, RATE, false), null);
});

test('nextCut settles for the last short pause after 16s without a sentence pause', () => {
  const s = concat(tone(9, 0.3), tone(0.3, 0), tone(4, 0.3), tone(0.3, 0), tone(4, 0.3));
  const cut = nextCut(s, 0, RATE, false);
  assert.ok(cut !== null && Math.abs(cut / RATE - 13.45) < 0.15, `cut ${cut}`);
});

test('nextCut ignores a pause at the live edge', () => {
  assert.strictEqual(nextCut(concat(tone(10, 0.3), tone(0.6, 0)), 0, RATE, false), null);
});

// Steady background noise never yields a pause — the rest after stop must stay small anyway.
test('nextCut forces a cut by 28s when there is no pause (steady noise)', () => {
  const cut = nextCut(tone(40, 0.3), 0, RATE, false);
  assert.ok(cut !== null && cut / RATE > 20 && cut / RATE <= 28, `cut ${cut}`);
});

test('nextCut respects the cursor', () => {
  const s = concat(tone(20, 0.3), tone(0.5, 0), tone(9, 0.3), tone(0.5, 0), tone(2, 0.3));
  const first = nextCut(s, 0, RATE, false)!;
  const second = nextCut(s, first, RATE, false);
  assert.ok(second !== null && second > first, `first ${first} second ${second}`);
});

test('nextCut on final takes the whole rest up to 28s', () => {
  const s = tone(20, 0.3);
  assert.strictEqual(nextCut(s, 0, RATE, true), s.length);
});

test('nextCut on final still splits a rest longer than 28s', () => {
  const cut = nextCut(tone(40, 0.3), 0, RATE, true);
  assert.ok(cut !== null && cut < 40 * RATE && cut / RATE <= 28, `cut ${cut}`);
});

test('nextCut on final with nothing left returns null', () => {
  const s = tone(5, 0.3);
  assert.strictEqual(nextCut(s, s.length, RATE, true), null);
});

// ── Looking ahead: the buffer ends in a pause ──────────────────────────
test('edgePause finds trailing silence after speech', () => {
  const s = concat(tone(3, 0.3), tone(0.5, 0));
  const at = edgePause(s, 0, RATE);
  assert.ok(at !== null && Math.abs(at / RATE - 3) < 0.15, `at ${at}`);
});

test('edgePause is null while speech is still running', () => {
  assert.strictEqual(edgePause(concat(tone(3, 0.3), tone(0.2, 0)), 0, RATE), null);
});

test('edgePause is null for silence only', () => {
  assert.strictEqual(edgePause(tone(3, 0), 0, RATE), null);
});

test('edgePause needs at least half a second of speech before the pause', () => {
  assert.strictEqual(edgePause(concat(tone(0.2, 0.3), tone(0.6, 0)), 0, RATE), null);
});

test('edgePause looks only at audio after the cursor', () => {
  const s = concat(tone(5, 0.3), tone(0.6, 0));
  assert.strictEqual(edgePause(s, 5 * RATE, RATE), null);
});

test('hasSpeech tells speech from silence', () => {
  const s = concat(tone(2, 0.3), tone(2, 0), tone(1, 0.3));
  assert.strictEqual(hasSpeech(s, 2 * RATE, 4 * RATE, RATE, 0.003), false);
  assert.strictEqual(hasSpeech(s, 2 * RATE, s.length, RATE, 0.003), true);
});

test('hasSpeech ignores a single loud 100ms frame', () => {
  const s = concat(tone(1, 0), tone(0.1, 0.3), tone(1, 0));
  assert.strictEqual(hasSpeech(s, 0, s.length, RATE, 0.003), false);
});

// What counts as speech after a pause is fixed by the noise heard IN that pause —
// not by how loud the speaker was before, and not by how long the silence lasts.
test('speechAbove is the floor in a silent room and rises with the room noise', () => {
  assert.strictEqual(speechAbove(tone(1, 0), 0, RATE, RATE), 0.003);
  const noisy = speechAbove(tone(1, 0.005), 0, RATE, RATE);
  assert.ok(noisy > 0.005 && noisy < 0.03, `above ${noisy}`);
});

// Measured: with 100ms frames a 0.45s sentence pause counted as 0.3s or 0.4s
// depending on where the frames happened to start — and the cut rule flipped.
test('a 0.45s pause measures at least 0.4s whatever the frame alignment', () => {
  for (let off = 0; off < 0.1; off += 0.01) {
    const s = concat(tone(1 + off, 0.3), tone(0.45, 0), tone(1, 0.3));
    const p = findPauses(s, 0, s.length, RATE);
    assert.strictEqual(p.length, 1, `offset ${off}`);
    assert.ok(p[0].end - p[0].start >= 0.4 * RATE, `offset ${off.toFixed(2)}: ${(p[0].end - p[0].start) / RATE}s`);
  }
});

test('quietFrom skips the fading end of a word', () => {
  const s = concat(tone(1, 0.3), tone(0.2, 0.01), tone(0.6, 0));
  const at = quietFrom(s, RATE, s.length, RATE, 0.003);
  assert.ok(at !== null && Math.abs(at / RATE - 1.2) < 0.05, `at ${at}`);
  assert.strictEqual(quietFrom(tone(1, 0.01), 0, RATE, RATE, 0.003), null);
});

// A tap or a breath is not speech. It must not turn the pause before it into
// a place to cut — but inside running speech nothing may be smoothed away:
// treating short loud bursts as quiet made "pauses" out of syllables (measured:
// 18 word errors of 114 instead of 1).
test('a short noise after a pause does not make that pause a place to cut', () => {
  const s = concat(tone(10, 0.3), tone(0.6, 0), tone(0.1, 0.3), tone(0.3, 0));
  assert.strictEqual(nextCut(s, 0, RATE, false), null);
});

test('findPauses leaves short syllables between short gaps alone', () => {
  const syllables: Float32Array[] = [];
  for (let i = 0; i < 20; i++) syllables.push(tone(0.12, 0.3), tone(0.1, 0));
  const s = concat(tone(2, 0.3), ...syllables, tone(2, 0.3));
  assert.deepStrictEqual(findPauses(s, 0, s.length, RATE), []);
});

test('edgePause does not take a short word for a noise', () => {
  const s = concat(tone(3, 0.3), tone(0.6, 0), tone(0.2, 0.3), tone(0.3, 0));
  assert.strictEqual(edgePause(s, 0, RATE), null);                  // 0.2s of sound is speech; only 0.3s quiet after it
});

test('edgePause sees through a single loud frame in the trailing silence', () => {
  const s = concat(tone(3, 0.3), tone(0.6, 0), tone(0.1, 0.3), tone(0.3, 0));
  const at = edgePause(s, 0, RATE);
  assert.ok(at !== null && Math.abs(at / RATE - 3) < 0.15, `at ${at}`);
});

test('encodeWav writes a 16-bit mono RIFF file', () => {
  const wav = encodeWav(new Float32Array([1, -1, 0, 0.5]), RATE);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.length, 44 + 2 * 4);
  assert.strictEqual(wav.readUInt32LE(24), RATE);
  assert.strictEqual(wav.readUInt16LE(22), 1);
  assert.strictEqual(wav.readInt16LE(44), 32767);
  assert.strictEqual(wav.readInt16LE(46), -32767);
  assert.strictEqual(wav.readInt16LE(48), 0);
});
