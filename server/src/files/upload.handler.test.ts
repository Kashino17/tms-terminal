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
  const caps = await fetch(`${base}/files/upload?caps=1`);
  assert.deepStrictEqual(await caps.json(), { parts: true }, 'Faehigkeits-Abfrage');
});

test('Stueck-Modus (Base64 ueber die App): Teile werden angehaengt, final benennt um', async () => {
  const content = Buffer.from('Hallo vom Handy — in drei Stücken!');
  const parts = [content.subarray(0, 10), content.subarray(10, 20), content.subarray(20)];
  const base = { dir, name: 'stueck.txt', up: 'abcd-1234', enc: 'b64' };
  const r0 = await up({ ...base, part: '0' }, parts[0].toString('base64'));
  assert.strictEqual(r0.status, 200);
  assert.strictEqual(((await r0.json()) as any).size, 10);
  assert.ok(!fs.existsSync(path.join(dir, 'stueck.txt')), 'vor final keine sichtbare Datei');
  await up({ ...base, part: '1' }, parts[1].toString('base64'));
  const r2 = await up({ ...base, part: '2', final: '1' }, parts[2].toString('base64'));
  const d = await r2.json() as any;
  assert.strictEqual(d.name, 'stueck.txt');
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'stueck.txt')), content);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tms-upload')), 'keine Zwischendatei uebrig');
  // Fortsetzung ohne Anfang / kaputte Kennung
  assert.strictEqual((await up({ ...base, up: 'zzzz-9999', part: '1' }, 'eA==')).status, 409);
  assert.strictEqual((await up({ ...base, up: '../x', part: '0' }, 'eA==')).status, 400);
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
