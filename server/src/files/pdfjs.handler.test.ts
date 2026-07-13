import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import { handlePdfjsAsset } from './pdfjs.handler';

let server: http.Server; let base = '';
before(async () => {
  server = http.createServer((req, res) => handlePdfjsAsset(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

test('liefert viewer.html mit text/html', async () => {
  const r = await fetch(`${base}/files/pdfjs/web/viewer.html`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await r.text(), /pdf/i);
});

test('Traversal wird geblockt', async () => {
  const r = await fetch(`${base}/files/pdfjs/..%2f..%2fpackage.json`);
  assert.strictEqual(r.status, 403);
});

test('unbekannte Datei -> 404', async () => {
  assert.strictEqual((await fetch(`${base}/files/pdfjs/web/nope.js`)).status, 404);
});
