import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitrateGovernor } from './bitrate';

const KB = 1024;
const zwischenbild = { keyframe: false };
const vollbild = { keyframe: true };

test('bei leerem Puffer geht alles durch und nichts wird geregelt', () => {
  const g = createBitrateGovernor(1500);
  assert.deepEqual(g.decide(zwischenbild, 10 * KB, 0), { send: true, bitrateKbps: null });
});

test('ueber 512 KB kommen nur noch Vollbilder durch', () => {
  const g = createBitrateGovernor(1500);
  assert.equal(g.decide(zwischenbild, 600 * KB, 0).send, false, 'Zwischenbild faellt weg');
  assert.equal(g.decide(vollbild, 600 * KB, 0).send, true, 'Vollbild kommt durch');
});

test('ueber 1 MB wird die Bitrate halbiert', () => {
  const g = createBitrateGovernor(1500);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 750);
});

test('die Bitrate faellt nie unter 300', () => {
  const g = createBitrateGovernor(1500);
  let now = 0;
  for (let i = 0; i < 8; i++) g.decide(vollbild, 1100 * KB, (now += 1000));
  const letzte = g.decide(vollbild, 1100 * KB, (now += 1000));
  assert.equal(letzte.bitrateKbps, null, 'an der Untergrenze wird nicht weiter gesenkt');
});

test('nach 3 s unter 128 KB steigt die Bitrate um 25 %, hoechstens bis zum Sollwert', () => {
  const g = createBitrateGovernor(1000);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 500, 'erst halbieren');
  assert.equal(g.decide(zwischenbild, 50 * KB, 1000).bitrateKbps, null,
               'die ruhige Phase beginnt hier erst zu zaehlen');
  assert.equal(g.decide(zwischenbild, 50 * KB, 3900).bitrateKbps, null,
               '2,9 s sind noch nicht 3 s');
  assert.equal(g.decide(zwischenbild, 50 * KB, 4100).bitrateKbps, 625, '+25 % nach 3,1 s');
  assert.equal(g.decide(zwischenbild, 50 * KB, 7300).bitrateKbps, 781, 'weiter hoch');
  let now = 7300;
  for (let i = 0; i < 3; i++) g.decide(zwischenbild, 50 * KB, (now += 3100));
  assert.equal(g.decide(zwischenbild, 50 * KB, (now += 3100)).bitrateKbps, null,
               'am Sollwert ist Schluss');
});

test('ein neuer Sollwert hebt die Obergrenze wieder an', () => {
  const g = createBitrateGovernor(800);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 400, 'erst halbieren');
  g.setTarget(3000);
  g.decide(zwischenbild, 50 * KB, 100);                          // ruhige Phase beginnt
  assert.equal(g.decide(zwischenbild, 50 * KB, 3200).bitrateKbps, 500);
});

test('Sendepuffer exakt 512 KB laesst ein Zwischenbild noch durch', () => {
  const g = createBitrateGovernor(1500);
  assert.equal(g.decide(zwischenbild, 512 * KB, 0).send, true,
               'die Schwelle ist "ueber 512 KB", nicht "ab 512 KB"');
});

test('Sendepuffer exakt 1 MB halbiert die Bitrate noch nicht', () => {
  const g = createBitrateGovernor(1500);
  assert.equal(g.decide(vollbild, 1024 * KB, 0).bitrateKbps, null,
               'die Schwelle ist "ueber 1 MB", nicht "ab 1 MB"');
});

test('Sendepuffer exakt 128 KB gilt nicht als ruhig', () => {
  const g = createBitrateGovernor(1000);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 500, 'erst halbieren');
  assert.equal(g.decide(zwischenbild, 128 * KB, 1000).bitrateKbps, null,
               'genau 128 KB ist nicht "unter" der Ruhe-Schwelle');
  assert.equal(g.decide(zwischenbild, 50 * KB, 4000).bitrateKbps, null,
               'die Ruhephase beginnt erst jetzt, 3 s sind ab hier noch nicht um');
  assert.equal(g.decide(zwischenbild, 50 * KB, 7000).bitrateKbps, 625,
               'waere die Ruhephase schon bei 128 KB gestartet, waere hier laengst erhoeht worden');
});

test('Ruhephase exakt 3000 ms lang unter 128 KB hebt die Bitrate an', () => {
  const g = createBitrateGovernor(1000);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 500, 'erst halbieren');
  assert.equal(g.decide(zwischenbild, 50 * KB, 1000).bitrateKbps, null, 'die Ruhephase beginnt hier');
  assert.equal(g.decide(zwischenbild, 50 * KB, 4000).bitrateKbps, 625,
               'nach genau 3000 ms wird bereits angehoben');
});
