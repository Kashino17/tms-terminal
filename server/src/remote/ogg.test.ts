import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createOggReader, buildOpusEncoderArgs } from './ogg';

const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libopus');

// Echte Kette wie unter Windows: rohes Float-PCM rein, ffmpeg mit denselben
// Argumenten, Ogg raus — der Leser muss genau die 20-ms-Opus-Pakete liefern,
// ohne die beiden Kopfpakete, und das auch, wenn der Strom zerstückelt kommt.
test('ffmpeg-Ogg wird in 20-ms-Opus-Pakete zerlegt', { skip: !hasFfmpeg && 'ffmpeg mit libopus fehlt' }, async () => {
  const rate = 44100, seconds = 1;
  const pcm = Buffer.alloc(rate * seconds * 2 * 4);
  for (let i = 0; i < rate * seconds; i++) {
    const v = Math.sin(i * 2 * Math.PI * 440 / rate) * 0.3;
    pcm.writeFloatLE(v, i * 8); pcm.writeFloatLE(v, i * 8 + 4);
  }
  const ff = spawn('ffmpeg', buildOpusEncoderArgs(rate, 2), { stdio: ['pipe', 'pipe', 'inherit'] });
  const reader = createOggReader();
  const packets: Buffer[] = [];
  ff.stdout.on('data', (b: Buffer) => {
    // In kleinen Häppchen füttern: Seitengrenzen fallen mitten in Lesevorgänge.
    for (let o = 0; o < b.length; o += 7) packets.push(...reader.push(b.subarray(o, o + 7)));
  });
  ff.stdin.end(pcm);
  await new Promise((r) => ff.on('exit', r));
  // Die letzten ~80 ms bleiben beim Stromende im Encoder — im Livebetrieb egal.
  assert.ok(packets.length >= 44 && packets.length <= 51, `${packets.length} Pakete für 1 s`);
  assert.ok(packets.every((p) => p.subarray(0, 8).toString('latin1') !== 'OpusHead'), 'Kopfpakete übersprungen');
  assert.ok(packets.some((p) => p.length > 20), 'echte Tondaten, keine Stille');
});

test('Ogg-Leser setzt ein Paket über mehrere 255er-Segmente zusammen', () => {
  const data = Buffer.alloc(300, 7);
  const head = Buffer.alloc(27); head.write('OggS', 0, 'latin1'); head[26] = 2;
  const page = Buffer.concat([head, Buffer.from([255, 45]), data]);
  const r = createOggReader();
  const out = r.push(page);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 300);
});
