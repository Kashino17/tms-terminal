import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleFileUpload, safeUploadName, uniqueTarget } from './upload.handler';

let server: http.Server;
let base = '';
let dir = '';

before(async () => {
  // Muss im Home-Ordner liegen (isWithinHome).
  dir = fs.mkdtempSync(path.join(os.homedir(), '.tms-upload-test-'));
  server = http.createServer((req, res) => {
    if (req.url!.startsWith('/files/upload')) return handleFileUpload(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const up = (q: Record<string, string>, body: string | Buffer, method = 'POST') =>
  fetch(`${base}/files/upload?${new URLSearchParams(q)}`, { method, body: method === 'POST' ? body : undefined });

test('legt die Datei im Zielordner ab (Ordner wird angelegt), mit CORS-Kopf', async () => {
  const target = path.join(dir, 'neu', 'ordner');
  const r = await up({ dir: target, name: 'bericht.pdf' }, Buffer.from('PDFDATA'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  const d = await r.json() as any;
  assert.strictEqual(d.name, 'bericht.pdf');
  assert.strictEqual(fs.readFileSync(path.join(target, 'bericht.pdf'), 'utf8'), 'PDFDATA');
});

test('vorhandene Datei wird nicht ueberschrieben: "name (2).ext"', async () => {
  await up({ dir, name: 'foto.jpg' }, 'eins');
  const r = await up({ dir, name: 'foto.jpg' }, 'zwei');
  const d = await r.json() as any;
  assert.strictEqual(d.name, 'foto (2).jpg');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'foto.jpg'), 'utf8'), 'eins');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'foto (2).jpg'), 'utf8'), 'zwei');
});

test('Pfad im Namen wird entschaerft (kein Ausbruch aus dem Ordner)', async () => {
  const r = await up({ dir, name: '../../boese.txt' }, 'x');
  const d = await r.json() as any;
  assert.strictEqual(path.dirname(d.path), dir);
  assert.strictEqual(d.name, 'boese.txt');
});

test('ausserhalb des Home-Ordners und gesperrte Pfade: 403', async () => {
  assert.strictEqual((await up({ dir: '/tmp', name: 'a.txt' }, 'x')).status, 403);
  assert.strictEqual((await up({ dir: '~/.ssh', name: 'a.txt' }, 'x')).status, 403);
});

test('ohne Namen: 400; OPTIONS: 204 mit CORS', async () => {
  assert.strictEqual((await up({ dir }, 'x')).status, 400);
  const o = await fetch(`${base}/files/upload`, { method: 'OPTIONS' });
  assert.strictEqual(o.status, 204);
  assert.strictEqual(o.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual(o.headers.get('access-control-allow-private-network'), 'true');
});

test('safeUploadName / uniqueTarget', () => {
  assert.strictEqual(safeUploadName('C:\\Users\\x\\a:b?.txt'), 'a_b_.txt');
  assert.strictEqual(safeUploadName('   '), 'datei');
  assert.strictEqual(safeUploadName('.hidden'), '.hidden');
  fs.writeFileSync(path.join(dir, 'u.txt'), '');
  fs.writeFileSync(path.join(dir, 'u (2).txt'), '');
  assert.strictEqual(path.basename(uniqueTarget(dir, 'u.txt')), 'u (3).txt');
  assert.strictEqual(path.basename(uniqueTarget(dir, 'frei.txt')), 'frei.txt');
});
