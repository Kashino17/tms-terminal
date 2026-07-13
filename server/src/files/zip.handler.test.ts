import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleFileZip } from './zip.handler';

let server: http.Server; let base = ''; let dir = '';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.homedir(), '.tms-zip-test-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'inner.txt'), 'inner');
  fs.writeFileSync(path.join(dir, 'top.txt'), 'top');
  server = http.createServer((req, res) => void handleFileZip(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const zip = (paths: string[]) =>
  fetch(`${base}/files/zip?paths=${encodeURIComponent(JSON.stringify(paths))}`);

test('zip: streamt Ordner+Datei als application/zip', async () => {
  const r = await zip([path.join(dir, 'sub'), path.join(dir, 'top.txt')]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50); // ZIP local file header magic
  assert.ok(buf.length > 100);
});

test('zip: Pfad ausserhalb Home -> 403', async () => {
  assert.strictEqual((await zip(['/etc'])).status, 403);
});

test('zip: Sperrpfad -> 403', async () => {
  assert.strictEqual((await zip([path.join(os.homedir(), '.ssh')])).status, 403);
});

test('zip: leere/kaputte paths -> 400', async () => {
  assert.strictEqual((await zip([])).status, 400);
  const r = await fetch(`${base}/files/zip?paths=notjson`);
  assert.strictEqual(r.status, 400);
});
