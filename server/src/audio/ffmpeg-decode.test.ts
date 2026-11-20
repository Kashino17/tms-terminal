import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { decodeToFloat32, findFfmpeg } from './ffmpeg-decode';

const ffmpeg = findFfmpeg();

// 10s of a 440 Hz tone as AAC-ADTS, the format the app streams while recording.
function adtsFixture(): Buffer {
  return execFileSync(ffmpeg!, [
    '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', 'pipe:1',
  ]);
}

test('decodes a complete ADTS stream to 16 kHz float32', { skip: !ffmpeg }, async () => {
  const samples = await decodeToFloat32(adtsFixture(), 'adts');
  assert.ok(Math.abs(samples.length / 16000 - 10) < 0.2, `${samples.length / 16000}s`);
});

// The file is read while it is still being written: the last frame is cut.
test('a truncated ADTS stream still decodes, and its prefix matches the full decode', { skip: !ffmpeg }, async () => {
  const full = adtsFixture();
  const part = full.subarray(0, Math.floor(full.length * 0.6) + 7);
  const a = await decodeToFloat32(part, 'adts');
  const b = await decodeToFloat32(full, 'adts');
  assert.ok(a.length > 16000 * 5);
  assert.deepStrictEqual(Array.from(a.subarray(0, a.length - 2048)), Array.from(b.subarray(0, a.length - 2048)));
});

test('garbage input rejects', { skip: !ffmpeg }, async () => {
  await assert.rejects(decodeToFloat32(Buffer.from('not audio at all'), 'adts'));
});
