/**
 * Windows: Ton und Vorhang mit echten Prozessen. Ein nachgebautes
 * `powershell.exe` spielt die Helfer (Vorhang meldet sich, Ton liefert 1 s
 * echtes PCM), das Bild-ffmpeg ist nachgebaut, die Opus-Kodierung macht das
 * ECHTE ffmpeg mit denselben Argumenten wie unter Windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWin32Capture } from './capture.win32';

const realFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
const hasOpus = !!realFfmpeg && spawnSync(realFfmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout.includes('libopus');

function fakeBin(curtainOk: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'fakewin-'));
  writeFileSync(join(dir, 'ffmpeg'), `#!/bin/sh
case "$*" in *libopus*) exec "${realFfmpeg}" "$@";; esac
case "$*" in *-encoders*) echo " V..... h264_nvenc"; exit 0;; esac
echo "Stream #0:0: Video: wrapped_avframe, bgra, 1920x1080, 30 fps" >&2
trap 'exit 0' TERM
while :; do printf "V"; sleep 0.05; done
`);
  writeFileSync(join(dir, 'powershell.exe'), `#!/bin/sh
case "$*" in
  *curtain-helper*)
    ${curtainOk ? `echo '{"ready":{"curtain":true}}'` : `echo '{"error":{"code":"capture_unavailable","message":"alt"}}'; exit 0`}
    cat > /dev/null; touch "${dir}/curtain-ended"; exit 0;;
  *audio-helper*)
    echo '{"ready":{"audio":true,"rate":48000}}' >&2
    "${realFfmpeg}" -loglevel error -f lavfi -i sine=f=440:sample_rate=48000 -ac 2 -t 1 -f f32le pipe:1
    cat > /dev/null; touch "${dir}/audio-ended"; exit 0;;
esac
exit 1
`);
  chmodSync(join(dir, 'ffmpeg'), 0o755);
  chmodSync(join(dir, 'powershell.exe'), 0o755);
  return dir;
}

for (const curtainOk of [true, false]) {
  test(curtainOk ? 'Windows: Ton kommt als Opus-Pakete, Vorhang läuft, beide enden sauber'
                 : 'Windows: scheitert der Vorhang, meldet die Sitzung das ehrlich',
    { skip: (process.platform === 'win32' || !hasOpus) && 'braucht sh + ffmpeg mit libopus' }, async () => {
    const dir = fakeBin(curtainOk);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    const cap = createWin32Capture();
    const packets: Buffer[] = [];
    cap.onAudio!((p) => packets.push(p));
    try {
      const info = await cap.start({ maxWidth: 1600, fps: 30, bitrateKbps: 1500, audio: true, curtain: true });
      assert.equal(info.audio, true);
      assert.equal(info.curtain, curtainOk);
      await new Promise((r) => setTimeout(r, 1500));
      // Gemessen ~110 ms Encoder-Verzug: fast alles ist nach 1,5 s da (ohne
      // -analyzeduration 0 kam im Livebetrieb GAR NICHTS — 5 s Prüfphase).
      assert.ok(packets.length >= 40 && packets.length <= 51, `${packets.length} Pakete für 1 s Ton`);
      await cap.stop();
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(existsSync(join(dir, 'audio-ended')), 'Ton-Helfer endet über stdin (stellt Stummschaltung zurück)');
      if (curtainOk) assert.ok(existsSync(join(dir, 'curtain-ended')), 'Vorhang endet über stdin (stellt Helligkeit zurück)');
    } finally {
      await cap.stop();
      process.env.PATH = oldPath;
    }
  });
}

test('ohne Wunsch keine Helfer und keine Angaben', { skip: process.platform === 'win32' && 'nur mit sh' }, async () => {
  const dir = fakeBin(true);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const cap = createWin32Capture();
  try {
    const info = await cap.start({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 });
    assert.equal('audio' in info, false);
    assert.equal('curtain' in info, false);
  } finally { await cap.stop(); process.env.PATH = oldPath; }
  void readFileSync;
});
