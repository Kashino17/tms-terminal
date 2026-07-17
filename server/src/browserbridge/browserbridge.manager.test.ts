import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { browserBridge } from './browserbridge.manager';

test('decideOpen: local when disabled', () => {
  browserBridge.setEnabled(false);
  browserBridge.setNotifier(() => {});
  assert.equal(browserBridge.decideOpen('https://x.com', 's1'), 'local');
});

test('decideOpen: local when no notifier even if enabled', () => {
  browserBridge.setEnabled(true);
  browserBridge.setNotifier(null);
  assert.equal(browserBridge.decideOpen('https://x.com', 's1'), 'local');
});

test('decideOpen: handled + notifies when enabled and connected', () => {
  browserBridge.setEnabled(true);
  const seen: Array<{ url: string; host: string; sessionId: string }> = [];
  browserBridge.setNotifier((ev) => seen.push(ev));
  const r = browserBridge.decideOpen('https://vercel.com/oauth?x=1', 's7');
  assert.equal(r, 'handled');
  assert.deepEqual(seen, [{ url: 'https://vercel.com/oauth?x=1', host: 'vercel.com', sessionId: 's7' }]);
});

test('relayCallback: rejects non-loopback', async () => {
  await assert.rejects(() => browserBridge.relayCallback('https://evil.com/cb'));
});

test('relayCallback: GETs the loopback callback and returns body', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('CLI GOT ' + req.url); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const out = await browserBridge.relayCallback(`http://127.0.0.1:${port}/cb?code=abc`);
  assert.equal(out.status, 200);
  assert.equal(out.html, 'CLI GOT /cb?code=abc');
  srv.close();
});
