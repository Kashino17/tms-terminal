import { test } from 'node:test';
import assert from 'node:assert';
import { DictationManager, DictationDeps, DictationEvent, acceptRewrite } from './dictation';

const RATE = 16000;
// Fake codec: every byte is 0.1s of constant-level audio, so 750 bytes = 75s.
const SAMPLES_PER_BYTE = RATE / 10;

interface Harness {
  mgr: DictationManager;
  calls: number[];          // seconds of audio per transcribeWav call
  rewrites: string[];
  clock: { t: number };
}

function harness(over: Partial<DictationDeps> = {}): Harness {
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
  const mgr = new DictationManager(deps, { decodeThrottleMs: 0, heartbeatMs: 60_000 });
  return { mgr, calls, rewrites, clock };
}

function sink() {
  const events: DictationEvent[] = [];
  const fn = (ev: DictationEvent) => { events.push(ev); };
  return { events, fn, last: (type: string) => [...events].reverse().find((e) => e.type === type) as any };
}

const bytes = (n: number, fill = 1) => Buffer.alloc(n, fill);

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
