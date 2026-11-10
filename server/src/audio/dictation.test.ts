import { test } from 'node:test';
import assert from 'node:assert';
import { DictationManager, DictationDeps, DictationEvent, DictationOptions, acceptRewrite } from './dictation';
import { nextCutLegacy } from './dictation.segment';
import type { PcmStream } from './adts-pcm';
import type { DictationStat } from './dictation.stats';

const RATE = 16000;
// Fake codec: every byte is 0.1s of constant-level audio, so 750 bytes = 75s.
const SAMPLES_PER_BYTE = RATE / 10;

interface Harness {
  mgr: DictationManager;
  calls: number[];          // seconds of audio per transcribeWav call
  rewrites: string[];
  clock: { t: number };
}

function harness(over: Partial<DictationDeps> = {}, opts: DictationOptions = {}): Harness {
  const calls: number[] = [];
  const rewrites: string[] = [];
  const clock = { t: 0 };
  const deps: DictationDeps = {
    decode: async (bytes) => new Float32Array(bytes.length * SAMPLES_PER_BYTE).fill(0.3),
    transcribeWav: async (b64) => {
      const secs = (Buffer.from(b64, 'base64').length - 44) / 2 / RATE;
      calls.push(Math.round(secs));
      return `seg${calls.length}`;
    },
    rewrite: async (t) => { rewrites.push(t); return t.toUpperCase(); },
    now: () => clock.t,
    log: () => {},
    ...over,
  };
  const mgr = new DictationManager(deps, { decodeThrottleMs: 0, heartbeatMs: 60_000, ...opts });
  return { mgr, calls, rewrites, clock };
}

function sink() {
  const events: DictationEvent[] = [];
  const fn = (ev: DictationEvent) => { events.push(ev); };
  return { events, fn, last: (type: string) => [...events].reverse().find((e) => e.type === type) as any };
}

const bytes = (n: number, fill = 1) => Buffer.alloc(n, fill);

// Fake of the incremental decoder the server uses for streamed recordings:
// byte value 1 = 0.1s of speech, 2 = speech at a tenth of that level, 3 = the
// fading end of a word (a thirtieth), 0 = silence.
function fakePcm(counter = { pushed: 0 }): PcmStream {
  let raw = Buffer.alloc(0);
  return {
    push(b: Buffer) { raw = Buffer.concat([raw, b]); counter.pushed += b.length; },
    async samples() {
      const out = new Float32Array(raw.length * SAMPLES_PER_BYTE);
      for (let i = 0; i < raw.length; i++) if (raw[i]) out.fill(raw[i] === 2 ? 0.03 : raw[i] === 3 ? 0.01 : 0.3, i * SAMPLES_PER_BYTE, (i + 1) * SAMPLES_PER_BYTE);
      return out;
    },
    get bytes() { return raw.length; },
    release() { raw = Buffer.alloc(0); },
  };
}
const streamed = (over: Partial<DictationDeps> = {}, opts: DictationOptions = {}) => harness({ openPcm: () => fakePcm(), ...over }, opts);

test('duplicate chunk at the same offset is appended once', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  assert.strictEqual(s.last('dictation:ack').bytes, 10);
});

test('overlapping chunk only appends the new tail', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.chunk('d1', 5, bytes(10), s.fn);
  assert.strictEqual(s.last('dictation:ack').bytes, 15);
});

test('a gap is not appended and the ack reports the real position', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.chunk('d1', 20, bytes(10), s.fn);
  assert.strictEqual(s.last('dictation:ack').bytes, 10);
});

test('chunk for an unknown dictation answers state unknown', () => {
  const h = harness(); const s = sink();
  h.mgr.chunk('nope', 0, bytes(1), s.fn);
  assert.strictEqual(s.last('dictation:state').status, 'unknown');
});

// The Wispr effect: long audio is transcribed WHILE recording, so after the
// stop only the rest is left.
test('adts segments are transcribed before end; only the rest after end', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(750), s.fn);          // 75s
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [60]);
  h.mgr.chunk('d1', 750, bytes(250), s.fn);        // 100s total
  h.mgr.end('d1', 1000, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [60, 40]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1 seg2');
});

// The point of the whole exercise: after the stop only a few seconds are left.
test('pieces are transcribed while recording; only a short rest after stop', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  const audio = Buffer.concat([bytes(200), bytes(4, 0), bytes(100), bytes(4, 0), bytes(40)]); // 20s, 0.4s pause, 10s, 0.4s pause, 4s
  h.mgr.chunk('d1', 0, audio.subarray(0, 328), s.fn);   // up to 2s into the last part
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [20, 10]);            // 20.2s and 10.4s, rounded
  h.mgr.chunk('d1', 328, audio.subarray(328), s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [20, 10, 4]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1 seg2 seg3');
});

// A reconnect resends bytes: none of them may end up in the audio twice.
test('with a pcm stream every byte is pushed exactly once, also on overlap and duplicates', async () => {
  const counter = { pushed: 0 };
  const h = harness({ openPcm: () => fakePcm(counter) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);      // duplicate
  h.mgr.chunk('d1', 30, bytes(50), s.fn);     // overlap
  h.mgr.chunk('d1', 200, bytes(10), s.fn);    // gap: ignored
  assert.strictEqual(counter.pushed, 80);
  assert.strictEqual(h.mgr.bufferedBytes('d1'), 80);
});

test('a pcm stream is released when the dictation finishes', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);
  h.mgr.end('d1', 50, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, 'seg1');
  assert.strictEqual(h.mgr.bufferedBytes('d1'), 0);
});

test('a tap too short to hold audio ends with an empty result (pcm stream)', async () => {
  const h = harness({ openPcm: () => ({ push() {}, async samples() { return new Float32Array(0); }, bytes: 0, release() {} }) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(3), s.fn);
  h.mgr.end('d1', 3, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, '');
  assert.strictEqual(s.last('dictation:error'), undefined);
});

test('a finished dictation reports its timing', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);
  h.clock.t = 1000;
  h.mgr.end('d1', 50, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(stats.length, 1);
  assert.strictEqual(stats[0].audioSecs, 5);
  assert.strictEqual(stats[0].restSecs, 5);
  assert.strictEqual(stats[0].specHit, false);
  assert.strictEqual(stats[0].at, 1000);
});

test('a failed or cancelled dictation reports no timing', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x), transcribeWav: async () => { throw new Error('boom'); } }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);
  h.mgr.end('d1', 50, s.fn);
  await h.mgr.idle('d1');
  h.mgr.start('d2', 'adts', false, s.fn);
  h.mgr.chunk('d2', 0, bytes(50), s.fn);
  h.mgr.cancel('d2');
  assert.strictEqual(stats.length, 0);
});

// ── Looking ahead ──────────────────────────────────────────────────────
// People stop talking, then tap: the last piece is transcribed in that gap.
test('a pause at the live edge is transcribed ahead; stop without new speech needs no further call', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(50), bytes(5, 0)]), s.fn);   // 5s speech + 0.5s quiet
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [5]);
  h.mgr.end('d1', 55, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [5]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1');
  assert.strictEqual(stats[0].specHit, true);
});

test('the same trailing pause is not transcribed ahead twice', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(50), bytes(5, 0)]), s.fn);
  await h.mgr.idle('d1');
  h.mgr.chunk('d1', 55, bytes(10, 0), s.fn);                              // still quiet
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [5]);
});

test('speech after a short piece transcribed ahead discards it — no duplicate text', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(30), bytes(5, 0)]), s.fn);   // 3s + pause → ahead: seg1
  await h.mgr.idle('d1');
  h.mgr.chunk('d1', 35, bytes(31), s.fn);
  h.mgr.end('d1', 66, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, 'seg2');           // one text for the whole 6.6s
  assert.deepStrictEqual(h.calls, [3, 7]);
});

test('a piece of at least 8s transcribed ahead is kept when speech resumes', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(100), bytes(5, 0)]), s.fn);  // 10s + pause
  await h.mgr.idle('d1');
  h.mgr.chunk('d1', 105, bytes(30), s.fn);
  h.mgr.end('d1', 135, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [10, 3]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1 seg2');
});

test('a stop during a transcription ahead waits for it instead of starting another', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const h = streamed({ transcribeWav: async () => { n++; await gate; return 'ahead'; } }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(50), bytes(5, 0)]), s.fn);
  await new Promise((r) => setImmediate(r));
  h.mgr.end('d1', 55, s.fn);
  release();
  await h.mgr.idle('d1');
  assert.strictEqual(n, 1);
  assert.strictEqual(s.last('dictation:result').text, 'ahead');
});

test('nothing is transcribed ahead on silence only', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(30, 0), s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, []);
});

test('a failed transcription ahead does not fail the dictation', async () => {
  let n = 0;
  const h = streamed({ transcribeWav: async () => { if (n++ === 0) throw new Error('sidecar busy'); return 'ok'; } }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(50), bytes(5, 0)]), s.fn);
  await h.mgr.idle('d1');
  h.mgr.end('d1', 55, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, 'ok');
  assert.strictEqual(s.last('dictation:error'), undefined);
});

// ── Review findings (final review of feat/diktat-tempo) ───────────────
// Streams `audio` in 0.5s uploads like the app, waiting for the manager after each.
async function stream(h: Harness, id: string, audio: Buffer, fn: (ev: DictationEvent) => void): Promise<void> {
  for (let off = 0; off < audio.length; off += 5) { h.mgr.chunk(id, off, audio.subarray(off, off + 5), fn); await h.mgr.idle(id); }
}

// C1: a short remark, a long think, a short add-on, stop — the add-on was dropped.
test('speech after a long silence is not lost when a piece was transcribed ahead', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  const audio = Buffer.concat([bytes(10), bytes(220, 0), bytes(10)]);    // 1s speech, 22s silence, 1s speech
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  // The opener's text made ahead is dropped; what replaces it covers all 24 seconds.
  assert.strictEqual(h.calls.slice(1).reduce((a, b) => a + b, 0), 24, `calls ${h.calls}`);
  assert.strictEqual(s.last('dictation:result').text.split(' ').length, h.calls.length - 1);
  assert.strictEqual(stats[0].specHit, false);
});

// C1, second way in: the add-on is much quieter than what came before.
test('much quieter speech after a pause is not lost', async () => {
  const h = streamed(); const s = sink();
  const audio = Buffer.concat([bytes(50), bytes(6, 0), bytes(20, 2)]);    // 5s, 0.6s pause, 2s at 10% level
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(h.calls[h.calls.length - 1], 8, `calls ${h.calls}`);
});

// Found when re-measuring after the C1 fix: a word does not end abruptly. Its
// fading tail is louder than the room but is not new speech.
test('the fading end of the last word does not prevent transcribing ahead', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  const audio = Buffer.concat([bytes(50), bytes(2, 3), bytes(6, 0)]);     // 5s, 0.2s fading, 0.6s silence
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [5]);
  assert.strictEqual(stats[0].specHit, true);
});

// C1 once more: quiet speech that goes on for long must not turn into "the room".
test('long quiet speech after a pause is not lost', async () => {
  const h = streamed(); const s = sink();
  const audio = Buffer.concat([bytes(50), bytes(6, 0), bytes(60, 2)]);    // 5s, 0.6s pause, 6s at 10% level
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(h.calls[h.calls.length - 1], 12, `calls ${h.calls}`);
});

// I1: while the speaker is quiet, audio that already has a text is not cut up again.
test('a thinking pause does not re-cut what was transcribed ahead', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  const audio = Buffer.concat([bytes(90), bytes(3, 0), bytes(30), bytes(60, 0)]);  // 9s, breath, 3s, 6s silence
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [12]);
  assert.strictEqual(stats[0].specHit, true);
});

test('a long silence after speech is not transcribed as pieces of its own', async () => {
  const h = streamed(); const s = sink();
  const audio = Buffer.concat([bytes(100), bytes(200, 0)]);               // 10s speech, 20s silence
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [10]);
});

// I2: the tap on the stop button (or a breath) after the last sentence.
test('a short noise after the last sentence does not undo the piece transcribed ahead', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  const audio = Buffer.concat([bytes(100), bytes(6, 0), bytes(1), bytes(3, 0)]);   // 10s, 0.6s pause, 0.1s blip, 0.3s quiet
  h.mgr.start('d1', 'adts', false, s.fn);
  await stream(h, 'd1', audio, s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [10]);
  assert.strictEqual(stats[0].specHit, true);
});

// I3: the numbers must not look better than the wait was.
test('the rest reported for a stop during a running piece includes that piece', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x), transcribeWav: async () => { await gate; return 'x'; } }); const s = sink();
  const audio = Buffer.concat([bytes(200), bytes(5, 0), bytes(20)]);      // 20s, pause, 2s
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, audio, s.fn);
  await new Promise((r) => setImmediate(r));                              // the 20s piece is being transcribed
  h.mgr.end('d1', audio.length, s.fn);
  release();
  await h.mgr.idle('d1');
  assert.ok(stats[0].restSecs > 22, `rest ${stats[0].restSecs}`);
});

test('a tap without any audio is not counted in the timings', async () => {
  const stats: DictationStat[] = [];
  const h = streamed({ onDone: (x) => stats.push(x) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.end('d1', 0, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, '');
  assert.strictEqual(stats.length, 0);
});

test('the legacy cut can be injected', async () => {
  const h = streamed({}, { cut: nextCutLegacy }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(750), s.fn);               // 75s of speech
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [60]);                // as before
});

// Whole-file uploads keep the 60s rule.
test('file format keeps the 60s pieces', async () => {
  const h = streamed(); const s = sink();
  h.mgr.start('d1', 'file', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(1000), s.fn);
  h.mgr.end('d1', 1000, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [60, 40]);
});

test('file format is only transcribed after end', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'file', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(700), s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, []);
  h.mgr.end('d1', 700, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [70]);
});

test('end waits for missing bytes, then finishes', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 20, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result'), undefined);
  assert.strictEqual(s.last('dictation:ack').bytes, 10);
  h.mgr.chunk('d1', 10, bytes(10), s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, 'seg1');
});

test('resume after done from a new socket returns the stored text', async () => {
  const h = harness(); const a = sink(); const b = sink();
  h.mgr.start('d1', 'adts', false, a.fn);
  h.mgr.chunk('d1', 0, bytes(10), a.fn);
  h.mgr.end('d1', 10, a.fn);
  await h.mgr.idle('d1');
  h.mgr.resume('d1', b.fn);
  const st = b.last('dictation:state');
  assert.strictEqual(st.status, 'done');
  assert.strictEqual(st.text, 'seg1');
});

// Reconnect while the Mac is still working: the result must reach the NEW socket.
test('result goes to the socket that resumed during processing', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness({ transcribeWav: async () => { await gate; return 'late'; } });
  const a = sink(); const b = sink();
  h.mgr.start('d1', 'adts', false, a.fn);
  h.mgr.chunk('d1', 0, bytes(10), a.fn);
  h.mgr.end('d1', 10, a.fn);
  h.mgr.resume('d1', b.fn);
  assert.strictEqual(b.last('dictation:state').status, 'processing');
  release();
  await h.mgr.idle('d1');
  assert.strictEqual(b.last('dictation:result').text, 'late');
  assert.strictEqual(a.last('dictation:result'), undefined);
});

test('cancel suppresses the result', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 10, s.fn);
  h.mgr.cancel('d1');
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result'), undefined);
});

test('a failing transcription reports dictation:error', async () => {
  const h = harness({ transcribeWav: async () => { throw new Error('boom'); } });
  const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 10, s.fn);
  await h.mgr.idle('d1');
  assert.match(s.last('dictation:error').message, /boom/);
  h.mgr.resume('d1', s.fn);
  assert.strictEqual(s.last('dictation:state').status, 'error');
});

test('enhance runs the rewriter on the joined text', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', true, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 10, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.rewrites, ['seg1']);
  assert.strictEqual(s.last('dictation:result').text, 'SEG1');
});

test('acceptRewrite keeps the original when the rewrite lost over half the words', () => {
  assert.strictEqual(acceptRewrite('a b c d', 'a'), 'a b c d');
  assert.strictEqual(acceptRewrite('a b c d', 'a b c'), 'a b c');
  assert.strictEqual(acceptRewrite('a b', ''), 'a b');
});

test('sweep forgets finished dictations after 15 minutes', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 10, s.fn);
  await h.mgr.idle('d1');
  h.clock.t = 14 * 60_000; h.mgr.sweep();
  h.mgr.resume('d1', s.fn);
  assert.strictEqual(s.last('dictation:state').status, 'done');
  h.clock.t = 16 * 60_000; h.mgr.sweep();
  h.mgr.resume('d1', s.fn);
  assert.strictEqual(s.last('dictation:state').status, 'unknown');
});

test('sweep drops an abandoned upload after 10 idle minutes', () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.clock.t = 11 * 60_000; h.mgr.sweep();
  h.mgr.resume('d1', s.fn);
  assert.strictEqual(s.last('dictation:state').status, 'unknown');
});

// Review I1: on a live socket a gap means a chunk was dropped (e.g. rate
// limiter). The client only re-positions on `state`, so say it explicitly.
test('a gap answers with state receiving at the real position', () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.chunk('d1', 20, bytes(10), s.fn);
  const st = s.last('dictation:state');
  assert.strictEqual(st.status, 'receiving');
  assert.strictEqual(st.bytes, 10);
});

test('end with missing bytes answers with state receiving', () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 20, s.fn);
  assert.strictEqual(s.last('dictation:state').bytes, 10);
});

// Review I3: an empty / undecodable recording is "nothing said", not an ffmpeg error.
test('an empty recording ends with an empty result', async () => {
  const h = harness({ decode: async (b) => { if (b.length === 0) throw new Error('ffmpeg decode failed'); return new Float32Array(0); } });
  const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.end('d1', 0, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, '');
  assert.strictEqual(s.last('dictation:error'), undefined);
});

// Review I5: the sidecar restarts after a crash — one retry of the final pass
// means the dictation still arrives.
test('the final pass is retried once after a transcription failure', async () => {
  let n = 0;
  const h = harness({ transcribeWav: async () => { if (n++ === 0) throw new Error('sidecar crashed'); return 'ok'; } });
  const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 10, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, 'ok');
});

// Review I7: no full decode every few seconds while nothing can be cut yet.
test('streaming does not decode again until a segment could be ready', async () => {
  let decodes = 0;
  const h = harness({ decode: async (b) => { decodes++; return new Float32Array(b.length * SAMPLES_PER_BYTE).fill(0.3); } });
  const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  for (let off = 0; off < 1500; off += 10) {          // 150s in 1s pieces
    h.mgr.chunk('d1', off, bytes(10), s.fn);
    await h.mgr.idle('d1');
  }
  assert.ok(decodes <= 6, `decoded ${decodes} times`);
  assert.deepStrictEqual(h.calls.slice(0, 1), [60]);
});

test('finished sessions drop their audio bytes', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(10), s.fn);
  h.mgr.end('d1', 10, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(h.mgr.bufferedBytes('d1'), 0);
});
