import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { receiveMedia } from './upload.handler';

// Videos aus der Screenshots-Galerie kommen als multipart/form-data an
// (/upload/media). receiveMedia ist der Teil hinter der Anmeldung.

let server: http.Server;
let base = '';
let dir = '';
const LIMIT = 4 * 1024 * 1024; // klein, damit der Zu-gross-Fall schnell ist

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-media-test-'));
  server = http.createServer((req, res) => {
    receiveMedia(req, res, { dir, defaultExt: '.mp4', label: 'Media', maxBytes: LIMIT });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const send = (name: string, type: string, body: Buffer) => {
  const form = new FormData();
  form.append('file', new Blob([body], { type }), name);
  return fetch(base, { method: 'POST', body: form });
};

const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

test('kleines Video: 200, Datei liegt vollstaendig am gemeldeten Pfad', async () => {
  const body = Buffer.from('kleines-video');
  const r = await send('clip.mp4', 'video/mp4', body);
  const d = await r.json() as any;
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(path.dirname(d.path), dir);
  assert.match(d.filename, /^\d+_clip\.mp4$/);
  assert.deepStrictEqual(fs.readFileSync(d.path), body);
  assert.deepStrictEqual(leftovers(), []);
});

test('grosses Video (mehrere MB): die Antwort kommt erst, wenn alles geschrieben ist', async () => {
  const body = Buffer.alloc(3 * 1024 * 1024, 7);
  const r = await send('lang.mov', 'video/quicktime', body);
  const d = await r.json() as any;
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(fs.statSync(d.path).size, body.length);
  assert.deepStrictEqual(leftovers(), []);
});

test('jede Video-Art wird angenommen (Android liefert auch mkv)', async () => {
  const r = await send('aufnahme.mkv', 'video/x-matroska', Buffer.from('x'));
  assert.strictEqual(r.status, 200);
});

test('Sonderzeichen im Namen werden entschaerft, Endung bleibt', async () => {
  const r = await send('../Mein Video (1).MP4', 'video/mp4', Buffer.from('x'));
  const d = await r.json() as any;
  assert.strictEqual(r.status, 200);
  assert.strictEqual(path.dirname(d.path), dir);
  assert.match(d.filename, /^\d+_Mein_Video__1_\.MP4$/);
});

test('kein Bild und kein Video: 400, nichts bleibt liegen', async () => {
  const before = fs.readdirSync(dir).length;
  const r = await send('skript.sh', 'text/x-shellscript', Buffer.from('rm -rf'));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(fs.readdirSync(dir).length, before);
});

test('ueber der Grenze: 413, keine halbe Datei bleibt liegen', async () => {
  const before = fs.readdirSync(dir).length;
  const r = await send('riesig.mp4', 'video/mp4', Buffer.alloc(LIMIT + 1024, 1));
  assert.strictEqual(r.status, 413);
  assert.strictEqual(fs.readdirSync(dir).length, before);
  assert.deepStrictEqual(leftovers(), []);
});

test('Formular ohne Datei: 400', async () => {
  const form = new FormData();
  form.append('notiz', 'nur text');
  const r = await fetch(base, { method: 'POST', body: form });
  assert.strictEqual(r.status, 400);
});
