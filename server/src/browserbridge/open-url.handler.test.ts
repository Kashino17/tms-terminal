import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOpenUrl } from './open-url.handler';
import { browserBridge } from './browserbridge.manager';

const good = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ url: 'https://vercel.com/o', sessionId: 's1', secret: browserBridge.secret, ...extra });

test('rejects non-loopback caller', () => {
  const r = handleOpenUrl(good(), '100.64.0.9');
  assert.equal(r.status, 403);
});

test('rejects bad secret', () => {
  const r = handleOpenUrl(JSON.stringify({ url: 'https://x', sessionId: 's', secret: 'nope' }), '127.0.0.1');
  assert.equal(r.status, 403);
});

test('rejects non-forwardable url', () => {
  const r = handleOpenUrl(good({ url: '/tmp/f' }), '127.0.0.1');
  assert.equal(r.status, 400);
});

test('enabled+connected -> handled', () => {
  browserBridge.setEnabled(true);
  browserBridge.setNotifier(() => {});
  const r = handleOpenUrl(good(), '127.0.0.1');
  assert.deepEqual(r.json, { action: 'handled' });
});

test('disabled -> local', () => {
  browserBridge.setEnabled(false);
  const r = handleOpenUrl(good(), '::1');
  assert.deepEqual(r.json, { action: 'local' });
});
