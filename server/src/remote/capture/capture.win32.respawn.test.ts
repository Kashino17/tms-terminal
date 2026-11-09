/**
 * Windows-Bitratenwechsel mit echten Prozessen: ein nachgebautes `ffmpeg`
 * (Shell-Skript im PATH) meldet die Desktopgröße und schreibt fortlaufend die
 * Bitrate, mit der es gestartet wurde. Geprüft wird die Übergabe: das alte
 * läuft weiter, bis das neue liefert, danach kommt nur noch das neue durch und
 * das alte ist beendet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bitrateRespawnWait, createWin32Capture, RESPAWN_DOWN_GAP_MS, RESPAWN_UP_GAP_MS } from './capture.win32';

test('Bitratenwechsel nur bei echtem Schritt und mit Abstand', () => {
  assert.equal(bitrateRespawnWait(1500, 1400, 60_000), null, 'kleiner Stups: kein neuer Start');
  assert.equal(bitrateRespawnWait(1500, 1050, 60_000), 0, 'echte Senkung: sofort');
  assert.equal(bitrateRespawnWait(1500, 1050, 1_000), RESPAWN_DOWN_GAP_MS - 1_000, 'gerade erst gestartet: warten');
  assert.equal(bitrateRespawnWait(1000, 1500, 10_000), RESPAWN_UP_GAP_MS - 10_000, 'hoch nur selten');
  assert.equal(bitrateRespawnWait(1000, 1500, RESPAWN_UP_GAP_MS), 0);
});

const sh = process.platform !== 'win32';
test('neue Bitrate: alte Aufnahme läuft, bis die neue liefert, dann nur noch die neue', { skip: !sh && 'nur mit sh' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakeff-'));
  const ff = join(dir, 'ffmpeg');
  writeFileSync(ff, `#!/bin/sh
case "$*" in *-encoders*) echo " V..... h264_nvenc"; exit 0;; esac
kb=""; prev=""
for a in "$@"; do [ "$prev" = "-b:v" ] && kb="$a"; prev="$a"; done
echo "$$" >> "${dir}/pids"
sleep 0.3
echo "Stream #0:0: Video: wrapped_avframe, bgra, 1920x1080, 30 fps" >&2
trap 'exit 0' TERM
while :; do printf "B%s\\n" "$kb"; sleep 0.05; done
`);
  chmodSync(ff, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const cap = createWin32Capture();
  const seen: string[] = [];
  cap.onData((b: Buffer) => { for (const m of b.toString().match(/B\d+k/g) ?? []) seen.push(m); });
  try {
    const info = await cap.start({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 });
    assert.equal(info.width, 1600);
    assert.equal(info.scale, 1600 / 1920);
    assert.equal(cap.keyframeOnDemand, false);
    await new Promise((r) => setTimeout(r, RESPAWN_DOWN_GAP_MS + 200));
    cap.setBitrate(1000);
    await new Promise((r) => setTimeout(r, 1200));
    const cut = seen.indexOf('B1000k');
    assert.ok(cut > 0, 'die neue Bitrate kommt an');
    assert.ok(seen.slice(0, cut).every((m) => m === 'B1500k'), 'bis zur Übergabe die alte');
    assert.ok(seen.slice(cut).every((m) => m === 'B1000k'), 'danach nur noch die neue');
    const pids = execFileSync('cat', [join(dir, 'pids')], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(pids.length, 2);
    let oldAlive = true;
    try { process.kill(Number(pids[0]), 0); } catch { oldAlive = false; }
    assert.equal(oldAlive, false, 'die alte Aufnahme ist beendet');
  } finally {
    await cap.stop();
    process.env.PATH = oldPath;
  }
});

// Windows begrenzt die Bildschirm-Duplikate pro Sitzung: startet die zweite
// Aufnahme nicht, muss die laufende einfach weiterliefern.
test('scheitert die neue Aufnahme, bleibt die alte', { skip: !sh && 'nur mit sh' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakeff-'));
  writeFileSync(join(dir, 'ffmpeg'), `#!/bin/sh
case "$*" in *-encoders*) echo " V..... h264_nvenc"; exit 0;; esac
[ -f "${dir}/started" ] && exit 1
touch "${dir}/started"
echo "Stream #0:0: Video: wrapped_avframe, bgra, 1920x1080, 30 fps" >&2
trap 'exit 0' TERM
while :; do printf "X\\n"; sleep 0.05; done
`);
  chmodSync(join(dir, 'ffmpeg'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const cap = createWin32Capture();
  let n = 0; const errors: string[] = [];
  cap.onData(() => { n++; });
  cap.onError((c) => errors.push(c));
  try {
    await cap.start({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 });
    await new Promise((r) => setTimeout(r, RESPAWN_DOWN_GAP_MS + 200));
    cap.setBitrate(800);
    await new Promise((r) => setTimeout(r, 600));
    const before = n;
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(n > before, 'es kommen weiter Bilder');
    assert.deepEqual(errors, [], 'kein Absturz gemeldet');
  } finally {
    await cap.stop();
    process.env.PATH = oldPath;
  }
});
