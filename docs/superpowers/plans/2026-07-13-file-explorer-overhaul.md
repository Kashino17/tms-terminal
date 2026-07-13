# File-Explorer-Overhaul (Season 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Nutzer-Präferenz:** Implementierung im Hauptkontext (inline, executing-plans), KEINE Subagents.

**Goal:** Vollbild-Datei-Explorer im Liquid-Deck-Look mit Viewern (Bild/Video-Streaming bis 2 GB/PDF/Markdown), echten Downloads in den Android-Downloads-Ordner (auch Ordner/Bulk als ZIP), Bulk-Auswahl, Pfad kopieren und „im Terminal öffnen“.

**Architecture:** Das Mockup ist die App (Season 2): neuer `data-screen="files"` in `mockups/season2/liquid-deck/index.html` mit Demo-Datenschicht; `bridge.js` überschreibt die Datenschicht (`window.fs*`-Hooks) und postet Aktionen an React Native (`useFileExplorer.ts`, neu). Der Server bekommt HTTP-Range-Streaming, `/files/zip`, `/files/rename` und hostet einen pdf.js-Viewer.

**Tech Stack:** Node/TypeScript (node:test via ts-node), archiver, pdf.js (generic build), Vanilla-JS-Mockup, React Native/Expo (expo-file-system SAF).

**Spec:** `docs/superpowers/specs/2026-07-13-file-explorer-overhaul-design.md`

## Global Constraints

- **Zwei Worktrees:** Mockup + Docs in `/Users/ayysir/Desktop/TMS Terminal` (branch `master`, iCloud → **git nur per Plumbing**: `hash-object`/`update-index`/`write-tree`/`commit-tree`/`update-ref`). Server + Bridge + RN in `/Users/ayysir/Desktop/tms-terminal` (branch `feat/manager-chat-redesign`, normales git).
- **Server niemals neu starten** — die aktuelle Claude-Sitzung läuft im TMS-Server-PTY; Neustart macht der Nutzer. Nur bauen (`tsc`), nie `tms-terminal restart` o. ä.
- **Das Ja/Nein-Prompt-Muster des Auto-Approve nie wörtlich in Terminal-Ausgaben schreiben** (Detektor liest die eigene Ausgabe).
- UI-Strings **deutsch**, Code/Kommentare **englisch**.
- **Keine neuen nativen RN-Abhängigkeiten** (kein expo-video, kein react-native-pdf). Server-Dependency `archiver` ist erlaubt.
- Sicherheitsmodell unverändert: `isWithinHome` + `isDeniedPath` bei JEDEM neuen Endpoint pro Pfad; Löschen = Papierkorb.
- Server-Tests: `cd /Users/ayysir/Desktop/tms-terminal/server && npm test` (node:test, Pattern `src/**/*.test.ts`).
- Bei `MODULE_NOT_FOUND` nach `tsc`: `rm server/.tsbuildinfo` und neu bauen (bekannte Falle).
- `mobile/src/season2/web/liquidDeckHtml.ts` NIE von Hand editieren — immer `npm run build:season2`.

---

### Task 1: Server — Range-Parsing-Util (TDD)

**Files:**
- Create: `/Users/ayysir/Desktop/tms-terminal/server/src/files/range.util.ts`
- Test: `/Users/ayysir/Desktop/tms-terminal/server/src/files/range.util.test.ts`

**Interfaces:**
- Produces: `parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null` — `null` = Header ignorieren (volle Antwort, 200), `'unsatisfiable'` = 416, sonst inklusives Byte-Fenster. Task 2 konsumiert das.

- [ ] **Step 1: Failing Test schreiben**

```ts
// server/src/files/range.util.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseRange } from './range.util';

test('kein Header -> null (volle Antwort)', () => {
  assert.strictEqual(parseRange(undefined, 100), null);
});

test('normale Range', () => {
  assert.deepStrictEqual(parseRange('bytes=0-49', 100), { start: 0, end: 49 });
});

test('offene Range bis Dateiende', () => {
  assert.deepStrictEqual(parseRange('bytes=50-', 100), { start: 50, end: 99 });
});

test('Suffix-Range (letzte N Bytes)', () => {
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
});

test('Suffix groesser als Datei wird gekappt', () => {
  assert.deepStrictEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
});

test('Ende ueber Dateiende wird gekappt', () => {
  assert.deepStrictEqual(parseRange('bytes=10-9999', 100), { start: 10, end: 99 });
});

test('Start hinter Dateiende -> unsatisfiable (416)', () => {
  assert.strictEqual(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=200-300', 100), 'unsatisfiable');
});

test('Multi-Range wird ignoriert -> null (RFC: MAY ignore)', () => {
  assert.strictEqual(parseRange('bytes=0-1,5-6', 100), null);
});

test('kaputte Syntax wird ignoriert -> null', () => {
  assert.strictEqual(parseRange('bytes=abc', 100), null);
  assert.strictEqual(parseRange('items=0-5', 100), null);
  assert.strictEqual(parseRange('bytes=-', 100), null);
});

test('leere Datei: jede Range unsatisfiable', () => {
  assert.strictEqual(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=-5', 0), 'unsatisfiable');
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd /Users/ayysir/Desktop/tms-terminal/server && node --require ts-node/register --test src/files/range.util.test.ts`
Expected: FAIL — `Cannot find module './range.util'`

- [ ] **Step 3: Implementierung**

```ts
// server/src/files/range.util.ts
export interface ByteRange { start: number; end: number; }

/**
 * Parse an HTTP Range header against a file size.
 * Returns null when the header should be ignored (serve full 200),
 * 'unsatisfiable' for syntactically valid but unservable ranges (416),
 * or an inclusive byte window.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;                      // malformed or multi-range: ignore
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {                    // suffix: last N bytes
    const n = parseInt(rawEnd, 10);
    if (n <= 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = parseInt(rawStart, 10);
  const end = rawEnd === '' ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
```

- [ ] **Step 4: Test laufen lassen — muss grün sein**

Run: `node --require ts-node/register --test src/files/range.util.test.ts`
Expected: alle Tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ayysir/Desktop/tms-terminal
git add server/src/files/range.util.ts server/src/files/range.util.test.ts
git commit -m "feat(server): HTTP-Range-Parsing für Datei-Streaming"
```

---

### Task 2: Server — Range-Streaming + MIME-Erweiterung im Download

**Files:**
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/files/file.handler.ts` (Funktion `handleFileDownload`, ca. Zeile 126–173, und `MIME_MAP`)
- Test: `/Users/ayysir/Desktop/tms-terminal/server/src/files/file.handler.test.ts` (neu)

**Interfaces:**
- Consumes: `parseRange` aus Task 1.
- Produces: `GET /files/download` antwortet mit `Accept-Ranges: bytes`; bei `Range`-Header `206` + `Content-Range: bytes S-E/TOTAL`; `416` + `Content-Range: bytes */TOTAL` bei unsatisfiable. Verhalten ohne Range unverändert (200).

- [ ] **Step 1: Failing Test schreiben** — Test startet einen echten `http.Server` auf Port 0 und nutzt globales `fetch` (Node 20). Testdateien liegen in einem Temp-Ordner **im Home** (Pflicht wegen `isWithinHome`), Cleanup im `after`-Hook.

```ts
// server/src/files/file.handler.test.ts
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
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `node --require ts-node/register --test src/files/file.handler.test.ts`
Expected: FAIL — `handleRename` existiert nicht (Import-Fehler). Für diesen Task: `handleRename`-Import + Route temporär auskommentieren und erneut laufen lassen → FAIL bei `206`-Tests (bekommt 200). (Task 3 liefert `handleRename`, dann Import wieder rein.)

- [ ] **Step 3: `handleFileDownload` umbauen + MIME_MAP erweitern**

In `file.handler.ts` oben ergänzen: `import { parseRange } from './range.util';`

`MIME_MAP` um diese Einträge erweitern:

```ts
  mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/mp4',
  m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  md: 'text/markdown', heic: 'image/heic', zip: 'application/zip',
```

Den Body von `handleFileDownload` ab `const stat = ...` ersetzen durch:

```ts
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return err(res, 400, 'Cannot download directory');

    const filename = path.basename(filePath);
    const mime = getMimeType(filename);
    const isInline = mime.startsWith('image/') || mime.startsWith('video/')
      || mime.startsWith('audio/') || mime === 'application/pdf';
    const safeFilename = filename.replace(/"/g, '\\"');

    const range = parseRange(req.headers.range as string | undefined, stat.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename="${safeFilename}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'max-age=300',
    };

    let stream: fs.ReadStream;
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      res.writeHead(206, headers);
      stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    } else {
      headers['Content-Length'] = String(stat.size);
      res.writeHead(200, headers);
      stream = fs.createReadStream(filePath);
    }
    stream.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      else { res.destroy(); }
    });
    stream.pipe(res);
```

(Beachte: `isInline` umfasst jetzt auch video/audio — nötig, damit `<video>`/`<audio>` im WebView abspielen statt Download auszulösen.)

- [ ] **Step 4: Tests laufen lassen**

Run: `node --require ts-node/register --test src/files/file.handler.test.ts src/files/range.util.test.ts`
Expected: alle Range-Tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/files/file.handler.ts server/src/files/file.handler.test.ts
git commit -m "feat(server): Range-Streaming (206) + Video/Audio-MIME für den Datei-Download"
```

---

### Task 3: Server — POST /files/rename

**Files:**
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/files/file.handler.ts` (Ende der Datei)
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/index.ts` (Route, im `/files/`-Block bei den anderen POST-Routen, ca. Zeile 155–157)
- Test: `/Users/ayysir/Desktop/tms-terminal/server/src/files/file.handler.test.ts` (erweitern)

**Interfaces:**
- Produces: `POST /files/rename` mit Body `{ path: string, name: string }` → `200 { success: true, path: <neuerPfad> }`, `409` bei Zielkonflikt, `400` bei ungültigem Namen, `403` bei Sperrpfad/außerhalb Home. Task 12 (RN) konsumiert das.

- [ ] **Step 1: Failing Tests ergänzen** (in `file.handler.test.ts`; `handleRename`-Import aus Task 2 wieder aktivieren)

```ts
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
```

- [ ] **Step 2: Test laufen lassen** — FAIL (Import/404)

- [ ] **Step 3: Handler implementieren** (ans Ende von `file.handler.ts`)

```ts
// ── POST /files/rename ────────────────────────────────────────────────

export async function handleRename(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const raw: string = body?.path;
    const name: string = body?.name;
    if (!raw || !name) return err(res, 400, 'path and name required');
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return err(res, 400, 'Invalid name');
    }

    const src = resolvePath(raw);
    if (!isWithinHome(src)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(src)) return err(res, 403, 'Access denied: sensitive path');
    if (!fs.existsSync(src)) return err(res, 400, 'Path not found');

    const target = path.join(path.dirname(src), name);
    if (!isWithinHome(target)) return err(res, 403, 'Access denied: target is outside home directory');
    if (isDeniedPath(target)) return err(res, 403, 'Access denied: sensitive target path');
    if (fs.existsSync(target)) return err(res, 409, 'A file or directory with that name already exists');

    fs.renameSync(src, target);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: target }));
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}
```

Route in `index.ts` (Import erweitern + Zeile neben `/files/trash`):

```ts
else if (req.url.startsWith('/files/rename') && req.method === 'POST') handleRename(req, res);
```

- [ ] **Step 4: Tests laufen lassen** — alle PASS
- [ ] **Step 5: Commit**

```bash
git add server/src/files/file.handler.ts server/src/files/file.handler.test.ts server/src/index.ts
git commit -m "feat(server): /files/rename — Umbenennen mit Konflikt- und Pfad-Checks"
```

---

### Task 4: Server — GET /files/zip (Ordner/Bulk als ZIP-Stream)

**Files:**
- Create: `/Users/ayysir/Desktop/tms-terminal/server/src/files/zip.handler.ts`
- Test: `/Users/ayysir/Desktop/tms-terminal/server/src/files/zip.handler.test.ts`
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/index.ts` (Route)
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/package.json` (Dependency)

**Interfaces:**
- Produces: `GET /files/zip?paths=<url-encodiertes JSON-Array>` → `200 application/zip` (Stream, `Content-Disposition: attachment; filename="tms-<name>.zip"`), `413` wenn Rohdaten-Summe > 4 GB, `403/400` wie üblich. Task 12 baut die URL.

- [ ] **Step 1: Dependency installieren**

```bash
cd /Users/ayysir/Desktop/tms-terminal/server
npm install archiver && npm install --save-dev @types/archiver
```

- [ ] **Step 2: Failing Test schreiben**

```ts
// server/src/files/zip.handler.test.ts
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
```

- [ ] **Step 3: Test laufen lassen** — FAIL (Modul fehlt)

- [ ] **Step 4: Implementierung**

```ts
// server/src/files/zip.handler.ts
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import archiver from 'archiver';

const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB raw-data guard

function resolvePath(raw: string): string {
  if (raw === '~' || raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(1));
  return path.resolve(raw);
}
function isWithinHome(resolved: string): boolean {
  const home = os.homedir();
  const n = path.resolve(resolved);
  return n === home || n.startsWith(home + path.sep);
}
const DENIED = ['.tms-terminal', '.ssh', '.gnupg', '.aws', '.config/gcloud', '.env', '.netrc', '.npmrc'];
function isDeniedPath(resolved: string): boolean {
  const rel = path.relative(os.homedir(), resolved);
  return DENIED.some((d) => rel === d || rel.startsWith(d + path.sep));
}
function err(res: http.ServerResponse, status: number, msg: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

/** Raw byte total of a file/dir tree; symlinks are skipped (no loops). */
async function sizeOf(p: string): Promise<number> {
  const st = await fsp.lstat(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fsp.readdir(p)) total += await sizeOf(path.join(p, e));
  return total;
}

export async function handleFileZip(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url!, 'http://localhost');
    let paths: string[];
    try { paths = JSON.parse(url.searchParams.get('paths') ?? ''); }
    catch { return err(res, 400, 'paths must be a JSON array'); }
    if (!Array.isArray(paths) || paths.length === 0) return err(res, 400, 'paths array required');

    const resolved: string[] = [];
    for (const raw of paths) {
      const p = resolvePath(String(raw));
      if (!isWithinHome(p)) return err(res, 403, `Access denied: "${raw}" is outside home directory`);
      if (isDeniedPath(p)) return err(res, 403, `Access denied: sensitive path "${raw}"`);
      if (!fs.existsSync(p)) return err(res, 400, `Path not found: ${raw}`);
      resolved.push(p);
    }

    let total = 0;
    for (const p of resolved) total += await sizeOf(p);
    if (total > MAX_ZIP_BYTES) return err(res, 413, 'Zu groß (> 4 GB) — bitte einzeln laden');

    const zipName = (resolved.length === 1
      ? `tms-${path.basename(resolved[0])}` : 'tms-auswahl').replace(/"/g, '') + '.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
    });

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => res.destroy());
    res.on('close', () => archive.destroy());
    archive.pipe(res);
    for (const p of resolved) {
      if (fs.statSync(p).isDirectory()) archive.directory(p, path.basename(p));
      else archive.file(p, { name: path.basename(p) });
    }
    await archive.finalize();
  } catch (e: unknown) {
    if (!res.headersSent) err(res, 400, e instanceof Error ? e.message : String(e));
    else res.destroy();
  }
}
```

Route in `index.ts` (Import + Zeile im `/files/`-Block):

```ts
import { handleFileZip } from './files/zip.handler';
// …
else if (req.url.startsWith('/files/zip')) handleFileZip(req, res);
```

- [ ] **Step 5: Tests laufen lassen** — alle PASS
- [ ] **Step 6: Commit**

```bash
git add server/src/files/zip.handler.ts server/src/files/zip.handler.test.ts server/src/index.ts server/package.json server/package-lock.json
git commit -m "feat(server): /files/zip — Ordner & Mehrfachauswahl als ZIP-Stream (4-GB-Limit)"
```

---

### Task 5: Server — pdf.js-Viewer hosten (`/files/pdfjs/…`)

**Files:**
- Create: `/Users/ayysir/Desktop/tms-terminal/server/assets/pdfjs/` (pdf.js generic build, ausgecheckt ins Repo)
- Create: `/Users/ayysir/Desktop/tms-terminal/server/src/files/pdfjs.handler.ts`
- Test: `/Users/ayysir/Desktop/tms-terminal/server/src/files/pdfjs.handler.test.ts`
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/index.ts` (Route VOR der Token-Prüfung im `/files/`-Block)

**Interfaces:**
- Produces: `GET /files/pdfjs/web/viewer.html?file=<same-origin-download-url>` — statische Viewer-Assets, **ohne Token** (nur Assets, keine Nutzerdaten; das PDF selbst kommt tokenpflichtig über `/files/download`). Task 11 baut die URL.

- [ ] **Step 1: pdf.js generic build holen** (legacy-Build für breite WebView-Kompatibilität, Version pinnen)

```bash
cd /private/tmp
curl -fLO https://github.com/mozilla/pdf.js/releases/download/v4.5.136/pdfjs-4.5.136-legacy-dist.zip
mkdir -p /Users/ayysir/Desktop/tms-terminal/server/assets/pdfjs
unzip -q pdfjs-4.5.136-legacy-dist.zip -d /Users/ayysir/Desktop/tms-terminal/server/assets/pdfjs
ls /Users/ayysir/Desktop/tms-terminal/server/assets/pdfjs
```

Expected: `build/ web/ LICENSE` — `web/viewer.html` existiert. (Falls die URL 404 liefert: auf der pdf.js-Releases-Seite die nächstliegende 4.x-`-legacy-dist.zip` nehmen und die Version im Commit-Text nennen.)

- [ ] **Step 2: Failing Test schreiben**

```ts
// server/src/files/pdfjs.handler.test.ts
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
```

- [ ] **Step 3: Test laufen lassen** — FAIL

- [ ] **Step 4: Implementierung**

```ts
// server/src/files/pdfjs.handler.ts
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

// Works from ts-node (server/src/files) and from dist (dist/server/src/files).
function pdfjsRoot(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'pdfjs'),
    path.join(__dirname, '..', '..', '..', '..', 'assets', 'pdfjs'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', mjs: 'text/javascript', js: 'text/javascript',
  css: 'text/css', svg: 'image/svg+xml', png: 'image/png', gif: 'image/gif',
  json: 'application/json', map: 'application/json', wasm: 'application/wasm',
  bcmap: 'application/octet-stream', properties: 'text/plain', ttf: 'font/ttf',
  pfb: 'application/octet-stream', cur: 'image/x-icon', ico: 'image/x-icon',
};

export function handlePdfjsAsset(req: http.IncomingMessage, res: http.ServerResponse): void {
  const root = pdfjsRoot();
  if (!root) { res.writeHead(503); res.end('pdf.js assets missing'); return; }

  const rel = decodeURIComponent(
    (req.url ?? '').replace(/^\/files\/pdfjs\//, '').split('?')[0],
  );
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = resolved.split('.').pop()?.toLowerCase() ?? '';
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(resolved).pipe(res);
}
```

In `index.ts` im `/files/`-Block als ERSTE Zeile (vor der Token-Extraktion):

```ts
      // pdf.js viewer assets are public statics — the PDF itself still needs
      // the token via /files/download.
      if (req.url.startsWith('/files/pdfjs/')) { handlePdfjsAsset(req, res); return; }
```

- [ ] **Step 5: Tests laufen lassen** — PASS
- [ ] **Step 6: Commit** (Assets + Code; pdf.js ist ~10 MB — bewusst im Repo, damit `npm install -g` sie mitbringt)

```bash
git add server/assets/pdfjs server/src/files/pdfjs.handler.ts server/src/files/pdfjs.handler.test.ts server/src/index.ts
git commit -m "feat(server): pdf.js-Viewer v4.5.136 unter /files/pdfjs — PDF-Anzeige ohne App-Ballast"
```

---

### Task 6: Server — Text-Vorschau-Limit 5 MB + Gesamtbuild

**Files:**
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/files/file.handler.ts` (Zeile `if (stat.size > 2 * 1024 * 1024)`)

- [ ] **Step 1: Test ergänzen** (in `file.handler.test.ts`; Route `handleFileRead` im Test-Server registrieren wie die anderen)

```ts
import { handleFileRead } from './file.handler'; // Import oben ergänzen
// im before(): if (req.url!.startsWith('/files/read')) return void handleFileRead(req, res);

test('read: 3-MB-Textdatei ist jetzt erlaubt', async () => {
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'a'.repeat(3 * 1024 * 1024));
  const r = await fetch(`${base}/files/read?path=${encodeURIComponent(big)}`);
  assert.strictEqual(r.status, 200);
});
```

- [ ] **Step 2: Test laufen lassen** — FAIL (400 „File too large“)
- [ ] **Step 3: Limit ändern**

```ts
    if (stat.size > 5 * 1024 * 1024) return err(res, 400, 'File too large to preview (>5 MB)');
```

- [ ] **Step 4: KOMPLETTE Testsuite + Build**

```bash
npm test
rm -f .tsbuildinfo && npm run build
```
Expected: alle Tests PASS, `tsc` ohne Fehler. **Server NICHT neu starten** (macht der Nutzer bewusst — killt sonst diese Sitzung).

- [ ] **Step 5: Commit**

```bash
git add server/src/files/file.handler.ts server/src/files/file.handler.test.ts
git commit -m "feat(server): Text-Vorschau bis 5 MB"
```

---

### Task 7: Mockup — Files-Screen Grundgerüst (Liste, Breadcrumbs, Sortierung, Suche)

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
  - CSS-Block nach den Browser-Screen-Styles (nach ca. Zeile 1071)
  - `<section data-screen="files" hidden></section>` nach der browser-Section (ca. Zeile 1255)
  - JS-Modul nach `openToolSheet` (nach ca. Zeile 3926)
  - Tools-Grid-Click-Handler (ca. Zeile 3901–3909): `files`-Tile → Screen

**Interfaces:**
- Produces (überschreibbar durch bridge.js, Task 11):
  - `window.fsListDir(path: string): void` — fordert Verzeichnis an; Antwort kommt via `window.fsSetDir`.
  - `window.fsSetDir(path: string, entries: Array<{name, path, isDir, size, modified}>): void` — setzt Zustand + rendert.
  - `window.fsFileUrl(path) -> string` (Demo: ''), `window.fsPdfUrl(path) -> string` (Demo: '')
  - `window.fsReadFile(path): void` + `window.fsSetFileContent(path, content, error)` — Text/Markdown-Inhalt.
  - `window.fsAction(action: string, payload: object): void` — Demo: Toast.
  - `window.openFilesScreen(path?: string): void`, `window.fsRerender(): void`
- Consumes: vorhandene Mockup-Helfer `show(name)`, `SCREEN_HOOKS`, `icon(name,size)`, `toast(msg)`, `escapeHtml`.

- [ ] **Step 1: CSS einfügen** (nach den `[data-screen="browser"]`-Styles)

```css
  /* ── Files screen ─────────────────────────────────────────── */
  section[data-screen="files"]:not([hidden]) { display: flex; flex-direction: column; overflow: hidden; }
  .fs-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px 4px; }
  .fs-crumbs { flex: 1; display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
  .fs-crumbs::-webkit-scrollbar { display: none; }
  .fs-crumb { background: none; border: 0; color: var(--text); font: inherit; font-size: 12.5px; padding: 4px 5px; border-radius: 8px; opacity: .75; }
  .fs-crumb:last-child { opacity: 1; font-weight: 700; }
  .fs-crumb-sep { opacity: .35; font-size: 11px; }
  .fs-tools { display: flex; gap: 4px; padding: 2px 12px 6px; align-items: center; }
  .fs-searchrow { padding: 0 12px 6px; }
  .fs-list { flex: 1; overflow-y: auto; padding: 0 8px 120px; -webkit-overflow-scrolling: touch; }
  .fs-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 8px; border: 0; background: none; color: var(--text); font: inherit; text-align: left; border-radius: 14px; }
  .fs-row:active { background: rgba(255,255,255,.06); }
  .fs-row.is-selected { background: rgba(120,160,255,.14); }
  .fs-ico { width: 36px; height: 36px; border-radius: 10px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 800; background: rgba(255,255,255,.06); }
  .fs-thumb { width: 36px; height: 36px; border-radius: 10px; flex: none; object-fit: cover; background: rgba(255,255,255,.06); }
  .fs-cell { flex: 1; min-width: 0; }
  .fs-name { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fs-sub { font-size: 11px; opacity: .55; }
  .fs-check { width: 21px; height: 21px; border-radius: 7px; border: 1.5px solid rgba(255,255,255,.35); flex: none; display: flex; align-items: center; justify-content: center; font-size: 12px; }
  .fs-check.is-on { background: var(--accent, #8ab8ff); border-color: transparent; color: #0b0e14; }
  .fs-bulkbar { position: absolute; left: 12px; right: 12px; bottom: calc(84px + env(safe-area-inset-bottom)); display: flex; gap: 8px; padding: 10px; border-radius: 18px; z-index: 40; }
  .fs-bulkbar .btn-chip { flex: 1; justify-content: center; }
  .fs-dlbar { position: absolute; left: 12px; right: 12px; bottom: calc(84px + env(safe-area-inset-bottom)); padding: 8px 12px; border-radius: 14px; font-size: 12px; z-index: 39; display: flex; align-items: center; gap: 8px; }
  .fs-dlbar progress { flex: 1; height: 4px; }
  .fs-empty { text-align: center; opacity: .5; padding: 40px 0; font-size: 13px; }
```

(Die Bulk-/Download-Leisten nutzen zusätzlich die vorhandene `glass`-Klasse für den Liquid-Look.)

- [ ] **Step 2: Section einfügen** — nach `<section data-screen="browser" hidden></section>`:

```html
  <section data-screen="files" hidden></section>
```

- [ ] **Step 3: JS-Modul einfügen** (direkt nach der `openToolSheet`-Funktion)

```js
  // ============================================================
  // Files screen — fullscreen explorer. Demo data layer below is
  // swapped out by bridge.js in the app (window.fs* hooks).
  // ============================================================
  const FS_TYPE_COLORS = { ts:'#3B82F6', tsx:'#3B82F6', js:'#F59E0B', jsx:'#F59E0B', py:'#22C55E',
    rs:'#EF4444', go:'#06B6D4', html:'#F97316', css:'#3B82F6', json:'#F59E0B', yml:'#F59E0B',
    yaml:'#F59E0B', md:'#8B5CF6', mdx:'#8B5CF6', txt:'#94A3B8', pdf:'#EF4444', sh:'#22C55E',
    png:'#EC4899', jpg:'#EC4899', jpeg:'#EC4899', gif:'#EC4899', webp:'#EC4899', svg:'#F97316',
    mp4:'#A855F7', webm:'#A855F7', mov:'#A855F7', mkv:'#A855F7', mp3:'#06B6D4', wav:'#06B6D4',
    m4a:'#06B6D4', zip:'#F59E0B', gz:'#F59E0B', env:'#F59E0B' };
  const FS_KINDS = {
    img: ['png','jpg','jpeg','gif','webp','svg','ico','bmp','heic'],
    vid: ['mp4','webm','mov','m4v','mkv','avi'],
    aud: ['mp3','wav','m4a','ogg','flac'],
    md:  ['md','mdx'],
    pdf: ['pdf'],
  };
  function fsExt(name) { return (name.split('.').pop() || '').toLowerCase(); }
  function fsKind(name) {
    const e = fsExt(name);
    for (const k in FS_KINDS) if (FS_KINDS[k].indexOf(e) !== -1) return k;
    return 'txt';
  }
  function fsFmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fsFmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    return d.getFullYear() === now.getFullYear()
      ? d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
      : String(d.getFullYear());
  }

  const fsState = {
    cwd: '~', entries: [], sort: 'name', asc: true, filter: '', showSearch: false,
    selectMode: false, sel: new Set(), menuFor: null, renaming: null, newFolder: false,
    downloads: [],  // {id, name, pct, state}
  };

  // ── Demo data layer (bridge.js replaces all four) ──
  const FS_DEMO = {
    '~': [
      { name: 'Desktop', isDir: true }, { name: 'projekt', isDir: true },
      { name: 'notizen.md', isDir: false, size: 2400 },
      { name: 'foto.svg', isDir: false, size: 5200 },
      { name: 'demo.mp4', isDir: false, size: 1288490188 },
      { name: 'report.pdf', isDir: false, size: 312000 },
    ],
    '~/Desktop': [{ name: 'screenshot.svg', isDir: false, size: 8100 }],
    '~/projekt': [
      { name: 'src', isDir: true }, { name: 'README.md', isDir: false, size: 1800 },
      { name: 'server.log', isDir: false, size: 45000 },
    ],
    '~/projekt/src': [{ name: 'index.ts', isDir: false, size: 3200 }],
  };
  const FS_DEMO_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">' +
    '<rect width="240" height="160" rx="16" fill="%23223"/><circle cx="70" cy="66" r="30" fill="%238ab8ff"/>' +
    '<rect x="120" y="46" width="90" height="12" rx="6" fill="%23555"/><rect x="120" y="70" width="70" height="12" rx="6" fill="%23444"/></svg>');
  window.fsListDir = function (path) {
    const list = (FS_DEMO[path] || []).map(e => ({
      name: e.name, isDir: !!e.isDir, size: e.size || 0,
      modified: Date.now() - 86400000,
      path: path.replace(/\/$/, '') + '/' + e.name,
    }));
    window.fsSetDir(path, list);
  };
  window.fsFileUrl = function (path) { return /\.svg$/.test(path) ? FS_DEMO_SVG : ''; };
  window.fsPdfUrl = function () { return ''; };
  window.fsReadFile = function (path) {
    window.fsSetFileContent(path, /\.md$/.test(path)
      ? '# Demo\n\nDies ist **Markdown** aus dem Mockup.\n\n- Punkt eins\n- Punkt zwei\n\n```js\nconsole.log("hi");\n```'
      : 'Demo-Inhalt von ' + path);
  };
  window.fsAction = function (action, payload) { toast('Demo: ' + action); };

  window.fsSetDir = function (path, entries) {
    fsState.cwd = path;
    fsState.entries = entries;
    fsState.sel.clear(); fsState.selectMode = false; fsState.menuFor = null;
    renderFilesScreen();
  };
  window.openFilesScreen = function (path) {
    if (path) fsState.cwd = path;
    show('files');
    window.fsListDir(fsState.cwd);
  };
  window.fsRerender = function () { if (currentScreen === 'files') renderFilesScreen(); };

  function fsSorted() {
    const q = fsState.filter.toLowerCase();
    let list = q ? fsState.entries.filter(e => e.name.toLowerCase().indexOf(q) !== -1) : fsState.entries.slice();
    const dir = fsState.asc ? 1 : -1;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (fsState.sort === 'size') return (a.size - b.size) * dir;
      if (fsState.sort === 'date') return (a.modified - b.modified) * dir;
      return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }) * dir;
    });
    return list;
  }

  function fsCrumbsHtml() {
    const parts = fsState.cwd.split('/').filter(Boolean);
    let acc = '';
    return parts.map((p, i) => {
      acc += (i ? '/' : '') + p;
      const target = acc;
      return (i ? '<span class="fs-crumb-sep">›</span>' : '') +
        '<button class="fs-crumb" data-crumb="' + escapeHtml(target) + '">' + escapeHtml(p) + '</button>';
    }).join('');
  }

  function fsRowHtml(e) {
    const kind = e.isDir ? 'dir' : fsKind(e.name);
    const color = e.isDir ? '#F59E0B' : (FS_TYPE_COLORS[fsExt(e.name)] || '#64748B');
    const url = !e.isDir && kind === 'img' ? window.fsFileUrl(e.path) : '';
    const iconHtml = url
      ? '<img class="fs-thumb" loading="lazy" src="' + escapeHtml(url) + '" onerror="this.outerHTML=\'<span class=&quot;fs-ico&quot;>·</span>\'">'
      : '<span class="fs-ico" style="color:' + color + '">' + (e.isDir ? icon('folder', 16) : fsExt(e.name).slice(0, 3).toUpperCase() || '·') + '</span>';
    const sel = fsState.sel.has(e.path);
    const check = fsState.selectMode
      ? '<span class="fs-check' + (sel ? ' is-on' : '') + '">' + (sel ? '✓' : '') + '</span>' : '';
    return '<div class="fs-rowwrap">' +
      '<button class="fs-row' + (sel ? ' is-selected' : '') + '" data-fspath="' + escapeHtml(e.path) + '" data-fsdir="' + (e.isDir ? 1 : 0) + '">' +
        check + iconHtml +
        '<span class="fs-cell"><span class="fs-name">' + escapeHtml(e.name) + '</span><br>' +
        '<span class="fs-sub">' + (e.isDir ? 'Ordner' : escapeHtml(fsFmtSize(e.size))) +
        (e.modified ? ' · ' + fsFmtDate(e.modified) : '') + '</span></span>' +
        (fsState.selectMode ? '' : '<button class="fx-more" data-fsmenu="' + escapeHtml(e.path) + '">⋯</button>') +
      '</button></div>';
  }

  function renderFilesScreen() {
    const host = document.querySelector('[data-screen="files"]');
    if (!host) return;
    const list = fsSorted();
    const favs = (window.__tmsFavs || []);
    const sortLabel = { name: 'Name', date: 'Datum', size: 'Größe' }[fsState.sort];
    host.innerHTML =
      '<div class="fs-head">' +
        '<button class="btn-chip" data-fsup>▴</button>' +
        '<div class="fs-crumbs">' + fsCrumbsHtml() + '</div>' +
      '</div>' +
      '<div class="fs-tools">' +
        '<button class="btn-chip" data-fssearch>' + icon('search', 13) + '</button>' +
        '<button class="btn-chip" data-fssort>' + escapeHtml(sortLabel) + ' ' + (fsState.asc ? '↑' : '↓') + '</button>' +
        '<button class="btn-chip" data-fsselect>' + (fsState.selectMode ? '✕ Auswahl' : '☑ Auswählen') + '</button>' +
        '<button class="btn-chip" data-fsnewfolder>+ Ordner</button>' +
      '</div>' +
      (fsState.showSearch ? '<div class="fs-searchrow"><input class="term-input" id="fsSearchInput" placeholder="Filtern…" value="' + escapeHtml(fsState.filter) + '"></div>' : '') +
      (fsState.newFolder ? '<div class="fs-searchrow" style="display:flex;gap:6px"><input class="term-input" id="fsNewFolderInput" placeholder="Ordnername…" style="flex:1">' +
        '<button class="btn-chip" data-fsmkdirok>Anlegen</button><button class="btn-chip" data-fscancel>✕</button></div>' : '') +
      (favs.length ? '<div class="fs-tools">' + favs.map(p =>
        '<button class="btn-chip" data-fsgofav="' + escapeHtml(p) + '">★ ' + escapeHtml(p.split('/').pop() || p) + '</button>').join('') + '</div>' : '') +
      '<div class="fs-list">' + (list.length ? list.map(fsRowHtml).join('') : '<div class="fs-empty">Leer.</div>') + '</div>' +
      fsBulkbarHtml() + fsDlbarHtml();
    wireFilesScreen(host);
  }
  function fsBulkbarHtml() { return ''; }   // Task 8 fills this in
  function fsDlbarHtml() { return ''; }     // Task 9 fills this in
  function wireFilesScreen(host) {
    host.querySelectorAll('[data-crumb]').forEach(b => b.addEventListener('click', () => {
      window.fsListDir(b.dataset.crumb.indexOf('~') === 0 ? b.dataset.crumb : '/' + b.dataset.crumb);
    }));
    const up = host.querySelector('[data-fsup]');
    if (up) up.addEventListener('click', () => {
      const p = fsState.cwd.replace(/\/[^/]+\/?$/, '');
      window.fsListDir(p && p !== '~/'.slice(0, p.length) ? p : '~');
    });
    const se = host.querySelector('[data-fssearch]');
    if (se) se.addEventListener('click', () => { fsState.showSearch = !fsState.showSearch; if (!fsState.showSearch) fsState.filter = ''; renderFilesScreen(); if (fsState.showSearch) { const i = document.getElementById('fsSearchInput'); if (i) i.focus(); } });
    const si = host.querySelector('#fsSearchInput');
    if (si) si.addEventListener('input', () => {
      fsState.filter = si.value;
      const lst = host.querySelector('.fs-list');
      const l = fsSorted();
      lst.innerHTML = l.length ? l.map(fsRowHtml).join('') : '<div class="fs-empty">Nichts gefunden.</div>';
      wireFsRows(host);
    });
    const so = host.querySelector('[data-fssort]');
    if (so) so.addEventListener('click', () => {
      const order = ['name', 'date', 'size'];
      if (fsState.asc && fsState.sort === 'name') { fsState.asc = false; }
      else { const i = order.indexOf(fsState.sort); fsState.sort = order[(i + 1) % 3]; fsState.asc = true; }
      renderFilesScreen();
    });
    const sm = host.querySelector('[data-fsselect]');
    if (sm) sm.addEventListener('click', () => { fsState.selectMode = !fsState.selectMode; fsState.sel.clear(); renderFilesScreen(); });
    const nf = host.querySelector('[data-fsnewfolder]');
    if (nf) nf.addEventListener('click', () => { fsState.newFolder = true; renderFilesScreen(); const i = document.getElementById('fsNewFolderInput'); if (i) i.focus(); });
    const ok = host.querySelector('[data-fsmkdirok]');
    if (ok) ok.addEventListener('click', () => {
      const i = document.getElementById('fsNewFolderInput');
      if (i && i.value.trim()) window.fsAction('mkdir', { path: fsState.cwd.replace(/\/$/, '') + '/' + i.value.trim() });
      fsState.newFolder = false; renderFilesScreen();
    });
    const ca = host.querySelector('[data-fscancel]');
    if (ca) ca.addEventListener('click', () => { fsState.newFolder = false; renderFilesScreen(); });
    host.querySelectorAll('[data-fsgofav]').forEach(b => b.addEventListener('click', () => window.fsListDir(b.dataset.fsgofav)));
    wireFsRows(host);
  }
  function wireFsRows(host) {
    host.querySelectorAll('.fs-row').forEach(row => {
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-fsmenu]')) return;
        const p = row.dataset.fspath, isDir = row.dataset.fsdir === '1';
        if (fsState.selectMode) { fsState.sel.has(p) ? fsState.sel.delete(p) : fsState.sel.add(p); renderFilesScreen(); return; }
        if (isDir) window.fsListDir(p);
        else openFsViewer(p);          // Task 9
      });
    });
    host.querySelectorAll('[data-fsmenu]').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openFsRowMenu(b.dataset.fsmenu); // Task 8
    }));
  }
  function openFsViewer(p) { toast('Viewer folgt (Task 9): ' + p.split('/').pop()); }
  function openFsRowMenu(p) { toast('Menü folgt (Task 8)'); }
  SCREEN_HOOKS.files = function () { if (!document.querySelector('[data-screen="files"] .fs-list')) renderFilesScreen(); };
```

- [ ] **Step 4: Tools-Kachel umleiten** — im `grid.addEventListener('click', …)` von `renderTools` vor `openToolSheet(tile.dataset.tool)`:

```js
      if (tile.dataset.tool === 'files') { window.openFilesScreen(); return; }
```

- [ ] **Step 5: Im Browser verifizieren** (Playwright MCP): `file:///Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` laden (Viewport 380×820), PIN-Lock entsperren falls nötig, über Dock „mehr“→Werkzeuge→Dateien navigieren. Screenshot: Liste mit Demo-Einträgen, Breadcrumbs, `▴`-Navigation in `~/projekt/src` und zurück, Sortier-Knopf durchschalten, Suche filtert. Screenshot als `fs-380-screen-list.png` ablegen.

- [ ] **Step 6: Commit (Plumbing — iCloud!)**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
blob=$(git hash-object -w mockups/season2/liquid-deck/index.html)
git update-index --add --cacheinfo 100644,$blob,mockups/season2/liquid-deck/index.html
tree=$(git write-tree)
commit=$(git commit-tree $tree -p HEAD -m "feat(season2): Files-Screen — Vollbild-Explorer Grundgerüst (Liste, Breadcrumbs, Sortierung, Suche)")
git update-ref HEAD $commit
```

---

### Task 8: Mockup — Auswahl-Modus, Bulk-Leiste, Aktionsmenü, Umbenennen, Langdruck

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (Files-Modul aus Task 7)

**Interfaces:**
- Consumes: `fsState`, `renderFilesScreen`, `window.fsAction`.
- Produces: `fsAction`-Aufrufe mit diesen Verträgen (bridge.js implementiert sie in Task 11):
  - `fsAction('copyPath', { paths: string[] })`
  - `fsAction('cd', { path: string })` — bei Dateien schickt das Mockup den ELTERN-Ordner
  - `fsAction('insert', { path: string })`
  - `fsAction('download', { paths: string[], zip: boolean })` — `zip: true` sobald ein Ordner dabei ist oder `paths.length > 1`
  - `fsAction('share', { path: string })`
  - `fsAction('rename', { path: string, name: string })`
  - `fsAction('trash', { paths: string[] })`
  - `fsAction('fav', { path: string })`
  - `fsAction('mkdir', { path: string })` (aus Task 7)

- [ ] **Step 1: Bulk-Leiste implementieren** — `fsBulkbarHtml` ersetzen:

```js
  function fsBulkbarHtml() {
    if (!fsState.selectMode || !fsState.sel.size) return '';
    return '<div class="fs-bulkbar glass">' +
      '<button class="btn-chip" data-fsbulk="download">⇩ Laden (' + fsState.sel.size + ')</button>' +
      '<button class="btn-chip" data-fsbulk="copyPath">Pfade</button>' +
      '<button class="btn-chip btn-chip--danger" data-fsbulk="trash">Löschen</button>' +
      '</div>';
  }
```

In `wireFilesScreen(host)` ergänzen (vor `wireFsRows(host)`):

```js
    host.querySelectorAll('[data-fsbulk]').forEach(b => b.addEventListener('click', () => {
      const paths = Array.from(fsState.sel);
      const hasDir = fsState.entries.some(e => e.isDir && fsState.sel.has(e.path));
      const a = b.dataset.fsbulk;
      if (a === 'download') window.fsAction('download', { paths: paths, zip: hasDir || paths.length > 1 });
      else if (a === 'copyPath') window.fsAction('copyPath', { paths: paths });
      else if (a === 'trash') {
        if (b.dataset.confirmed) {
          window.fsAction('trash', { paths: paths });
          fsState.selectMode = false; fsState.sel.clear();
        } else {
          b.dataset.confirmed = '1';
          b.textContent = paths.length + ' in den Papierkorb?';
          setTimeout(() => { delete b.dataset.confirmed; if (document.contains(b)) renderFilesScreen(); }, 3000);
        }
      }
    }));
```

Außerdem in der Kopf-Werkzeugleiste bei aktivem Auswahl-Modus einen „Alle“-Knopf ergänzen — in `renderFilesScreen` innerhalb `.fs-tools` hinter `data-fsselect`:

```js
      (fsState.selectMode ? '<button class="btn-chip" data-fsselectall>Alle</button>' : '') +
```

und in `wireFilesScreen`:

```js
    const sa = host.querySelector('[data-fsselectall]');
    if (sa) sa.addEventListener('click', () => { fsSorted().forEach(e => fsState.sel.add(e.path)); renderFilesScreen(); });
```

- [ ] **Step 2: Aktionsmenü** — `openFsRowMenu` ersetzen (Bottom-Overlay, nutzt vorhandene Klassen):

```js
  function openFsRowMenu(p) {
    const e = fsState.entries.find(x => x.path === p);
    if (!e) return;
    const old = document.getElementById('fsRowMenu');
    if (old) old.remove();
    const parent = e.isDir ? e.path : e.path.replace(/\/[^/]+$/, '');
    const isFav = (window.__tmsFavs || []).indexOf(p) !== -1;
    const el = document.createElement('div');
    el.id = 'fsRowMenu';
    el.style.cssText = 'position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,.45)';
    el.innerHTML = '<div class="glass" style="border-radius:22px 22px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:6px">' +
      '<div style="font-weight:800;font-size:13px;padding:2px 4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(e.name) + '</div>' +
      (e.isDir ? '' : '<button class="btn-chip" data-m="open">Öffnen</button>') +
      '<button class="btn-chip" data-m="copyPath">Pfad kopieren</button>' +
      '<button class="btn-chip" data-m="cd">Im Terminal öffnen (cd)</button>' +
      '<button class="btn-chip" data-m="insert">In Eingabezeile einfügen</button>' +
      '<button class="btn-chip" data-m="download">Herunterladen' + (e.isDir ? ' (ZIP)' : '') + '</button>' +
      (e.isDir ? '' : '<button class="btn-chip" data-m="share">Teilen</button>') +
      '<button class="btn-chip" data-m="rename">Umbenennen</button>' +
      '<button class="btn-chip" data-m="fav">' + (isFav ? '★ Favorit entfernen' : '☆ Favorit') + '</button>' +
      '<button class="btn-chip btn-chip--danger" data-m="trash">Löschen</button>' +
      '<button class="btn-chip" data-m="close">Abbrechen</button></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-m]');
      if (!btn && ev.target === el) { el.remove(); return; }
      if (!btn) return;
      const m = btn.dataset.m;
      if (m === 'trash' && !btn.dataset.confirmed) {
        btn.dataset.confirmed = '1'; btn.textContent = 'Wirklich in den Papierkorb?'; return;
      }
      el.remove();
      if (m === 'open') openFsViewer(p);
      else if (m === 'copyPath') window.fsAction('copyPath', { paths: [p] });
      else if (m === 'cd') window.fsAction('cd', { path: parent });
      else if (m === 'insert') window.fsAction('insert', { path: p });
      else if (m === 'download') window.fsAction('download', { paths: [p], zip: !!e.isDir });
      else if (m === 'share') window.fsAction('share', { path: p });
      else if (m === 'fav') window.fsAction('fav', { path: p });
      else if (m === 'trash') window.fsAction('trash', { paths: [p] });
      else if (m === 'rename') {
        fsState.renaming = p; renderFilesScreen();
        setTimeout(() => { const i = document.getElementById('fsRenameInput'); if (i) { i.focus(); i.select(); } }, 50);
      }
    });
  }
```

- [ ] **Step 3: Inline-Umbenennen-Zeile** — in `renderFilesScreen` nach der `newFolder`-Zeile:

```js
      (fsState.renaming ? '<div class="fs-searchrow" style="display:flex;gap:6px">' +
        '<input class="term-input" id="fsRenameInput" style="flex:1" value="' + escapeHtml((fsState.renaming.split('/').pop() || '')) + '">' +
        '<button class="btn-chip" data-fsrenameok>Umbenennen</button><button class="btn-chip" data-fscancelrename>✕</button></div>' : '') +
```

in `wireFilesScreen`:

```js
    const ro = host.querySelector('[data-fsrenameok]');
    if (ro) ro.addEventListener('click', () => {
      const i = document.getElementById('fsRenameInput');
      if (i && i.value.trim()) window.fsAction('rename', { path: fsState.renaming, name: i.value.trim() });
      fsState.renaming = null; renderFilesScreen();
    });
    const rc = host.querySelector('[data-fscancelrename]');
    if (rc) rc.addEventListener('click', () => { fsState.renaming = null; renderFilesScreen(); });
```

- [ ] **Step 4: Langdruck startet Auswahl-Modus** — in `wireFsRows` innerhalb des `forEach(row => …)` ergänzen (Muster wie die Dock-Langdruck-Logik, 550 ms):

```js
      let lpTimer = null, lpFired = false;
      row.addEventListener('pointerdown', () => {
        lpFired = false;
        lpTimer = setTimeout(() => {
          lpFired = true;
          if (!fsState.selectMode) { fsState.selectMode = true; fsState.sel.add(row.dataset.fspath); renderFilesScreen(); }
        }, 550);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => row.addEventListener(ev, () => clearTimeout(lpTimer)));
```

und im bestehenden `click`-Handler der Zeile als erste Zeile: `if (lpFired) { lpFired = false; return; }`

- [ ] **Step 5: Im Browser verifizieren** (Playwright): Langdruck simulieren ist unzuverlässig — stattdessen „☑ Auswählen“-Knopf: 2 Einträge anwählen → Bulk-Leiste erscheint mit „⇩ Laden (2)“; „Löschen“ zweimal → Toast „Demo: trash“. ⋯-Menü öffnen → alle 9 Aktionen sichtbar; „Umbenennen“ → Inline-Zeile. Screenshots `fs-380-selection.png`, `fs-380-rowmenu.png`.

- [ ] **Step 6: Commit (Plumbing, wie Task 7 Step 6)** — Message: `feat(season2): Files-Screen — Auswahl-Modus, Bulk-Leiste, Aktionsmenü, Umbenennen`

---

### Task 9: Mockup — Viewer-Overlay (Bild/Video/Audio/Markdown/PDF/Text/Info) + Download-Leiste

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (Files-Modul)

**Interfaces:**
- Consumes: `window.fsFileUrl`, `window.fsPdfUrl`, `window.fsReadFile`/`window.fsSetFileContent`, `window.fsAction`.
- Produces: `window.fsDownloadProgress(id, name, pct, state)` — `state: 'running' | 'done' | 'error'`; bridge ruft das aus `TMSBridge.downloadProgress` (Task 11).

- [ ] **Step 1: Viewer-CSS ergänzen** (an den Files-CSS-Block anhängen)

```css
  .fs-viewer { position: fixed; inset: 0; z-index: 90; background: rgba(5,7,12,.96); display: flex; flex-direction: column; }
  .fs-viewer__bar { display: flex; align-items: center; gap: 8px; padding: calc(10px + env(safe-area-inset-top)) 12px 10px; }
  .fs-viewer__name { flex: 1; min-width: 0; font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fs-viewer__body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: auto; position: relative; }
  .fs-viewer__body img { max-width: 100%; max-height: 100%; touch-action: pinch-zoom; }
  .fs-viewer__body video { width: 100%; max-height: 100%; background: #000; }
  .fs-viewer__body iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  .fs-viewer__nav { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; border: 0; border-radius: 14px; background: rgba(255,255,255,.08); color: var(--text); font-size: 20px; }
  .fs-md, .fs-txt { align-self: stretch; width: 100%; overflow: auto; padding: 4px 16px calc(20px + env(safe-area-inset-bottom)); font-size: 13.5px; line-height: 1.55; }
  .fs-md pre { background: rgba(255,255,255,.07); padding: 10px; border-radius: 10px; overflow-x: auto; }
  .fs-md code { background: rgba(255,255,255,.09); padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, monospace; font-size: 12px; }
  .fs-md h1, .fs-md h2, .fs-md h3 { margin: 14px 0 6px; }
  .fs-md blockquote { border-left: 3px solid var(--accent, #8ab8ff); margin: 8px 0; padding: 2px 10px; opacity: .8; }
  .fs-txt pre { font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.5; }
  .fs-txt .ln { opacity: .35; user-select: none; display: inline-block; min-width: 34px; text-align: right; margin-right: 10px; }
  .fs-infocard { text-align: center; padding: 24px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
```

- [ ] **Step 2: Markdown-Renderer einfügen** (portierte Logik des alten Panels, ins Files-Modul)

```js
  function fsMdToHtml(md) {
    let h = md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>').replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
      .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>').replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>').replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/^---+$/gm, '<hr>')
      .replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
    return h.split(/\n{2,}/).map(b => /^\s*<(h\d|ul|pre|blockquote|hr)/.test(b) ? b : '<p>' + b.replace(/\n/g, '<br>') + '</p>').join('');
  }
```

- [ ] **Step 3: `openFsViewer` implementieren** (Platzhalter aus Task 7 ersetzen)

```js
  let fsViewerReadTarget = null;
  window.fsSetFileContent = function (path, content, error) {
    if (fsViewerReadTarget !== path) return;
    fsViewerReadTarget = null;
    const body = document.querySelector('.fs-viewer__body');
    if (!body) return;
    if (error) { body.innerHTML = fsInfoCardHtml(path, error); wireFsInfoCard(body, path); return; }
    if (fsKind(path.split('/').pop()) === 'md') {
      body.innerHTML = '<div class="fs-md">' + fsMdToHtml(content || '') + '</div>';
      const bar = document.querySelector('.fs-viewer__bar');
      const t = document.createElement('button');
      t.className = 'btn-chip'; t.textContent = 'Quelltext';
      let raw = false;
      t.addEventListener('click', () => {
        raw = !raw; t.textContent = raw ? 'Ansicht' : 'Quelltext';
        body.innerHTML = raw
          ? '<div class="fs-txt"><pre>' + escapeHtml(content || '') + '</pre></div>'
          : '<div class="fs-md">' + fsMdToHtml(content || '') + '</div>';
      });
      bar.insertBefore(t, bar.querySelector('[data-vclose]'));
    } else {
      const lines = (content || '').split('\n');
      body.innerHTML = '<div class="fs-txt"><pre>' + lines.map((l, i) =>
        '<span class="ln">' + (i + 1) + '</span>' + escapeHtml(l)).join('\n') + '</pre></div>';
    }
  };

  function fsInfoCardHtml(p, note) {
    const e = fsState.entries.find(x => x.path === p) || { name: p.split('/').pop(), size: 0 };
    return '<div class="fs-infocard">' +
      '<div style="font-size:34px">🗂</div>' +
      '<div style="font-weight:800">' + escapeHtml(e.name) + '</div>' +
      '<div class="fs-sub">' + escapeHtml(fsFmtSize(e.size)) + (e.modified ? ' · ' + fsFmtDate(e.modified) : '') + '</div>' +
      (note ? '<div class="fs-sub">' + escapeHtml(note) + '</div>' : '') +
      '<div style="display:flex;gap:8px"><button class="btn-chip" data-ic="download">⇩ Herunterladen</button>' +
      '<button class="btn-chip" data-ic="share">Teilen</button></div></div>';
  }
  function wireFsInfoCard(body, p) {
    body.querySelectorAll('[data-ic]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.ic === 'download') window.fsAction('download', { paths: [p], zip: false });
      else window.fsAction('share', { path: p });
    }));
  }

  function openFsViewer(p) {
    const name = p.split('/').pop() || p;
    const kind = fsKind(name);
    const url = window.fsFileUrl(p);
    const old = document.getElementById('fsViewer');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'fs-viewer'; el.id = 'fsViewer';
    el.innerHTML =
      '<div class="fs-viewer__bar">' +
        '<span class="fs-viewer__name">' + escapeHtml(name) + '</span>' +
        '<button class="btn-chip" data-vdl>⇩</button>' +
        '<button class="btn-chip" data-vshare>Teilen</button>' +
        '<button class="btn-chip" data-vclose>✕</button>' +
      '</div><div class="fs-viewer__body"></div>';
    document.body.appendChild(el);
    el.querySelector('[data-vclose]').addEventListener('click', () => el.remove());
    el.querySelector('[data-vdl]').addEventListener('click', () => window.fsAction('download', { paths: [p], zip: false }));
    el.querySelector('[data-vshare]').addEventListener('click', () => window.fsAction('share', { path: p }));
    const body = el.querySelector('.fs-viewer__body');

    if (kind === 'img' && url) {
      const imgs = fsSorted().filter(e => !e.isDir && fsKind(e.name) === 'img');
      let idx = imgs.findIndex(e => e.path === p);
      const render = () => {
        const cur = imgs[idx];
        el.querySelector('.fs-viewer__name').textContent = cur.name;
        body.innerHTML = '<img src="' + escapeHtml(window.fsFileUrl(cur.path)) + '">' +
          (imgs.length > 1 ? '<button class="fs-viewer__nav" style="left:8px" data-vprev>‹</button>' +
            '<button class="fs-viewer__nav" style="right:8px" data-vnext>›</button>' : '');
        const pv = body.querySelector('[data-vprev]'), nx = body.querySelector('[data-vnext]');
        if (pv) pv.addEventListener('click', () => { idx = (idx - 1 + imgs.length) % imgs.length; render(); });
        if (nx) nx.addEventListener('click', () => { idx = (idx + 1) % imgs.length; render(); });
        const img = body.querySelector('img');
        let zoomed = false;
        img.addEventListener('dblclick', () => { zoomed = !zoomed; img.style.maxWidth = zoomed ? 'none' : '100%'; img.style.maxHeight = zoomed ? 'none' : '100%'; });
      };
      render();
    } else if (kind === 'vid' && url) {
      body.innerHTML = '<video controls autoplay playsinline src="' + escapeHtml(url) + '"></video>';
      body.querySelector('video').addEventListener('error', () => {
        body.innerHTML = fsInfoCardHtml(p, 'Format nicht abspielbar — herunterladen oder teilen.');
        wireFsInfoCard(body, p);
      });
    } else if (kind === 'aud' && url) {
      body.innerHTML = '<audio controls autoplay src="' + escapeHtml(url) + '" style="width:90%"></audio>';
    } else if (kind === 'pdf') {
      const pu = window.fsPdfUrl(p);
      if (pu) body.innerHTML = '<iframe src="' + escapeHtml(pu) + '"></iframe>';
      else { body.innerHTML = fsInfoCardHtml(p, 'PDF-Viewer nur in der App.'); wireFsInfoCard(body, p); }
    } else if (kind === 'md' || kind === 'txt') {
      const e = fsState.entries.find(x => x.path === p);
      if (e && e.size > 5 * 1024 * 1024) { body.innerHTML = fsInfoCardHtml(p, 'Zu groß für die Vorschau (> 5 MB).'); wireFsInfoCard(body, p); }
      else { fsViewerReadTarget = p; body.innerHTML = '<div class="fs-empty">Lädt…</div>'; window.fsReadFile(p); }
    } else {
      body.innerHTML = fsInfoCardHtml(p, url ? '' : 'Keine Vorschau verfügbar.');
      wireFsInfoCard(body, p);
    }
  }
```

- [ ] **Step 4: Download-Leiste** — `fsDlbarHtml`-Platzhalter ersetzen + Progress-Hook:

```js
  function fsDlbarHtml() {
    const running = fsState.downloads.filter(d => d.state === 'running');
    if (!running.length || (fsState.selectMode && fsState.sel.size)) return '';
    const d = running[0];
    return '<div class="fs-dlbar glass">⇩ ' + escapeHtml(d.name) +
      '<progress max="100" value="' + Math.round(d.pct * 100) + '"></progress>' +
      Math.round(d.pct * 100) + '%</div>';
  }
  window.fsDownloadProgress = function (id, name, pct, state) {
    const i = fsState.downloads.findIndex(d => d.id === id);
    if (i === -1) fsState.downloads.push({ id: id, name: name, pct: pct, state: state });
    else fsState.downloads[i] = { id: id, name: name, pct: pct, state: state };
    if (state === 'done') { toast('Gespeichert: ' + name); fsState.downloads = fsState.downloads.filter(d => d.id !== id); }
    if (state === 'error') { toast('Download fehlgeschlagen: ' + name); fsState.downloads = fsState.downloads.filter(d => d.id !== id); }
    window.fsRerender();
  };
```

- [ ] **Step 5: Im Browser verifizieren** (Playwright): `foto.svg` antippen → Bild-Viewer mit Demo-SVG; `notizen.md` → gerendertes Markdown, „Quelltext“-Toggle; `server.log` (in `~/projekt`) → Text mit Zeilennummern; `demo.mp4` → Info-Karte („Format nicht abspielbar“ oder keine Vorschau, da Demo-URL leer); `report.pdf` → Info-Karte „PDF-Viewer nur in der App“. In der Console: `fsDownloadProgress('t1','x.zip',0.4,'running')` → Leiste sichtbar. Screenshots `fs-380-viewer-img.png`, `fs-380-viewer-md.png`.

- [ ] **Step 6: Commit (Plumbing)** — Message: `feat(season2): Files-Screen — Viewer für Bild/Video/Audio/Markdown/PDF/Text + Download-Leiste`

---

### Task 10: Mockup — „Vollbild“-Knopf im Datei-Sheet

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (`buildFilesSheet`, ca. Zeile 3927)

**Interfaces:**
- Consumes: `window.openFilesScreen`, `closeSheet`, `toolSheetWrap`.
- WICHTIG: bridge.js ERSETZT `buildFilesSheet` in der App — derselbe Knopf muss dort ebenfalls rein (Task 11 Step 4).

- [ ] **Step 1: Knopf einfügen** — im HTML von `buildFilesSheet` (Demo-Version) einen Kopf ergänzen:

```js
  function buildFilesSheet() {
    const html = '<div class="fx-head" style="margin-bottom:8px">' +
      '<button class="btn-chip" data-fx-fullscreen>⛶ Vollbild-Explorer</button></div>' +
      `<div class="tool-list">${TMS_DATA.files.map(f => `
      …bestehender Inhalt unverändert…
    return { html, wire () {
      const fsBtn = document.getElementById('toolSheetBody').querySelector('[data-fx-fullscreen]');
      if (fsBtn) fsBtn.addEventListener('click', () => {
        closeSheet(document.getElementById('toolSheetWrap'));
        window.openFilesScreen();
      });
      …bestehende wire-Logik falls vorhanden…
    } };
  }
```

(Exakte Integration beim Implementieren an den realen Demo-Sheet-Code anpassen — er ist eine reine Anzeige-Liste; nur der `fx-head` + `wire`-Handler kommen dazu.)

- [ ] **Step 2: Verifizieren** (Playwright): Terminal-Screen → Ordner-Symbol in der Terminal-Toolbar → Sheet zeigt „⛶ Vollbild-Explorer“ → Tap → Files-Screen offen. Screenshot `fs-380-sheet-fullscreen-btn.png`.

- [ ] **Step 3: Commit (Plumbing)** — Message: `feat(season2): Datei-Sheet — Vollbild-Knopf zum neuen Explorer-Screen`

---

### Task 11: Bridge — echte Datenschicht + Aktionen (bridge.js)

**Files:**
- Modify: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/web/bridge.js` (Datei-Explorer-Abschnitt, ab ca. Zeile 948)

**Interfaces:**
- Consumes (Mockup, Task 7–9): `window.fsSetDir`, `window.fsSetFileContent`, `window.fsDownloadProgress`, `window.fsRerender`, `window.openFilesScreen`; (bestehend): `post`, `toast`, `escapeHtml`, `insertIntoTerminal`, `activeCardId`, `window.__tmsInput`, `window.copyText`, `window.show`.
- Produces (WebView→RN, Task 12 konsumiert): `files:listRaw {path}`, `files:readRaw {path}`, `files:downloadToFolder {paths, zip}`, `files:share {path}`, `files:rename {path, name}`, `files:trashMany {paths}`, `files:mkdir {name}` (bestehend, unverändert fürs Sheet), `files:mkdirAbs {path}`, `files:fav {path}` (bestehend).
- Produces (RN→WebView): `TMSBridge.setFilesBase(base, token)`, `TMSBridge.setFilesDir(path, entries)`, `TMSBridge.fileContent(path, content, error)`, `TMSBridge.downloadProgress(id, name, pct, state)`.

- [ ] **Step 1: Basis-URL + URL-Bauer** (in den Datei-Explorer-Abschnitt von bridge.js)

```js
  // ── Files screen (real data layer) ─────────────────────────────────────
  var fsBase = '', fsToken = '';
  window.TMSBridge.setFilesBase = function (base, token) { fsBase = base; fsToken = token; };
  window.fsFileUrl = function (p) {
    return fsBase ? fsBase + '/files/download?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(fsToken) : '';
  };
  window.fsPdfUrl = function (p) {
    return fsBase ? fsBase + '/files/pdfjs/web/viewer.html?file=' + encodeURIComponent(window.fsFileUrl(p)) : '';
  };
```

- [ ] **Step 2: Daten-Hooks überschreiben**

```js
  window.fsListDir = function (path) { post('files:listRaw', { path: path }); };
  window.TMSBridge.setFilesDir = function (path, entries) {
    if (window.fsSetDir) window.fsSetDir(path, entries);
    window.__tmsCwd = path; // Sheet und Screen teilen sich den Ort
  };
  window.fsReadFile = function (path) { post('files:readRaw', { path: path }); };
  window.TMSBridge.fileContent = function (path, content, error) {
    if (window.fsSetFileContent) window.fsSetFileContent(path, content, error);
  };
  window.TMSBridge.downloadProgress = function (id, name, pct, state) {
    if (window.fsDownloadProgress) window.fsDownloadProgress(id, name, pct, state);
  };
```

- [ ] **Step 3: Aktionen implementieren** (`shq` = Shell-Quote für cd)

```js
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  window.fsAction = function (a, pl) {
    if (a === 'copyPath') {
      window.copyText(pl.paths.join('\n'));
      toast(pl.paths.length > 1 ? pl.paths.length + ' Pfade kopiert' : 'Pfad kopiert');
    } else if (a === 'cd') {
      var card = activeCardId();
      if (!card) { toast('Kein Terminal offen'); return; }
      window.__tmsInput(card, 'cd ' + shq(pl.path) + '\r');
      window.show('terminals');
    } else if (a === 'insert') {
      insertIntoTerminal(pl.path, 'Pfad eingefügt');
    } else if (a === 'download') {
      post('files:downloadToFolder', { paths: pl.paths, zip: !!pl.zip });
    } else if (a === 'share') {
      post('files:share', { path: pl.path });
    } else if (a === 'rename') {
      post('files:rename', { path: pl.path, name: pl.name });
    } else if (a === 'trash') {
      post('files:trashMany', { paths: pl.paths });
    } else if (a === 'fav') {
      post('files:fav', { path: pl.path });
    } else if (a === 'mkdir') {
      post('files:mkdirAbs', { path: pl.path });
    }
  };
```

- [ ] **Step 4: Vollbild-Knopf auch im ECHTEN Sheet** — in bridge.js' `buildFilesSheet` den `fx-head` erweitern (hinter „+ Ordner“):

```js
        '<button class="btn-chip" data-fx="fullscreen">⛶</button>' +
```

und im `data-fx`-Dispatcher von `wireRows`:

```js
              else if (a === 'fullscreen') {
                var wrap2 = document.getElementById('toolSheetWrap');
                if (wrap2 && typeof window.closeSheet === 'function') window.closeSheet(wrap2);
                if (window.openFilesScreen) window.openFilesScreen(window.__tmsCwd);
              }
```

- [ ] **Step 5: `setFavs` rerendert den Screen** — bestehende Funktion erweitern:

```js
  window.TMSBridge.setFavs = function (list) {
    window.__tmsFavs = list || [];
    if (window.fsRerender) window.fsRerender();
  };
```

- [ ] **Step 6: Commit**

```bash
cd /Users/ayysir/Desktop/tms-terminal
git add mobile/src/season2/web/bridge.js
git commit -m "feat(season2): Bridge — Files-Screen an echte Daten/Aktionen angebunden"
```

---

### Task 12: RN — useFileExplorer.ts (Liste, Aktionen, SAF-Downloads mit Fortschritt)

**Files:**
- Create: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/web/useFileExplorer.ts`
- Create: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/web/downloads.ts`
- Modify: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/SeasonTwoWebRoot.tsx` (Zeile ~85 Hook einbinden, Zeile ~328 `handle`-Kette)

**Interfaces:**
- Consumes: Server-Endpoints aus Task 2–6; Bridge-Nachrichten aus Task 11; `call(fn, ...args)`-Muster wie `useSheetBridges`.
- Produces: `useFileExplorer({ ready, call, server, token }) -> { handle(type, payload): boolean }`.

- [ ] **Step 1: downloads.ts — SAF-Helfer**

```ts
// mobile/src/season2/web/downloads.ts
// Real downloads land in a user-granted folder (Android SAF), asked once.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

const DIR_KEY = 'tms:downloadsDirUri';
const SAF = FileSystem.StorageAccessFramework;

export async function ensureDownloadsDir(): Promise<string | null> {
  const saved = await AsyncStorage.getItem(DIR_KEY);
  if (saved) return saved;
  const perm = await SAF.requestDirectoryPermissionsAsync();
  if (!perm.granted) return null;
  await AsyncStorage.setItem(DIR_KEY, perm.directoryUri);
  return perm.directoryUri;
}

/** Copy a finished cache download into the granted folder. Throws on failure. */
export async function saveToDownloads(cacheUri: string, filename: string, mime: string): Promise<void> {
  const dir = await ensureDownloadsDir();
  if (!dir) throw new Error('saf-denied');
  const target = await SAF.createFileAsync(dir, filename, mime);
  try {
    // Native stream copy — no JS memory involved.
    await FileSystem.copyAsync({ from: cacheUri, to: target });
  } catch {
    // Fallback via base64 for small files only (JS bridge limit).
    const info = await FileSystem.getInfoAsync(cacheUri);
    if (!info.exists || (info.size ?? 0) > 100 * 1024 * 1024) throw new Error('copy-failed');
    const b64 = await FileSystem.readAsStringAsync(cacheUri, { encoding: FileSystem.EncodingType.Base64 });
    await SAF.writeAsStringAsync(target, b64, { encoding: FileSystem.EncodingType.Base64 });
  }
}
```

- [ ] **Step 2: useFileExplorer.ts**

```ts
// mobile/src/season2/web/useFileExplorer.ts
// The fullscreen Files screen: raw listings, previews, renames, bulk trash,
// shares, and real downloads (single file or server-zipped selection).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useFavPathsStore } from '../../store/favPathsStore';
import { saveToDownloads } from './downloads';

type Call = (fn: string, ...args: unknown[]) => void;

interface Args {
  ready: boolean;
  call: Call;
  server: { id: string; host: string; port: number } | null;
  token: string | null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  zip: 'application/zip', md: 'text/markdown', txt: 'text/plain', json: 'application/json',
};
const mimeFor = (name: string) =>
  MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export function useFileExplorer({ ready, call, server, token }: Args) {
  const cwd = useRef('~');
  const base = server ? `http://${server.host}:${server.port}` : '';

  useEffect(() => {
    if (ready && server && token) call('setFilesBase', base, token);
  }, [ready, server, token, base, call]);

  const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const listRaw = useCallback(async (path: string) => {
    if (!server || !token) return;
    try {
      const r = await fetch(`${base}/files/list?path=${encodeURIComponent(path)}`, { headers: auth });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      cwd.current = d.path;
      call('setFilesDir', d.path, (d.entries ?? []).map((e: any) => ({
        name: e.name, path: e.path, isDir: e.isDir, size: e.size, modified: e.modified,
      })));
    } catch (e: any) {
      call('toast', `Dateien: ${e?.message ?? 'Laden fehlgeschlagen'}`);
    }
  }, [server, token, base, auth, call]);

  const refresh = useCallback(() => listRaw(cwd.current), [listRaw]);

  const download = useCallback(async (paths: string[], zip: boolean) => {
    if (!server || !token || !paths.length) return;
    const id = `dl-${Date.now()}`;
    const filename = zip
      ? `tms-${paths.length === 1 ? (paths[0].split('/').pop() ?? 'ordner') : 'auswahl'}.zip`
      : (paths[0].split('/').pop() ?? 'datei');
    const url = zip
      ? `${base}/files/zip?paths=${encodeURIComponent(JSON.stringify(paths))}&token=${token}`
      : `${base}/files/download?path=${encodeURIComponent(paths[0])}&token=${token}`;
    const tmp = `${FileSystem.cacheDirectory}${id}-${filename}`;
    call('downloadProgress', id, filename, 0, 'running');
    try {
      const task = FileSystem.createDownloadResumable(url, tmp, {}, (p) => {
        const pct = p.totalBytesExpectedToWrite > 0
          ? p.totalBytesWritten / p.totalBytesExpectedToWrite : 0;
        call('downloadProgress', id, filename, pct, 'running');
      });
      const res = await task.downloadAsync();
      if (!res) throw new Error('Abgebrochen');
      if (res.status >= 400) throw new Error(res.status === 413 ? 'Zu groß (> 4 GB)' : `HTTP ${res.status}`);
      try {
        await saveToDownloads(res.uri, filename, zip ? 'application/zip' : mimeFor(filename));
        call('downloadProgress', id, filename, 1, 'done');
      } catch {
        // SAF denied or copy failed — offer the share sheet instead.
        call('downloadProgress', id, filename, 1, 'done');
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
      }
    } catch (e: any) {
      call('downloadProgress', id, filename, 0, 'error');
      call('toast', `Download: ${e?.message ?? 'fehlgeschlagen'}`);
    } finally {
      FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
  }, [server, token, base, call]);

  const handle = useCallback((type: string, payload: any): boolean => {
    switch (type) {
      case 'files:listRaw':
        listRaw(String(payload.path ?? '~'));
        return true;

      case 'files:readRaw': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/read?path=${encodeURIComponent(payload.path)}`, { headers: auth });
            const d = await r.json();
            if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
            call('fileContent', payload.path, d.content ?? '', null);
          } catch (e: any) {
            call('fileContent', payload.path, '', e?.message ?? 'Lesen fehlgeschlagen');
          }
        })();
        return true;
      }

      case 'files:downloadToFolder':
        download((payload.paths ?? []).map(String), !!payload.zip);
        return true;

      case 'files:share': {
        if (!server || !token) return true;
        (async () => {
          const name = String(payload.path).split('/').pop() ?? 'datei';
          const tmp = `${FileSystem.cacheDirectory}share-${name}`;
          try {
            const { uri, status } = await FileSystem.downloadAsync(
              `${base}/files/download?path=${encodeURIComponent(payload.path)}&token=${token}`, tmp);
            if (status >= 400) throw new Error(`HTTP ${status}`);
            if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
          } catch (e: any) {
            call('toast', `Teilen: ${e?.message ?? 'fehlgeschlagen'}`);
          }
        })();
        return true;
      }

      case 'files:rename': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...auth },
              body: JSON.stringify({ path: payload.path, name: payload.name }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(r.status === 409 ? 'Name existiert schon' : d.error ?? `HTTP ${r.status}`);
            call('toast', 'Umbenannt');
            refresh();
          } catch (e: any) { call('toast', `Umbenennen: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'files:trashMany': {
        if (!server || !token) return true;
        const paths: string[] = (payload.paths ?? []).map(String);
        (async () => {
          try {
            const r = await fetch(`${base}/files/trash`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...auth },
              body: JSON.stringify({ paths }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            call('toast', paths.length > 1 ? `${paths.length} in den Papierkorb gelegt` : 'In den Papierkorb gelegt');
            refresh();
          } catch (e: any) { call('toast', `Löschen: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }

      case 'files:mkdirAbs': {
        if (!server || !token) return true;
        (async () => {
          try {
            const r = await fetch(`${base}/files/mkdir`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...auth },
              body: JSON.stringify({ path: payload.path }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            call('toast', 'Ordner angelegt');
            refresh();
          } catch (e: any) { call('toast', `Ordner: ${e?.message ?? 'fehlgeschlagen'}`); }
        })();
        return true;
      }
    }
    return false;
  }, [listRaw, refresh, download, server, token, base, auth, call]);

  return useMemo(() => ({ handle }), [handle]);
}
```

Hinweis: `files:fav` läuft weiter über den bestehenden `useSheetBridges`-Handler (der pusht `setFavs`, was seit Task 11 auch den Screen rerendert). Damit dessen `listFiles`-Refresh das Sheet nicht stört, bleibt er unverändert.

- [ ] **Step 3: In SeasonTwoWebRoot einhängen**

```ts
// Zeile ~86, unter useSheetBridges:
const fileExplorer = useFileExplorer({ ready, call, server, token });
// Zeile ~328, in der Message-Kette NACH sheets.handle:
if (fileExplorer.handle(type, payload)) return;
```
(Import oben: `import { useFileExplorer } from './web/useFileExplorer';`)

- [ ] **Step 4: Typecheck**

```bash
cd /Users/ayysir/Desktop/tms-terminal/mobile && npx tsc --noEmit
```
Expected: keine neuen Fehler.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/season2/web/useFileExplorer.ts mobile/src/season2/web/downloads.ts mobile/src/season2/SeasonTwoWebRoot.tsx
git commit -m "feat(season2): Datei-Explorer-Backend — SAF-Downloads, ZIP, Rename, Bulk-Trash, Vorschau"
```

---

### Task 13: Build — Mockup in die App übernehmen

**Files:**
- Modify (generiert): `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/web/liquidDeckHtml.ts`

- [ ] **Step 1: Season-2-Build laufen lassen**

```bash
cd /Users/ayysir/Desktop/tms-terminal/mobile && npm run build:season2
```
Expected: läuft durch. Falls „patch … no longer matches the mockup“: Der jeweilige Anker in `scripts/build-season2-html.js` ist durch die Mockup-Änderungen verrutscht — Anker an den neuen Mockup-Stand anpassen (NICHT das Mockup an den Anker).

- [ ] **Step 2: Typecheck + kurzer Grep-Sanity-Check**

```bash
npx tsc --noEmit
grep -c "openFilesScreen" src/season2/web/liquidDeckHtml.ts
```
Expected: tsc sauber; grep ≥ 1 (Files-Screen ist im Bundle).

- [ ] **Step 3: Commit**

```bash
git add mobile/src/season2/web/liquidDeckHtml.ts mobile/scripts/build-season2-html.js
git commit -m "build(season2): Liquid-Deck-HTML mit Files-Screen neu generiert"
```

---

### Task 14: E2E-Verifikation + Release

- [ ] **Step 1: Server-Testsuite final** — `cd /Users/ayysir/Desktop/tms-terminal/server && npm test` → alles grün. Danach `rm -f .tsbuildinfo && npm run build`. **Neustart des Servers macht der Nutzer** (Hinweis an ihn: „Server bitte einmal neu starten, wenn du bereit bist — das beendet meine laufende Sitzung“).
- [ ] **Step 2: Release bauen** — wie etabliert über CI: Version bumpen, Tag pushen (GitHub-Actions-Workflow baut die APK; lokale Builds hängen am Metro-Headless-Problem). Konkrete Schritte wie beim letzten Release (v1.41.x-Muster im Repo).
- [ ] **Step 3: Am Fold 7 prüfen (Nutzer + Claude gemeinsam):**
  - Werkzeuge → Dateien: Vollbild-Explorer mit echtem Home-Verzeichnis, Thumbnails für Bilder.
  - Breadcrumbs, Sortierung, Suche, Favoriten-Chips.
  - Bild öffnen → blättern; Markdown → gerendert; PDF → pdf.js; großes Video (>1 GB) → sofortiger Start + Spulen.
  - ⋯-Menü: Pfad kopieren (Toast + Zwischenablage), „Im Terminal öffnen“ → cd im aktiven Terminal + Screen-Wechsel, Umbenennen, Löschen → Papierkorb.
  - Auswahl-Modus: 3 Dateien → „⇩ Laden (3)“ → einmalige SAF-Freigabe → `tms-auswahl.zip` im Downloads-Ordner; Fortschrittsleiste sichtbar.
  - Ordner herunterladen → ZIP; > 4 GB → klare Fehlermeldung.
  - Terminal-Toolbar → Sheet → „⛶“ → Vollbild-Explorer im selben Ordner.
- [ ] **Step 4: Memory aktualisieren** — `project_season2_mockup_is_the_app.md` um den Files-Screen ergänzen (neue `window.fs*`-Hook-Schnittstelle Mockup↔Bridge).

---

## Plan-Selbstreview (erledigt)

- **Spec-Abdeckung:** Range→T1/T2, MIME→T2, rename→T3, zip→T4, pdfjs→T5, read-5MB→T6, Screen/UI→T7, Bulk+Menü+Rename-UI→T8, Viewer+Downloads-Leiste→T9, Sheet-Vollbild→T10 (+T11 Step 4 für die echte App), Bridge-Nachrichten→T11, SAF/Fortschritt/Teilen/RN→T12, Build→T13, E2E/Release→T14. Fehlerbehandlung: Toasts in T11/T12, Video-onerror-Fallback T9, 413-Meldung T12, SAF-Fallback T12, Thumbnail-onerror T7.
- **Typkonsistenz:** `fsAction`-Verträge (T8) == bridge.js-Implementierung (T11) == RN-Handler (T12); `setFilesDir/fileContent/downloadProgress` in T7/T9 == T11 == T12; `parseRange`-Rückgabe T1 == Nutzung T2.
- **Bekannte Unsicherheit (bewusst im Plan):** `FileSystem.copyAsync` auf SAF-Ziel — Fallback-Kette in `saveToDownloads` (T12) fängt das ab; E2E-Check in T14 verifiziert am Gerät.
