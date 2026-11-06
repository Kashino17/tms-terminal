import { test } from 'node:test';
import assert from 'node:assert';
import { createFrameFlow, QUEUE_BUDGET_MS } from './flow';

const key = { keyframe: true };
const delta = { keyframe: false };

/** Sends a frame at `at` and returns the decision. */
function sendAt(flow: ReturnType<typeof createFrameFlow>, ts: number, at: number, au = delta, buffered = 0) {
  const d = flow.decide(au, at, buffered);
  if (d.send) flow.onSent(ts, at);
  return d;
}

// Die App v1.110.0 quittiert keine Bilder. Ohne Quittungen darf die neue Logik
// nichts verwerfen — sonst sähe ein altes Handy nie wieder ein Bild.
test('ohne Quittungen: altes Verhalten nach Pufferfüllstand', () => {
  const flow = createFrameFlow(1500);
  for (let i = 0; i < 50; i++) assert.strictEqual(sendAt(flow, i, i * 33).send, true);
  assert.strictEqual(flow.decide(delta, 2000, 600 * 1024).send, false, 'über 512 KB wie bisher verwerfen');
});

test('ruhige Leitung: jedes Bild geht raus', () => {
  const flow = createFrameFlow(1500);
  for (let i = 0; i < 100; i++) {
    const now = i * 33;
    assert.strictEqual(sendAt(flow, now, now).send, true, `Bild ${i}`);
    flow.onAck(now, now + 100); // konstante 100 ms Laufzeit
  }
});

// Der Kern: staut sich die Leitung (Quittungen bleiben länger aus als die
// Grundlaufzeit + Budget), wird verworfen statt sekundenlang aufgestaut.
test('Stau: Bilder werden verworfen statt aufgestaut', () => {
  const flow = createFrameFlow(1500);
  sendAt(flow, 0, 0); flow.onAck(0, 100);          // Grundlaufzeit 100 ms
  sendAt(flow, 1000, 1000);                         // bleibt unquittiert
  const d = flow.decide(delta, 1000 + 100 + QUEUE_BUDGET_MS + 1, 0);
  assert.strictEqual(d.send, false);
});

test('Stau senkt die Bitrate, höchstens einmal pro Sekunde', () => {
  const flow = createFrameFlow(1500);
  sendAt(flow, 0, 0); flow.onAck(0, 100);
  sendAt(flow, 1000, 1000);
  const late = 1000 + 100 + QUEUE_BUDGET_MS + 1;
  const first = flow.decide(delta, late, 0);
  assert.ok(first.bitrateKbps !== null && first.bitrateKbps < 1500);
  assert.strictEqual(flow.decide(delta, late + 10, 0).bitrateKbps, null);
});

// Nach verworfenen Zwischenbildern fehlt dem Dekoder die Referenz: bis zum
// nächsten Vollbild wäre alles grauer Matsch. Also Vollbild anfordern und
// Zwischenbilder so lange zurückhalten.
test('nach dem Stau: Vollbild anfordern, Zwischenbilder bis dahin zurückhalten', () => {
  const flow = createFrameFlow(1500);
  sendAt(flow, 0, 0); flow.onAck(0, 100);
  sendAt(flow, 1000, 1000);
  flow.decide(delta, 1000 + 100 + QUEUE_BUDGET_MS + 1, 0); // Stau -> verworfen
  flow.onAck(1000, 1400);                                   // Leitung wieder frei
  const d1 = flow.decide(delta, 1500, 0);
  assert.strictEqual(d1.send, false);
  assert.strictEqual(d1.requestKeyframe, true);
  const d2 = flow.decide(delta, 1510, 0);
  assert.strictEqual(d2.send, false);
  assert.strictEqual(d2.requestKeyframe, false, 'nicht bei jedem Bild erneut anfordern');
  assert.strictEqual(flow.decide(key, 1520, 0).send, true, 'das Vollbild geht raus');
  flow.onSent(1520, 1520);
  assert.strictEqual(flow.decide(delta, 1553, 0).send, true, 'danach wieder normal');
});

test('Vollbild-Anforderung wird wiederholt, falls keins kommt', () => {
  const flow = createFrameFlow(1500);
  sendAt(flow, 0, 0); flow.onAck(0, 100);
  sendAt(flow, 1000, 1000);
  flow.decide(delta, 1000 + 100 + QUEUE_BUDGET_MS + 1, 0);
  flow.onAck(1000, 1400);
  assert.strictEqual(flow.decide(delta, 1500, 0).requestKeyframe, true);
  assert.strictEqual(flow.decide(delta, 2100, 0).requestKeyframe, true);
});

// Die Laufzeit schwankt (Tailscale-Relais: 83 bis 479 ms). Gemessen wird der
// Stau ÜBER der kleinsten gesehenen Laufzeit, nicht die absolute Laufzeit.
test('hohe, aber gleichmäßige Laufzeit ist kein Stau', () => {
  const flow = createFrameFlow(1500);
  for (let i = 0; i < 60; i++) {
    const now = i * 33;
    assert.strictEqual(sendAt(flow, now, now).send, true, `Bild ${i}`);
    flow.onAck(now, now + 300);
  }
});

test('nach 3 s ohne Stau steigt die Bitrate wieder, bis zum Sollwert', () => {
  const flow = createFrameFlow(1500);
  sendAt(flow, 0, 0); flow.onAck(0, 100);
  sendAt(flow, 1000, 1000);
  const cut = flow.decide(delta, 1000 + 100 + QUEUE_BUDGET_MS + 1, 0).bitrateKbps as number;
  flow.onAck(1000, 1400);
  flow.decide(key, 1500, 0); flow.onSent(1500, 1500); flow.onAck(1500, 1600);
  let raised: number | null = null;
  for (let t = 1600; t < 6000 && raised === null; t += 33) {
    const d = flow.decide(delta, t, 0);
    if (d.send) { flow.onSent(t, t); flow.onAck(t, t + 100); }
    raised = d.bitrateKbps;
  }
  assert.ok(raised !== null && raised > cut && raised <= 1500);
});

test('ein Sendepuffer-Rückstau gilt auch mit Quittungen als Stau', () => {
  const flow = createFrameFlow(1500);
  sendAt(flow, 0, 0); flow.onAck(0, 100);
  assert.strictEqual(flow.decide(delta, 200, 400 * 1024).send, false);
});
