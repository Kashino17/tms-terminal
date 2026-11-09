import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { buildHelperArgs, parseHelperLine, helperBinaryPath, splitLines, splitAudioPackets } from './capture.darwin';

test('buildHelperArgs uebersetzt die Stufe in Helfer-Argumente', () => {
  assert.deepEqual(
    buildHelperArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }),
    ['--capture', '--max-width', '1600', '--fps', '30', '--bitrate', '1500'],
  );
});

test('parseHelperLine liest die Bildschirmmasse', () => {
  const got = parseHelperLine('{"ready":{"width":3024,"height":1964,"scale":2}}');
  assert.deepEqual(got, { kind: 'ready', info: { width: 3024, height: 1964, scale: 2 } });
});

test('parseHelperLine erkennt die fehlende Bildschirmaufnahme-Freigabe', () => {
  const got = parseHelperLine('{"error":{"code":"permission_screen","message":"nicht erlaubt"}}');
  assert.equal(got?.kind, 'error');
  if (got?.kind === 'error') {
    assert.equal(got.code, 'permission_screen');
  }
});

test('parseHelperLine verschluckt sich nicht an Zwischenausgaben', () => {
  assert.equal(parseHelperLine(''), null);
  assert.equal(parseHelperLine('irgendein Geschwaetz vom Linker'), null);
  assert.equal(parseHelperLine('{"encodeMs":12}'), null, 'Messwerte sind kein Ereignis');
});

test('unbekannte Fehlercodes werden nicht durchgereicht', () => {
  const got = parseHelperLine('{"error":{"code":"quatsch","message":"x"}}');
  assert.equal(got?.kind, 'error');
  if (got?.kind === 'error') {
    assert.equal(got.code, 'capture_unavailable', 'faellt auf einen bekannten Code zurueck');
  }
});

test('splitLines behaelt eine mitten im JSON zerschnittene Zeile bis zum naechsten Lesevorgang', () => {
  const line = '{"ready":{"width":3024,"height":1964,"scale":2}}';
  const cut = Math.floor(line.length / 2);

  const first = splitLines('', line.slice(0, cut));
  assert.deepEqual(first.lines, [], 'noch keine vollstaendige Zeile');
  assert.equal(first.rest, line.slice(0, cut));

  const second = splitLines(first.rest, line.slice(cut) + '\n');
  assert.equal(second.lines.length, 1);
  assert.deepEqual(parseHelperLine(second.lines[0]), {
    kind: 'ready',
    info: { width: 3024, height: 1964, scale: 2 },
  });
});

test('der uebersetzte Helfer liegt dort, wo der Server ihn sucht', { skip: process.platform !== 'darwin' }, () => {
  assert.ok(fs.existsSync(helperBinaryPath()),
    `Helfer fehlt unter ${helperBinaryPath()} — "npm run build:helper" ausfuehren`);
});

test('localCursor wird zum Helfer-Schalter --local-cursor', () => {
  assert.deepEqual(
    buildHelperArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500, localCursor: true }).slice(-1),
    ['--local-cursor'],
  );
  assert.ok(!buildHelperArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }).includes('--local-cursor'));
});

test('parseHelperLine liest Zeigerpositionen, verwirft kaputte', () => {
  assert.deepEqual(parseHelperLine('{"cursor":{"x":0.49207,"y":0.15572}}'), { kind: 'cursor', x: 0.49207, y: 0.15572 });
  assert.equal(parseHelperLine('{"cursor":{"x":"a","y":1}}'), null);
});

test('Ton und Vorhang werden als Helfer-Schalter weitergegeben', () => {
  const args = buildHelperArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500, audio: true, curtain: true });
  assert.ok(args.includes('--audio') && args.includes('--curtain'));
  assert.ok(!buildHelperArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }).includes('--audio'));
});

test('ready meldet, ob Ton und Vorhang wirklich laufen', () => {
  const r = parseHelperLine('{"ready":{"width":1280,"height":826,"scale":0.74,"audio":true,"curtain":false}}');
  assert.ok(r && r.kind === 'ready');
  if (r && r.kind === 'ready') { assert.equal(r.info.audio, true); assert.equal(r.info.curtain, false); }
});

// fd 3: Opus-Pakete mit 2-Byte-Länge davor — auch quer über mehrere Lesehäppchen.
test('Ton-Pakete werden über Lesegrenzen hinweg zusammengesetzt', () => {
  const stream = Buffer.from([0, 3, 1, 2, 3, 0, 2, 4, 5, 0, 1]);
  const a = splitAudioPackets(Buffer.alloc(0), stream.subarray(0, 4));
  assert.equal(a.packets.length, 0);
  const b = splitAudioPackets(a.rest, stream.subarray(4));
  assert.deepEqual(b.packets.map((p) => [...p]), [[1, 2, 3], [4, 5]]);
  assert.deepEqual([...b.rest], [0, 1], 'angefangenes drittes Paket bleibt liegen');
});
