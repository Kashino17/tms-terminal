import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickEncoder, buildFfmpegArgs, parseCaptureSize, computeOutputSize, ENCODER_PREFERENCE,
} from './capture.win32';
import { splitLines } from '../lines';

test('die Grafikkarte wird der Rechenleistung vorgezogen', () => {
  assert.equal(pickEncoder(['libx264', 'h264_qsv', 'h264_nvenc']), 'h264_nvenc');
  assert.equal(pickEncoder(['libx264', 'h264_amf']), 'h264_amf');
  assert.equal(pickEncoder(['libx264']), 'libx264', 'zur Not rechnet der Prozessor');
  assert.equal(pickEncoder(['h264_videotoolbox']), null, 'nichts Brauchbares vorhanden');
});

test('die Reihenfolge steht fest und endet beim Prozessor', () => {
  assert.deepEqual([...ENCODER_PREFERENCE],
    ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
});

test('buildFfmpegArgs nimmt den Desktop und liefert rohes H.264', () => {
  const args = buildFfmpegArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }, 'h264_nvenc');
  const joined = args.join(' ');

  assert.ok(joined.includes('ddagrab=output_idx=0:framerate=30'), 'Desktop-Duplication mit Bildrate');
  assert.ok(joined.includes("scale=w='min(iw,1600)':h=-2"),
    'nur verkleinern (min gegen die Eingabebreite), nie vergroessern — Hoehe bleibt gerade');
  assert.ok(joined.includes('-c:v h264_nvenc'));
  assert.ok(joined.includes('-b:v 1500k'));
  assert.ok(joined.includes('-g 60'), 'alle zwei Sekunden ein Vollbild');
  assert.ok(joined.includes('-slices 1'), 'ein Slice pro Bild — sonst greift der Zerteiler daneben');
  assert.ok(joined.includes('-bsf:v dump_extra'), 'SPS/PPS vor jedem Vollbild wiederholen');
  assert.ok(joined.endsWith('-f h264 pipe:1'));
});

test('libx264 bekommt seine eigene Einstellung fuer niedrige Verzoegerung', () => {
  const joined = buildFfmpegArgs({ maxWidth: 1280, fps: 24, bitrateKbps: 800 }, 'libx264').join(' ');
  assert.ok(joined.includes('-tune zerolatency'));
  assert.ok(!joined.includes('-preset p1'), 'p1 ist eine nvenc-Stufe und wuerde libx264 abbrechen lassen');
});

test('nvenc bekommt seine eigenen Low-Latency-Argumente, keine fremden', () => {
  const joined = buildFfmpegArgs({ maxWidth: 1280, fps: 30, bitrateKbps: 1000 }, 'h264_nvenc').join(' ');
  assert.ok(joined.includes('-preset p1'));
  assert.ok(joined.includes('-tune ll'));
  assert.ok(!joined.includes('-async_depth'), 'async_depth ist ein qsv-Merkmal');
  assert.ok(!joined.includes('-usage'), 'usage ist ein amf-Merkmal');
});

test('qsv bekommt eigene Argumente statt der nvenc-Stufen — sonst bricht ffmpeg ab', () => {
  const joined = buildFfmpegArgs({ maxWidth: 1280, fps: 30, bitrateKbps: 1000 }, 'h264_qsv').join(' ');
  assert.ok(joined.includes('-preset veryfast'));
  assert.ok(joined.includes('-async_depth 1'));
  assert.ok(!joined.includes('-preset p1'), 'p1 ist eine nvenc-Stufe, qsv kennt sie nicht');
  assert.ok(!joined.includes('-tune'), 'qsv kennt kein -tune');
});

test('amf bekommt eigene Argumente statt der nvenc-Stufen — sonst bricht ffmpeg ab', () => {
  const joined = buildFfmpegArgs({ maxWidth: 1280, fps: 30, bitrateKbps: 1000 }, 'h264_amf').join(' ');
  assert.ok(joined.includes('-usage ultralowlatency'));
  assert.ok(joined.includes('-quality speed'));
  assert.ok(!joined.includes('-preset p1'), 'p1 ist eine nvenc-Stufe, amf kennt sie nicht');
  assert.ok(!joined.includes('-tune'), 'amf kennt kein -tune');
});

test('parseCaptureSize liest die Masse aus der ffmpeg-Ausgabe', () => {
  const line = 'Stream #0:0: Video: wrapped_avframe, bgra, 2560x1440, 30 fps, 30 tbr';
  assert.deepEqual(parseCaptureSize(line), { width: 2560, height: 1440 });
  assert.equal(parseCaptureSize('irgendwas ohne Masse'), null);
});

test('eine mitten durchgerissene Groessenzeile kommt trotzdem an — sonst haengt start() fuer immer', () => {
  const line = 'Stream #0:0: Video: wrapped_avframe, bgra, 2560x1440, 30 fps, 30 tbr';
  const cut = Math.floor(line.length / 2);

  const first = splitLines('', line.slice(0, cut));
  assert.deepEqual(first.lines, [], 'noch keine vollstaendige Zeile');
  assert.equal(first.rest, line.slice(0, cut));

  const second = splitLines(first.rest, line.slice(cut) + '\n');
  assert.equal(second.lines.length, 1);
  assert.deepEqual(parseCaptureSize(second.lines[0]), { width: 2560, height: 1440 });
});

// C4: die gemeldeten Masse muessen zum tatsaechlich ausgegebenen Bild passen —
// vorher wurde die VOLLE Desktop-Hoehe gemeldet, waehrend die Breite auf die
// Stufe gekappt wurde (verzerrtes Bild, falsches Rechteck, danebenzielende
// Klicks). Diese Tests pruefen die GEMELDETEN Masse, nicht nur die Argumente.
test('computeOutputSize verkleinert die Hoehe passend zur gekappten Breite', () => {
  assert.deepEqual(
    computeOutputSize({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }, { width: 2560, height: 1440 }),
    { width: 1600, height: 900 },
    '1600/2560 * 1440 = 900, bereits gerade',
  );
});

test('computeOutputSize rundet eine ungerade Zielhoehe auf die naechste gerade ab', () => {
  // 1600/1919 * 1080 = 900.469... -> abgerundet 900, dann auf gerade gerundet.
  const out = computeOutputSize({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }, { width: 1919, height: 1080 });
  assert.equal(out.width, 1600);
  assert.equal(out.height % 2, 0, 'die Hoehe muss gerade bleiben, wie -2 im Filter es verlangt');
  assert.equal(out.height, 900);
});

test('computeOutputSize vergroessert nie — ein kleinerer Desktop als die Stufe bleibt unveraendert', () => {
  // Die "scharf"-Stufe verlangt 1920px Breite; ein 1280px-Desktop darf nicht
  // hochskaliert werden — genau der Fehler, den der alte Filter (ohne
  // min()) gemacht haette, waehrend die Breitenrechnung das Gegenteil annahm.
  assert.deepEqual(
    computeOutputSize({ maxWidth: 1920, fps: 30, bitrateKbps: 3000 }, { width: 1280, height: 800 }),
    { width: 1280, height: 800 },
  );
});

test('computeOutputSize laesst ein bereits kleineres Bild bei exakter Breite unveraendert', () => {
  assert.deepEqual(
    computeOutputSize({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }, { width: 1600, height: 1000 }),
    { width: 1600, height: 1000 },
  );
});
