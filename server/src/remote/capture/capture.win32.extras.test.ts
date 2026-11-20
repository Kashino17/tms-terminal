/**
 * Windows: Ton und Vorhang mit echten Prozessen. Ein nachgebautes
 * `powershell.exe` spielt die Helfer (Vorhang meldet sich, Ton liefert 1 s
 * echtes PCM), das Bild-ffmpeg ist nachgebaut, die Opus-Kodierung macht das
 * ECHTE ffmpeg mit denselben Argumenten wie unter Windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWin32Capture, virtualDisplaySize } from './capture.win32';

const realFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
const hasOpus = !!realFfmpeg && spawnSync(realFfmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout.includes('libopus');

function fakeBin(curtainOk: boolean, displayOk = true) {
  const dir = mkdtempSync(join(tmpdir(), 'fakewin-'));
  writeFileSync(join(dir, 'ffmpeg'), `#!/bin/sh
case "$*" in *libopus*) exec "${realFfmpeg}" "$@";; esac
case "$*" in *-encoders*) echo " V..... h264_nvenc"; exit 0;; esac
[ -f "${dir}/display-on" ] && touch "${dir}/video-saw-display"
if [ -f "${dir}/video-fail-once" ]; then rm -f "${dir}/video-fail-once"; echo "Failed to enumerate DXGI output 0" >&2; exit 1; fi
echo "Stream #0:0: Video: wrapped_avframe, bgra, 1920x1080, 30 fps" >&2
trap 'exit 0' TERM
while :; do printf "V"; sleep 0.05; done
`);
  writeFileSync(join(dir, 'powershell.exe'), `#!/bin/sh
case "$*" in
  *display-helper*)
    echo "$*" > "${dir}/display-args"
    ${displayOk ? `touch "${dir}/display-on"; echo '{"ready":{"display":true,"width":1600,"height":1000,"sized":true,"name":"x"}}'`
                : `echo '{"error":{"code":"capture_unavailable","message":"nein"}}'; exit 0`}
    cat > /dev/null; rm -f "${dir}/display-on"; touch "${dir}/display-ended"; exit 0;;
  *curtain-helper*)
    touch "${dir}/curtain-started"
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

test('virtuelle Bildschirmgröße passt zur Qualitätsstufe, nie breiter als der Strom', () => {
  assert.deepEqual(virtualDisplaySize(1920), { width: 1920, height: 1200 });
  assert.deepEqual(virtualDisplaySize(1600), { width: 1600, height: 1000 });
  assert.deepEqual(virtualDisplaySize(1280), { width: 1280, height: 800 });
  assert.deepEqual(virtualDisplaySize(1000), { width: 1280, height: 800 });
});

for (const displayOk of [true, false]) {
  test(displayOk ? 'Windows: Bildschirm aus über den virtuellen Bildschirm — vor dem Bild, am Ende zurück'
                 : 'Windows: klappt der virtuelle Bildschirm nicht, übernimmt der schwarze Vorhang',
    { skip: process.platform === 'win32' && 'nur mit sh' }, async () => {
    const dir = fakeBin(true, displayOk);
    const pf = mkdtempSync(join(tmpdir(), 'fakepf-'));
    mkdirSync(join(pf, 'TMS Terminal'));
    writeFileSync(join(pf, 'TMS Terminal', 'display-installed.txt'), '25.7.23');
    const oldPath = process.env.PATH, oldPf = process.env.ProgramFiles;
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.ProgramFiles = pf;
    const cap = createWin32Capture();
    try {
      const info = await cap.start({ maxWidth: 1600, fps: 30, bitrateKbps: 1500, curtain: true });
      assert.equal(info.curtain, true);
      assert.match(readFileSync(join(dir, 'display-args'), 'utf8'), /-Width 1600 -Height 1000/);
      if (displayOk) {
        assert.ok(existsSync(join(dir, 'video-saw-display')), 'ffmpeg startet erst, wenn der virtuelle Bildschirm aktiv ist');
        assert.ok(!existsSync(join(dir, 'curtain-started')), 'kein Vorhang nötig');
      } else {
        assert.ok(existsSync(join(dir, 'curtain-started')), 'Vorhang als Rückfall');
      }
      await cap.stop();
      await new Promise((r) => setTimeout(r, 400));
      // Im Fehlerfall hat der echte Helfer schon VOR seiner Meldung zurückgestellt.
      if (displayOk) assert.ok(existsSync(join(dir, 'display-ended')), 'Anzeige-Helfer endet über stdin (stellt die Bildschirme zurück)');
    } finally {
      await cap.stop();
      process.env.PATH = oldPath;
      if (oldPf === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = oldPf;
    }
  });
}

test('Windows: scheitert das Bild direkt nach dem Umschalten einmal, klappt der zweite Versuch', { skip: process.platform === 'win32' && 'nur mit sh' }, async () => {
  const dir = fakeBin(true, true);
  writeFileSync(join(dir, 'video-fail-once'), '');
  const pf = mkdtempSync(join(tmpdir(), 'fakepf-'));
  mkdirSync(join(pf, 'TMS Terminal'));
  writeFileSync(join(pf, 'TMS Terminal', 'display-installed.txt'), '25.7.23');
  const oldPath = process.env.PATH, oldPf = process.env.ProgramFiles;
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.ProgramFiles = pf;
  const cap = createWin32Capture();
  try {
    const info = await cap.start({ maxWidth: 1920, fps: 30, bitrateKbps: 3000, curtain: true });
    assert.equal(info.curtain, true);
    assert.ok(!existsSync(join(dir, 'video-fail-once')), 'der erste Versuch ist wirklich gescheitert');
    assert.ok(existsSync(join(dir, 'video-saw-display')));
  } finally {
    await cap.stop();
    process.env.PATH = oldPath;
    if (oldPf === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = oldPf;
  }
});
