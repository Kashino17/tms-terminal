import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechQueue } from '../src/season2/speech/queue.core.mjs';

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

function rig({ failLoad } = {}) {
  const log = [];
  const ends = new Map();
  const q = createSpeechQueue({
    load: async (c) => {
      log.push('laden ' + c.seq);
      if (failLoad === c.seq) throw new Error('kaputt');
      return { play: (onEnd) => { log.push('spielt ' + c.seq); ends.set(c.seq, onEnd); }, unload: () => log.push('frei ' + c.seq) };
    },
    onPart: (i) => log.push('teil ' + i),
    onPlayed: (s) => log.push('gemeldet ' + s),
    onDone: () => log.push('fertig'),
    onError: (m) => log.push('fehler ' + m),
  });
  const piece = (seq, index, first, last = false, audio = 'x') => ({ seq, index, first, last, audio });
  return { q, log, ends, piece };
}

test('spielt der Reihe nach; das nächste Stück ist schon geladen, während das aktuelle läuft', async () => {
  const { q, log, ends, piece } = rig();
  q.push(piece(0, 0, true)); await settle();
  assert.deepEqual(log, ['laden 0', 'gemeldet 0', 'teil 0', 'spielt 0']);
  q.push(piece(1, 0, false)); q.push(piece(2, 1, true, true)); await settle();
  assert.deepEqual(log.slice(4), ['laden 1', 'laden 2'], 'vorbereitet, aber noch nicht gespielt');
  ends.get(0)(); await settle();
  assert.deepEqual(log.slice(6), ['frei 0', 'gemeldet 1', 'spielt 1'], 'kein „teil": Stück 1 gehört noch zum selben Absatz');
  ends.get(1)(); await settle();
  ends.get(2)(); await settle();
  assert.deepEqual(log.slice(9), ['frei 1', 'gemeldet 2', 'teil 1', 'spielt 2', 'frei 2', 'fertig']);
});

test('die Stimme ist langsamer als das Abspielen: warten, dann nahtlos weiter', async () => {
  const { q, log, ends, piece } = rig();
  q.push(piece(0, 0, true)); await settle();
  ends.get(0)(); await settle();
  assert.equal(log.includes('fertig'), false, 'noch nicht das letzte Stück — still warten');
  q.push(piece(1, 1, true, true)); await settle();
  assert.deepEqual(log.slice(-3), ['gemeldet 1', 'teil 1', 'spielt 1']);
});

test('Stücke in falscher Reihenfolge und doppelt', async () => {
  const { q, log, ends, piece } = rig();
  q.push(piece(1, 0, false, true)); await settle();
  assert.deepEqual(log, ['laden 1'], 'Stück 1 wartet auf Stück 0');
  q.push(piece(0, 0, true)); q.push(piece(0, 0, true)); await settle();
  assert.deepEqual(log.filter((l) => l.startsWith('spielt')), ['spielt 0']);
  ends.get(0)(); await settle(); ends.get(1)(); await settle();
  assert.equal(log.at(-1), 'fertig');
});

test('Anhalten: Ton aus, alles freigegeben, keine Meldung mehr', async () => {
  const { q, log, ends, piece } = rig();
  q.push(piece(0, 0, true)); q.push(piece(1, 0, false)); await settle();
  q.stop(); await settle();
  assert.ok(log.includes('frei 0') && log.includes('frei 1'));
  const n = log.length;
  ends.get(0)(); q.push(piece(2, 1, true, true)); await settle();
  assert.equal(log.length, n, 'nach dem Anhalten passiert nichts mehr');
  assert.equal(q.stopped, true);
});

test('leeres Schlussstück (nichts zu sprechen) meldet sofort fertig', async () => {
  const { q, log, piece } = rig();
  q.push(piece(0, 0, true, true, '')); await settle();
  assert.deepEqual(log, ['gemeldet 0', 'teil 0', 'fertig']);
});

test('ein Stück lässt sich nicht laden: Fehler, Rest wird freigegeben', async () => {
  const { q, log, ends, piece } = rig({ failLoad: 1 });
  q.push(piece(0, 0, true)); q.push(piece(1, 0, false)); q.push(piece(2, 0, false, true)); await settle();
  ends.get(0)(); await settle();
  assert.ok(log.includes('fehler kaputt'));
  assert.ok(log.includes('frei 2'), 'das schon geladene Stück danach wird freigegeben');
  assert.equal(log.includes('fertig'), false);
});
