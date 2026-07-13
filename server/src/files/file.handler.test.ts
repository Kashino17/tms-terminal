import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleFileDownload, handleRename } from './file.handler';

let server: http.Server;
let base = '';
let dir = '';

before(async () => {
  // Test files must live inside the home directory (isWithinHome check).
  dir = fs.mkdtempSync(path.join(os.homedir(), '.tms-explorer-test-'));
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from('0123456789'));
  server = http.createServer((req, res) => {
    if (req.url!.startsWith('/files/download')) return handleFileDownload(req, res);
    if (req.url!.startsWith('/files/rename')) return void handleRename(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const dl = (range?: string) => fetch(
  `${base}/files/download?path=${encodeURIComponent(path.join(dir, 'data.bin'))}`,
  range ? { headers: { Range: range } } : undefined,
);

test('ohne Range: 200, volle Datei, Accept-Ranges', async () => {
  const r = await dl();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual(await r.text(), '0123456789');
});

test('mit Range: 206 + Content-Range + Teilinhalt', async () => {
  const r = await dl('bytes=2-5');
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.strictEqual(r.headers.get('content-length'), '4');
  assert.strictEqual(await r.text(), '2345');
});

test('offene Range: 206 bis Dateiende', async () => {
  const r = await dl('bytes=7-');
  assert.strictEqual(r.status, 206);
  assert.strictEqual(await r.text(), '789');
});

test('unsatisfiable Range: 416 + bytes */TOTAL', async () => {
  const r = await dl('bytes=99-');
  assert.strictEqual(r.status, 416);
  assert.strictEqual(r.headers.get('content-range'), 'bytes */10');
});

const rename = (p: string, name: string) => fetch(`${base}/files/rename`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: p, name }),
});

test('rename: benennt Datei um', async () => {
  const src = path.join(dir, 'alt.txt');
  fs.writeFileSync(src, 'x');
  const r = await rename(src, 'neu.txt');
  assert.strictEqual(r.status, 200);
  assert.ok(fs.existsSync(path.join(dir, 'neu.txt')));
  assert.ok(!fs.existsSync(src));
});

test('rename: Konflikt -> 409', async () => {
  const a = path.join(dir, 'a.txt'); const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
  assert.strictEqual((await rename(a, 'b.txt')).status, 409);
});

test('rename: Name mit Slash -> 400', async () => {
  const c = path.join(dir, 'c.txt');
  fs.writeFileSync(c, 'c');
  assert.strictEqual((await rename(c, '../evil')).status, 400);
});

test('rename: ausserhalb Home -> 403', async () => {
  assert.strictEqual((await rename('/etc/hosts', 'x')).status, 403);
});
