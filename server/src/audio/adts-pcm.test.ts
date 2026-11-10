import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { decodeToFloat32, findFfmpeg } from './ffmpeg-decode';
import { AdtsPcm, adtsFrames } from './adts-pcm';

const ffmpeg = findFfmpeg();
const decode = (b: Buffer) => decodeToFloat32(b, 'adts');

// 20s of a tone with a slowly changing level, as AAC-ADTS (what the app streams).
function adtsFixture(rate = 16000): Buffer {
  return execFileSync(ffmpeg!, [
    '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', "sine=frequency=440:duration=20,volume='0.2+0.8*abs(sin(t))':eval=frame",
    '-ac', '1', '-ar', String(rate), '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', 'pipe:1',
  ]);
}
// 6000 bytes are about half a second and cut in the middle of a frame.
async function feed(pcm: AdtsPcm, f: Buffer): Promise<Float32Array> {
  let last: Float32Array = new Float32Array(0);
  for (let off = 0; off < f.length; off += 6000) { pcm.push(f.subarray(off, off + 6000)); last = await pcm.samples(); }
  return last;
}

test('adtsFrames returns only complete frames', { skip: !ffmpeg }, () => {
  const f = adtsFixture();
  const { starts, end } = adtsFrames(f.subarray(0, 5000), 0);
  assert.ok(starts.length > 5 && end <= 5000 && end > 4000, `${starts.length} frames, end ${end}`);
  assert.strictEqual(adtsFrames(f, 0).end, f.length);
});

test('adtsFrames reports a broken stream', () => {
  assert.strictEqual(adtsFrames(Buffer.alloc(64, 7), 0).broken, true);
});

test('incremental decode equals one full decode', { skip: !ffmpeg }, async () => {
  const f = adtsFixture();
  const full = await decode(f);
  const pcm = new AdtsPcm(decode);
  const last = await feed(pcm, f);
  assert.strictEqual(pcm.mode, 'incremental');
  assert.strictEqual(last.length, full.length);
  let worst = 0;
  for (let i = 0; i < full.length; i++) worst = Math.max(worst, Math.abs(full[i] - last[i]));
  assert.ok(worst < 1e-3, `max diff ${worst}`);
});

test('each frame is decoded once (plus the overlap)', { skip: !ffmpeg }, async () => {
  const f = adtsFixture();
  let decodedBytes = 0;
  const pcm = new AdtsPcm((b) => { decodedBytes += b.length; return decode(b); });
  await feed(pcm, f);
  assert.ok(decodedBytes < f.length * 1.5, `${decodedBytes} of ${f.length}`);
});

test('raw bytes that are already decoded are dropped', { skip: !ffmpeg }, async () => {
  const f = adtsFixture();
  const pcm = new AdtsPcm(decode);
  await feed(pcm, f);
  assert.ok(pcm.bytes < 8000, `${pcm.bytes} bytes still held`);
});

// Another phone may record at another rate: the per-frame arithmetic is off then.
test('a different sample rate falls back to full decoding with the same result', { skip: !ffmpeg }, async () => {
  const f = adtsFixture(44100);
  const full = await decode(f);
  const pcm = new AdtsPcm(decode);
  const last = await feed(pcm, f);
  assert.strictEqual(pcm.mode, 'full');
  assert.strictEqual(last.length, full.length);
});

test('a stream that turns to garbage keeps what was already decoded', { skip: !ffmpeg }, async () => {
  const f = adtsFixture();
  const pcm = new AdtsPcm(decode);
  const before = (await feed(pcm, f.subarray(0, 60000))).length;
  pcm.push(Buffer.alloc(3000, 7));
  const after = (await pcm.samples()).length;
  assert.strictEqual(pcm.mode, 'full');
  assert.ok(after >= before, `${after} < ${before}`);
});

test('samples() without new frames does not decode', async () => {
  let n = 0;
  const pcm = new AdtsPcm(async () => { n++; return new Float32Array(0); });
  await pcm.samples();
  assert.strictEqual(n, 0);
});

test('release drops the raw bytes', () => {
  const pcm = new AdtsPcm(async () => new Float32Array(0));
  pcm.push(Buffer.alloc(100));
  pcm.release();
  assert.strictEqual(pcm.bytes, 0);
});
