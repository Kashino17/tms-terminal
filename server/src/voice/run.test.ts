import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSpeechRun, LOOK_AHEAD, type SpeechChunk } from './run';

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }

/** A voice that answers only when the test lets it. */
function rig(parts: string[], lookAhead = LOOK_AHEAD) {
  const asked: string[] = [];
  const waiting: Array<{ ok: (ms?: number) => void; fail: (e: Error) => void }> = [];
  const chunks: SpeechChunk[] = [];
  const errors: string[] = [];
  const run = startSpeechRun(parts, (text) => {
    asked.push(text);
    return new Promise((resolve, reject) => waiting.push({ ok: (ms = 1000) => resolve({ audio: Buffer.from(text), ms }), fail: reject }));
  }, (c) => chunks.push(c), (m) => errors.push(m), lookAhead);
  return { run, asked, waiting, chunks, errors };
}
const S = (n: number) => `Dies ist der Satz Nummer ${n} mit genug Länge.`;

test('Satz für Satz: jedes Stück geht raus, sobald es fertig ist — mit Teil-Index und Schlussmarke', async () => {
  const t = rig([S(1) + ' ' + S(2), S(3)]);
  await settle();
  assert.deepEqual(t.asked, [S(1)], 'immer nur ein Satz gleichzeitig');
  t.waiting[0].ok(); await settle();
  assert.equal(t.chunks.length, 1, 'der erste Satz ist unterwegs, bevor der zweite erzeugt ist');
  assert.deepEqual([t.chunks[0].seq, t.chunks[0].index, t.chunks[0].first, t.chunks[0].last, t.chunks[0].audio.toString()], [0, 0, true, false, S(1)]);
  t.waiting[1].ok(); await settle();
  t.waiting[2].ok(); await settle();
  assert.deepEqual(t.chunks.map((c) => [c.seq, c.index, c.first, c.last]), [[0, 0, true, false], [1, 0, false, false], [2, 1, true, true]]);
  await t.run.done;
});

test('nie weiter voraus als nötig: der Mac rechnet nicht die ganze Antwort, wenn nach dem ersten Satz gestoppt wird', async () => {
  const t = rig(Array.from({ length: 10 }, (_, i) => S(i)), 3);
  for (let i = 0; i < 6; i++) { await settle(); if (t.waiting[i]) t.waiting[i].ok(); }
  await settle();
  assert.equal(t.asked.length, 3, 'drei Sätze voraus, dann warten auf das Abspielen');
  t.run.played(0); await settle();
  assert.equal(t.asked.length, 4, 'ein Satz gespielt → einer mehr erzeugt');
  t.run.played(2); await settle();
  t.waiting[3].ok(); await settle(); t.waiting[4].ok(); await settle(); t.waiting[5].ok(); await settle();
  assert.equal(t.asked.length, 6, 'bis Satz 5 frei (gespielt 2 + 3 voraus), Satz 6 wartet');
  t.run.stop(); await t.run.done;
});

test('Anhalten: nichts wird mehr gesendet, auch nicht der Satz, der gerade erzeugt wird', async () => {
  const t = rig([S(1), S(2), S(3)]);
  await settle();
  t.waiting[0].ok(); await settle();
  t.run.stop();
  t.waiting[1].ok(); await settle();
  assert.equal(t.chunks.length, 1);
  assert.equal(t.asked.length, 2, 'kein weiterer Satz wird angefangen');
  await t.run.done;
});

test('Fehler der Stimme: eine Meldung, dann Schluss', async () => {
  const t = rig([S(1), S(2)]);
  await settle();
  t.waiting[0].fail(new Error('Modell weg')); await settle();
  assert.deepEqual(t.errors, ['Modell weg']);
  assert.equal(t.asked.length, 1);
  await t.run.done;
});

test('nichts Sprechbares: sofort fertig, als leerer Schluss gemeldet', async () => {
  const t = rig(['', '   ']);
  await t.run.done;
  assert.deepEqual(t.chunks.map((c) => [c.last, c.audio.length]), [[true, 0]]);
});
