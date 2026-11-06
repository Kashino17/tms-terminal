import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { DictationManager } from './dictation';
import { isDictationRequest, createDictationConnectionHandler, handleDictationMessage } from './dictation.connection';

function fakeWs() {
  const ws: any = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.sent = [] as any[];
  ws.send = (data: string) => ws.sent.push(JSON.parse(data));
  return ws;
}

function manager() {
  return new DictationManager({
    decode: async (b) => new Float32Array(b.length * 1600).fill(0.3),
    transcribeWav: async () => 'hallo',
    rewrite: async (t) => t,
    now: () => 0,
    log: () => {},
  }, { decodeThrottleMs: 0 });
}

// The bubble must not become the server's "current app connection" (manager
// messages, browser bridge) — so it is routed to its own lean handler.
test('role=dictation in the query marks a dictation-only connection', () => {
  assert.strictEqual(isDictationRequest('/?token=abc&role=dictation'), true);
  assert.strictEqual(isDictationRequest('/?role=dictation&token=abc'), true);
  assert.strictEqual(isDictationRequest('/?token=abc'), false);
  assert.strictEqual(isDictationRequest(undefined), false);
});

test('a dictation connection answers the streaming protocol end to end', async () => {
  const mgr = manager();
  const ws = fakeWs();
  createDictationConnectionHandler(mgr, () => {})(ws, '1.2.3.4');
  const msg = (m: object) => ws.emit('message', Buffer.from(JSON.stringify(m)));
  msg({ type: 'dictation:start', payload: { id: 'b1', format: 'adts' } });
  msg({ type: 'dictation:chunk', payload: { id: 'b1', offset: 0, data: Buffer.alloc(10, 1).toString('base64') } });
  msg({ type: 'dictation:end', payload: { id: 'b1', totalBytes: 10 } });
  await mgr.idle('b1');
  assert.deepStrictEqual(ws.sent.find((m: any) => m.type === 'dictation:result'), { type: 'dictation:result', payload: { id: 'b1', text: 'hallo' } });
});

test('a dictation connection ignores everything that is not dictation:*', () => {
  const ws = fakeWs();
  createDictationConnectionHandler(manager(), () => {})(ws, 'x');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'terminal:create', payload: {} })));
  ws.emit('message', Buffer.from('not json'));
  assert.deepStrictEqual(ws.sent, []);
});

test('handleDictationMessage rejects bad ids and oversized chunks', () => {
  const mgr = manager();
  const out: Array<{ type: string }> = [];
  const send = (m: { type: string }) => { out.push(m); };
  assert.strictEqual(handleDictationMessage(mgr, { type: 'dictation:start', payload: { id: '../x' } }, send), true);
  assert.strictEqual(out.length, 0);
  handleDictationMessage(mgr, { type: 'dictation:start', payload: { id: 'ok', format: 'adts' } }, send);
  handleDictationMessage(mgr, { type: 'dictation:chunk', payload: { id: 'ok', offset: 64 * 1024 * 1024, data: 'AAAA' } }, send);
  assert.ok(out.some((m) => m.type === 'dictation:error'));
  assert.strictEqual(handleDictationMessage(mgr, { type: 'terminal:input', payload: {} }, send), false);
});
