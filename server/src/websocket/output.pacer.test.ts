import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutputPacer, paceFor, SLOW_MS, HOLD_MS, HOLD_MAX_BYTES, SLOW_MAX_BYTES, INPUT_LIVE_MS,
} from './output.pacer';

/** A pacer with a hand-driven clock: timers fire only when the test says so. */
function rig() {
  const sent: Array<[string, string]> = [];
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const pacer = createOutputPacer((sid, data) => { sent.push([sid, data]); }, {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  };
  return { pacer, sent, advance, pendingTimers: () => timers.size };
}

test('paceFor: was der Client meldet, bestimmt das Tempo', () => {
  assert.equal(paceFor(true, null, 'a'), 'live', 'nichts gemeldet (alte App / alles sichtbar) → wie bisher');
  assert.equal(paceFor(true, 'a', 'a'), 'live', 'das Terminal vorne');
  assert.equal(paceFor(true, 'a', 'b'), 'slow', 'verdecktes Terminal');
  assert.equal(paceFor(true, '', 'b'), 'slow', 'kein Terminal sichtbar (anderer Bildschirm)');
  assert.equal(paceFor(false, 'a', 'a'), 'hold', 'App nicht sichtbar: auch das Terminal vorne wartet');
});

test('ohne Meldung vom Client geht jede Ausgabe sofort raus (altes Verhalten)', () => {
  const { pacer, sent } = rig();
  pacer.push('a', 'x'); pacer.push('b', 'y');
  assert.deepEqual(sent, [['a', 'x'], ['b', 'y']]);
});

test('verdecktes Terminal: Ausgabe wird zu einer Nachricht pro Sekunde gebündelt, Reihenfolge bleibt', () => {
  const { pacer, sent, advance } = rig();
  pacer.setAttention(true, 'a');
  pacer.push('b', '1'); pacer.push('a', 'live'); pacer.push('b', '2');
  advance(SLOW_MS - 1);
  pacer.push('b', '3');
  assert.deepEqual(sent, [['a', 'live']], 'das Terminal vorne sofort, das verdeckte wartet');
  advance(1);
  assert.deepEqual(sent, [['a', 'live'], ['b', '123']], 'ein Bündel, Bytes vollständig und in Reihenfolge');
  pacer.push('b', '4');
  advance(SLOW_MS);
  assert.deepEqual(sent[2], ['b', '4'], 'das nächste Bündel startet neu');
});

test('Terminalwechsel: das neue Terminal vorne bekommt seinen Rückstand sofort', () => {
  const { pacer, sent, pendingTimers } = rig();
  pacer.setAttention(true, 'a');
  pacer.push('b', 'old');
  pacer.setAttention(true, 'b');
  assert.deepEqual(sent, [['b', 'old']]);
  pacer.push('b', 'new');
  assert.deepEqual(sent[1], ['b', 'new'], 'ab jetzt live');
  assert.equal(pendingTimers(), 0);
});

test('App im Hintergrund: alles wird gehalten und kommt beim Zurückkehren sofort, vollständig', () => {
  const { pacer, sent, advance } = rig();
  pacer.setAttention(true, 'a');
  pacer.setAttention(false, 'a');
  pacer.push('a', 'A1'); pacer.push('b', 'B1');
  advance(HOLD_MS - 1);
  pacer.push('a', 'A2');
  assert.deepEqual(sent, [], 'nichts geht raus, solange niemand hinsieht');
  pacer.setAttention(true, 'a');
  assert.deepEqual(sent.sort(), [['a', 'A1A2'], ['b', 'B1']], 'zurück: beide Rückstände sofort');
});

test('App im Hintergrund: spätestens nach HOLD_MS ein Bündel — und bei viel Ausgabe früher', () => {
  const { pacer, sent, advance } = rig();
  pacer.setAttention(false, null);
  pacer.push('a', 'x');
  advance(HOLD_MS);
  assert.deepEqual(sent, [['a', 'x']]);
  const big = 'y'.repeat(HOLD_MAX_BYTES);
  pacer.push('a', 'z'); pacer.push('a', big);
  assert.equal(sent.length, 2, 'Größengrenze erreicht → sofort raus, kein unbegrenzter Puffer');
  assert.equal(sent[1][1].length, 1 + HOLD_MAX_BYTES);
});

test('verdecktes Terminal mit viel Ausgabe: Größengrenze löst früher aus', () => {
  const { pacer, sent } = rig();
  pacer.setAttention(true, 'a');
  pacer.push('b', 'q'.repeat(SLOW_MAX_BYTES));
  assert.equal(sent.length, 1);
});

test('wer tippt, sieht sofort: Eingabe macht ein Terminal für kurze Zeit live', () => {
  const { pacer, sent, advance } = rig();
  pacer.setAttention(true, 'a');
  pacer.push('b', 'vorher');
  pacer.noteInput('b');
  assert.deepEqual(sent, [['b', 'vorher']], 'Rückstand zuerst — die Reihenfolge darf nie kippen');
  pacer.push('b', 'echo');
  assert.deepEqual(sent[1], ['b', 'echo']);
  advance(INPUT_LIVE_MS + 1);
  pacer.push('b', 'später');
  assert.equal(sent.length, 2, 'danach wieder gebündelt');
});

test('take: was noch nicht gesendet wurde, geht beim Trennen nicht verloren', () => {
  const { pacer, sent, advance, pendingTimers } = rig();
  pacer.setAttention(false, null);
  pacer.push('a', 'un'); pacer.push('a', 'gesendet');
  assert.equal(pacer.take('a'), 'ungesendet');
  assert.equal(pacer.take('a'), '', 'nur einmal');
  advance(HOLD_MS * 2);
  assert.deepEqual(sent, [], 'und es wird nicht doch noch gesendet');
  assert.equal(pendingTimers(), 0);
});

test('dispose: keine Zeitgeber bleiben zurück', () => {
  const { pacer, pendingTimers } = rig();
  pacer.setAttention(false, null);
  pacer.push('a', 'x'); pacer.push('b', 'y');
  pacer.dispose();
  assert.equal(pendingTimers(), 0);
});
