// Run: cd server && TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register --test ../mobile/src/season2/hooks/dictationClient.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { DictationUpload, DictationIO, CHUNK_BYTES } from './dictationClient';

interface FakeIO extends DictationIO {
  file: Buffer;
  sent: any[];
  online: boolean;
}

function fakeIO(size = 0): FakeIO {
  const io: FakeIO = {
    file: Buffer.alloc(size, 7),
    sent: [],
    online: true,
    send(msg: object) { if (!io.online) return false; io.sent.push(msg); return true; },
    fileSize: async () => io.file.length,
    readBase64: async (pos: number, len: number) => {
      if (pos + len > io.file.length) throw new Error('read past EOF'); // native code crashes here
      return io.file.subarray(pos, pos + len).toString('base64');
    },
    now: () => 0,
  };
  return io;
}

const chunks = (io: FakeIO) => io.sent.filter((m) => m.type === 'dictation:chunk').map((m) => [m.payload.offset, Buffer.from(m.payload.data, 'base64').length]);
const types = (io: FakeIO) => io.sent.map((m) => m.type);

test('pump sends what the growing file has and never reads past its end', async () => {
  const io = fakeIO(10);
  const u = new DictationUpload('d1', 'adts', false, io);
  u.begin();
  await u.pump();
  io.file = Buffer.concat([io.file, Buffer.alloc(5, 1)]);
  await u.pump();
  assert.deepStrictEqual(chunks(io), [[0, 10], [10, 5]]);
});

test('large backlogs go out in chunks of at most CHUNK_BYTES', async () => {
  const io = fakeIO(CHUNK_BYTES * 2 + 3);
  const u = new DictationUpload('d1', 'adts', false, io);
  await u.pump();
  assert.deepStrictEqual(chunks(io), [[0, CHUNK_BYTES], [CHUNK_BYTES, CHUNK_BYTES], [CHUNK_BYTES * 2, 3]]);
});

// The old bug: send() dropped the upload silently while the socket was down.
test('bytes dropped while offline are sent again after reconnect from the server position', async () => {
  const io = fakeIO(10);
  const u = new DictationUpload('d1', 'adts', false, io);
  u.begin();
  await u.pump();                                   // 0..10 delivered
  io.online = false;
  io.file = Buffer.concat([io.file, Buffer.alloc(10, 2)]);
  await u.pump();                                   // dropped
  io.online = true;
  u.onReconnect();
  assert.strictEqual(io.sent.at(-1).type, 'dictation:resume');
  assert.strictEqual(u.onServer({ type: 'dictation:state', payload: { id: 'd1', status: 'receiving', bytes: 10 } }), 'restart');
  await u.pump();
  assert.deepStrictEqual(chunks(io), [[0, 10], [10, 10]]);
});

test('finish sends the rest and then end with the total size', async () => {
  const io = fakeIO(12);
  const u = new DictationUpload('d1', 'adts', false, io);
  u.begin();
  await u.finish();
  assert.deepStrictEqual(types(io), ['dictation:start', 'dictation:chunk', 'dictation:end']);
  assert.strictEqual(io.sent.at(-1).payload.totalBytes, 12);
});

// Server restarted: the session is gone, the kept file is uploaded again.
test('unknown session restarts the upload from zero, up to 3 attempts', async () => {
  const io = fakeIO(4);
  const u = new DictationUpload('d1', 'adts', false, io);
  u.begin();
  await u.finish();
  for (let i = 0; i < 2; i++) {
    assert.strictEqual(u.onServer({ type: 'dictation:state', payload: { id: 'd1', status: 'unknown', bytes: 0 } }), 'restart');
    assert.strictEqual(io.sent.at(-1).type, 'dictation:start');
    await u.finish();
    assert.strictEqual(io.sent.at(-1).type, 'dictation:end');
  }
  assert.strictEqual(u.attempts, 3);
  assert.strictEqual(u.onServer({ type: 'dictation:state', payload: { id: 'd1', status: 'unknown', bytes: 0 } }), 'error');
  assert.ok(u.error);
  assert.deepStrictEqual(chunks(io).filter(([o]) => o === 0).length, 3);
});

test('result is delivered once; a repeated result or state:done is ignored', () => {
  const u = new DictationUpload('d1', 'adts', false, fakeIO());
  assert.strictEqual(u.onServer({ type: 'dictation:result', payload: { id: 'd1', text: 'hallo' } }), 'result');
  assert.strictEqual(u.text, 'hallo');
  assert.strictEqual(u.onServer({ type: 'dictation:result', payload: { id: 'd1', text: 'hallo' } }), null);
  assert.strictEqual(u.onServer({ type: 'dictation:state', payload: { id: 'd1', status: 'done', bytes: 0, text: 'hallo' } }), null);
});

test('state:done after a reconnect delivers the stored text', () => {
  const u = new DictationUpload('d1', 'adts', false, fakeIO());
  assert.strictEqual(u.onServer({ type: 'dictation:state', payload: { id: 'd1', status: 'done', bytes: 3, text: 'fertig' } }), 'result');
  assert.strictEqual(u.text, 'fertig');
});

test('server error is final', () => {
  const u = new DictationUpload('d1', 'adts', false, fakeIO());
  assert.strictEqual(u.onServer({ type: 'dictation:error', payload: { id: 'd1', message: 'kaputt' } }), 'error');
  assert.strictEqual(u.error, 'kaputt');
});

test('messages for other dictations are ignored; any own message counts as a sign of life', () => {
  let t = 5;
  const io = fakeIO(); io.now = () => t;
  const u = new DictationUpload('d1', 'adts', false, io);
  assert.strictEqual(u.onServer({ type: 'dictation:result', payload: { id: 'other', text: 'x' } }), null);
  assert.strictEqual(u.text, null);
  t = 42;
  u.onServer({ type: 'dictation:progress', payload: { id: 'd1' } });
  assert.strictEqual(u.lastHeard, 42);
});

test('ackSeen flips on the first ack (old servers never send one)', () => {
  const u = new DictationUpload('d1', 'adts', false, fakeIO());
  assert.strictEqual(u.ackSeen, false);
  u.onServer({ type: 'dictation:ack', payload: { id: 'd1', bytes: 0 } });
  assert.strictEqual(u.ackSeen, true);
});
