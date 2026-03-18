import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  isSymlink: boolean;
}

function resolvePath(raw: string): string {
  if (raw === '~' || raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return path.resolve(raw);
}

/** Verify resolved path is within the user's home directory. */
function isWithinHome(resolved: string): boolean {
  const home = os.homedir();
  const normalized = path.resolve(resolved);
  return normalized === home || normalized.startsWith(home + path.sep);
}

const DENIED_PATHS = [
  '.tms-terminal',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
  '.env',
  '.netrc',
  '.npmrc',
];

function isDeniedPath(resolved: string): boolean {
  const home = os.homedir();
  const rel = path.relative(home, resolved);
  return DENIED_PATHS.some(denied => rel === denied || rel.startsWith(denied + path.sep));
}

function err(res: http.ServerResponse, status: number, msg: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

export function handleFileList(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const raw = url.searchParams.get('path') ?? '~';
    const dirPath = resolvePath(raw);

    if (!isWithinHome(dirPath)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(dirPath)) return err(res, 403, 'Access denied: sensitive path');

    const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    const entries: FileEntry[] = dirents.map((e) => {
      const full = path.join(dirPath, e.name);
      let size = 0, modified = 0;
      try { const st = fs.statSync(full); size = st.size; modified = st.mtimeMs; } catch {}
      return { name: e.name, path: full, isDir: e.isDirectory() || e.isSymbolicLink() && isDir(full), size, modified, isSymlink: e.isSymbolicLink() };
    });

    // Folders first, then files — each group alphabetical
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: dirPath, parent: path.dirname(dirPath), entries }));
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function handleFileRead(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const raw = url.searchParams.get('path') ?? '';
    if (!raw) return err(res, 400, 'path required');

    const filePath = resolvePath(raw);

    if (!isWithinHome(filePath)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(filePath)) return err(res, 403, 'Access denied: sensitive path');

    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) return err(res, 400, 'Is a directory');
    if (stat.size > 2 * 1024 * 1024) return err(res, 400, 'File too large to preview (>2 MB)');

    const buf = fs.readFileSync(filePath);

    // Detect binary: if >30% of first 512 bytes are non-printable, reject
    const sample = buf.slice(0, 512);
    let nonPrintable = 0;
    for (const b of sample) { if (b < 9 || (b > 13 && b < 32) || b === 127) nonPrintable++; }
    if (sample.length > 0 && nonPrintable / sample.length > 0.3) {
      return err(res, 400, 'Binary file — cannot preview');
    }

    const content = buf.toString('utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content, size: stat.size, lines: content.split('\n').length }));
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  json: 'application/json', txt: 'text/plain', html: 'text/html', css: 'text/css',
  js: 'text/javascript', ts: 'text/plain',
};

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

export function handleFileDownload(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const raw = url.searchParams.get('path') ?? '';
    if (!raw) return err(res, 400, 'path required');

    const filePath = resolvePath(raw);

    if (!isWithinHome(filePath)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(filePath)) return err(res, 403, 'Access denied: sensitive path');

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return err(res, 400, 'Cannot download directory');

    const filename = path.basename(filePath);
    const mime = getMimeType(filename);
    const isInline = mime.startsWith('image/') || mime === 'application/pdf';
    const safeFilename = filename.replace(/"/g, '\\"');

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename="${safeFilename}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'max-age=300',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}
