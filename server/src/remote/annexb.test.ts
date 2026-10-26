import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnexBSplitter } from './annexb';

/** Baut eine NAL mit 4-Byte-Startcode: 00 00 00 01 <header> <payload…> */
function nal(type: number, payloadLen = 4): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0x60 | type]),
    Buffer.alloc(payloadLen, 0xaa),
  ]);
}

const SPS = () => nal(7);
const PPS = () => nal(8);
const IDR = () => nal(5);
const SLICE = () => nal(1);

test('ein Vollbild wird nach der VCL-NAL abgeschlossen', () => {
  const s = createAnnexBSplitter();
  assert.deepEqual(s.push(Buffer.concat([SPS(), PPS(), IDR()]), 0), []);
  const units = s.push(SLICE(), 40);
  assert.equal(units.length, 1, 'die erste Access Unit wird beim nächsten Startcode fertig');
  assert.equal(units[0].keyframe, true, 'SPS/PPS/IDR ist ein Vollbild');
});

test('Zwischenbilder sind keine Vollbilder', () => {
  const s = createAnnexBSplitter();
  s.push(Buffer.concat([SPS(), PPS(), IDR()]), 0);
  s.push(SLICE(), 40);
  const units = s.push(SLICE(), 80);
  assert.equal(units.length, 1);
  assert.equal(units[0].keyframe, false);
});

test('Leerlauf schliesst die offene Access Unit ab', () => {
  const s = createAnnexBSplitter(6);
  assert.deepEqual(s.push(Buffer.concat([SPS(), PPS(), IDR()]), 100), []);
  assert.deepEqual(s.tick(104), [], 'vor Ablauf der Leerlaufzeit passiert nichts');
  const units = s.tick(107);
  assert.equal(units.length, 1, 'nach 6 ms ohne neue Bytes gilt das Bild als fertig');
  assert.equal(units[0].keyframe, true);
});

test('an beliebiger Stelle zerschnittene Eingaben ergeben dasselbe', () => {
  const whole = Buffer.concat([SPS(), PPS(), IDR(), SLICE(), SLICE()]);
  const ganz = createAnnexBSplitter();
  const erwartet = ganz.push(whole, 0).concat(ganz.tick(999));

  const stueckweise = createAnnexBSplitter();
  const got: ReturnType<typeof ganz.push> = [];
  for (let i = 0; i < whole.length; i += 3) {
    got.push(...stueckweise.push(whole.subarray(i, i + 3), i));
  }
  got.push(...stueckweise.tick(9999));

  assert.equal(got.length, erwartet.length);
  got.forEach((au, i) => {
    assert.equal(au.keyframe, erwartet[i].keyframe, `Vollbild-Kennzeichen bei ${i}`);
    assert.deepEqual(au.data, erwartet[i].data, `Nutzdaten bei ${i}`);
  });
});

test('3-Byte- und 4-Byte-Startcodes werden beide erkannt', () => {
  const s = createAnnexBSplitter();
  const dreiByte = Buffer.concat([Buffer.from([0, 0, 1, 0x65]), Buffer.alloc(4, 0xaa)]);
  s.push(Buffer.concat([SPS(), PPS()]), 0);
  s.push(dreiByte, 1);
  const units = s.tick(99);
  assert.equal(units.length, 1);
  assert.equal(units[0].keyframe, true);
});

test('Access-Unit-Nutzdaten sind byte-genau SPS+PPS+IDR inklusive der 4-Byte-Startcodes', () => {
  const s = createAnnexBSplitter(6);
  assert.deepEqual(s.push(Buffer.concat([SPS(), PPS(), IDR()]), 0), []);
  const units = s.tick(6);
  assert.equal(units.length, 1, 'nach der Leerlaufzeit wird die Access Unit abgeschlossen');
  assert.equal(units[0].keyframe, true);
  assert.deepEqual(units[0].data, Buffer.concat([SPS(), PPS(), IDR()]),
                    'die Nutzdaten muessen byte-genau dem Ganz-Weg entsprechen, inklusive fuehrendem Null-Byte der ersten NAL');
});
