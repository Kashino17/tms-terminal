import { test } from 'node:test';
import assert from 'node:assert';
import { findPauseSplit, nextCut, encodeWav, CHUNK_SECS } from './dictation.segment';

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

test('nextCut waits while less than 1.2x chunk is buffered (not final)', () => {
  assert.strictEqual(nextCut(speech(70), 0, RATE, false), null);
});

test('nextCut cuts a ~60s segment once more than 72s are buffered', () => {
  const s = speech(75, [[59, 59.3]]);
  const cut = nextCut(s, 0, RATE, false);
  assert.ok(cut !== null && cut >= 59 * RATE && cut <= 59.3 * RATE, `cut ${cut}`);
});

test('nextCut respects the cursor', () => {
  const s = speech(150, [[121, 121.3]]);
  const cut = nextCut(s, 60 * RATE, RATE, false);
  assert.ok(cut !== null && cut >= 121 * RATE && cut <= 121.3 * RATE, `cut ${cut}`);
});

test('nextCut on final takes the whole rest when it is at most 72s', () => {
  const s = speech(130);
  assert.strictEqual(nextCut(s, 60 * RATE, RATE, true), s.length);
});

test('nextCut on final still splits a rest longer than 72s', () => {
  const s = speech(100);
  const cut = nextCut(s, 0, RATE, true);
  assert.ok(cut !== null && cut < s.length && cut > (CHUNK_SECS - 6) * RATE);
});

test('nextCut on final with nothing left returns null', () => {
  const s = speech(10);
  assert.strictEqual(nextCut(s, s.length, RATE, true), null);
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
