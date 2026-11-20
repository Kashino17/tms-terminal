import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { voiceAvailable, voicePaths, encodeMp3 } from './engine';
import { findFfmpeg } from '../audio/ffmpeg-decode';

function fixture(): { home: string; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-voice-'));
  const home = path.join(base, 'home'), root = path.join(base, 'server');
  for (const f of ['.tms-terminal/voice_24k_15s.wav', '.tms-terminal/voice_24k_15s.txt', '.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-1.7B-Base-8bit/x']) {
    fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), 'x');
  }
  for (const f of ['audio/voice_sidecar.py', 'audio/.venv-tts/bin/python3']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x');
  }
  return { home, root };
}

test('voiceAvailable: nur wenn ALLES schon da ist — nichts wird heimlich nachgeladen', () => {
  const { home, root } = fixture();
  const p = voicePaths(home, root, {});
  assert.equal(voiceAvailable(p, 'darwin', '/usr/bin/ffmpeg'), true);
  assert.equal(voiceAvailable(p, 'win32', '/usr/bin/ffmpeg'), false, 'die Stimme läuft auf dem Mac');
  assert.equal(voiceAvailable(p, 'darwin', null), false, 'ohne ffmpeg kein Weg zum Handy');
  for (const missing of [p.ref, p.refText, p.python, p.script]) {
    const keep = fs.readFileSync(missing);
    fs.rmSync(missing);
    assert.equal(voiceAvailable(p, 'darwin', '/usr/bin/ffmpeg'), false, path.basename(missing) + ' fehlt');
    fs.writeFileSync(missing, keep);
  }
  fs.rmSync(p.modelDir, { recursive: true });
  assert.equal(voiceAvailable(p, 'darwin', '/usr/bin/ffmpeg'), false, 'Modell nicht im Cache');
});

test('voicePaths: der Modell-Cache folgt HF_HOME / HF_HUB_CACHE', () => {
  assert.match(voicePaths('/h', '/r', { HF_HOME: '/x/hf' }).modelDir, /^\/x\/hf\/hub\/models--mlx-community--Qwen3/);
  assert.match(voicePaths('/h', '/r', { HF_HUB_CACHE: '/y/hub' }).modelDir, /^\/y\/hub\/models--mlx-community--Qwen3/);
});

test('encodeMp3: aus rohem Ton wird ein kleines MP3', { skip: findFfmpeg() ? false : 'kein ffmpeg' }, async () => {
  const rate = 24000, secs = 2;
  const pcm = Buffer.alloc(rate * secs * 2);
  for (let i = 0; i < rate * secs; i++) pcm.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 12000), i * 2);
  const mp3 = await encodeMp3(pcm, rate);
  assert.ok(mp3.length > 2000 && mp3.length < pcm.length / 4, `MP3 ${mp3.length} B aus ${pcm.length} B`);
  assert.ok(mp3[0] === 0xff || mp3.subarray(0, 3).toString() === 'ID3', 'beginnt wie ein MP3');
});
