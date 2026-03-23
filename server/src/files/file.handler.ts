import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { execSync } from 'child_process';
import { getPlatform } from '../utils/platform';

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

export async function handleFileList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const raw = url.searchParams.get('path') ?? '~';
    const dirPath = resolvePath(raw);

    if (!isWithinHome(dirPath)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(dirPath)) return err(res, 403, 'Access denied: sensitive path');

    const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
    const entries: FileEntry[] = await Promise.all(dirents.map(async (e) => {
      const full = path.join(dirPath, e.name);
      let size = 0, modified = 0;
      try { const st = await fsp.stat(full); size = st.size; modified = st.mtimeMs; } catch {}
      return { name: e.name, path: full, isDir: e.isDirectory() || e.isSymbolicLink() && await isDirAsync(full), size, modified, isSymlink: e.isSymbolicLink() };
    }));

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

async function isDirAsync(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

export async function handleFileRead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const raw = url.searchParams.get('path') ?? '';
    if (!raw) return err(res, 400, 'path required');

    const filePath = resolvePath(raw);

    if (!isWithinHome(filePath)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(filePath)) return err(res, 403, 'Access denied: sensitive path');

    const stat = await fsp.stat(filePath);

    if (stat.isDirectory()) return err(res, 400, 'Is a directory');
    if (stat.size > 2 * 1024 * 1024) return err(res, 400, 'File too large to preview (>2 MB)');

    const buf = await fsp.readFile(filePath);

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
    const stream = fs.createReadStream(filePath);
    stream.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      else { res.destroy(); }
    });
    stream.pipe(res);
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}

// ── Helpers for POST endpoints ────────────────────────────────────────

function parseJsonBody(req: http.IncomingMessage, maxSize: number = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Return a non-conflicting target path by appending (2), (3), etc. */
function resolveConflict(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let i = 2;
  while (true) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

// ── POST /files/mkdir ─────────────────────────────────────────────────

export async function handleMkdir(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const raw: string = body?.path;
    if (!raw) return err(res, 400, 'path required');

    const resolvedPath = resolvePath(raw);

    if (!isWithinHome(resolvedPath)) return err(res, 403, 'Access denied: path is outside home directory');
    if (isDeniedPath(resolvedPath)) return err(res, 403, 'Access denied: sensitive path');

    if (fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) return err(res, 409, 'Directory already exists');
      return err(res, 409, 'A file with that name already exists');
    }

    fs.mkdirSync(resolvedPath, { recursive: true });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: resolvedPath }));
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}

// ── POST /files/move ──────────────────────────────────────────────────

export async function handleMove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const sources: string[] = body?.sources;
    const destination: string = body?.destination;

    if (!Array.isArray(sources) || sources.length === 0) return err(res, 400, 'sources array required');
    if (!destination) return err(res, 400, 'destination required');

    const resolvedDest = resolvePath(destination);
    if (!isWithinHome(resolvedDest)) return err(res, 403, 'Access denied: destination is outside home directory');
    if (isDeniedPath(resolvedDest)) return err(res, 403, 'Access denied: sensitive destination path');

    if (!fs.existsSync(resolvedDest) || !fs.statSync(resolvedDest).isDirectory()) {
      return err(res, 400, 'Destination must be an existing directory');
    }

    let moved = 0;
    for (const raw of sources) {
      const resolvedSrc = resolvePath(raw);
      if (!isWithinHome(resolvedSrc)) return err(res, 403, `Access denied: source "${raw}" is outside home directory`);
      if (isDeniedPath(resolvedSrc)) return err(res, 403, `Access denied: sensitive source path "${raw}"`);
      if (!fs.existsSync(resolvedSrc)) return err(res, 400, `Source not found: ${raw}`);

      const basename = path.basename(resolvedSrc);
      let target = path.join(resolvedDest, basename);
      target = resolveConflict(target);

      fs.renameSync(resolvedSrc, target);
      moved++;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, moved }));
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}

// ── POST /files/trash ─────────────────────────────────────────────────

export async function handleTrash(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const paths: string[] = body?.paths;

    if (!Array.isArray(paths) || paths.length === 0) return err(res, 400, 'paths array required');

    const platform = getPlatform();
    let trashed = 0;

    for (const raw of paths) {
      const resolved = resolvePath(raw);
      if (!isWithinHome(resolved)) return err(res, 403, `Access denied: path "${raw}" is outside home directory`);
      if (isDeniedPath(resolved)) return err(res, 403, `Access denied: sensitive path "${raw}"`);
      if (!fs.existsSync(resolved)) return err(res, 400, `Path not found: ${raw}`);

      if (platform === 'darwin') {
        trashMacOS(resolved);
      } else if (platform === 'win32') {
        trashWindows(resolved);
      } else {
        trashLinux(resolved);
      }
      trashed++;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, trashed }));
  } catch (e: unknown) {
    err(res, 400, e instanceof Error ? e.message : String(e));
  }
}

function trashMacOS(filePath: string): void {
  const trashDir = path.join(os.homedir(), '.Trash');
  const basename = path.basename(filePath);
  const ext = path.extname(filePath);
  const name = path.basename(filePath, ext);
  let target = path.join(trashDir, basename);

  if (fs.existsSync(target)) {
    // Append timestamp to avoid conflicts
    const ts = Date.now();
    target = path.join(trashDir, `${name} ${ts}${ext}`);
  }

  fs.renameSync(filePath, target);
}

function trashWindows(filePath: string): void {
  const escapedPath = filePath.replace(/'/g, "''");
  execSync(
    `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escapedPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')"`,
    { timeout: 10000 }
  );
}

function trashLinux(filePath: string): void {
  const trashFilesDir = path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
  const trashInfoDir = path.join(os.homedir(), '.local', 'share', 'Trash', 'info');
  fs.mkdirSync(trashFilesDir, { recursive: true });
  fs.mkdirSync(trashInfoDir, { recursive: true });

  const basename = path.basename(filePath);
  const ext = path.extname(filePath);
  const name = path.basename(filePath, ext);
  let trashName = basename;

  if (fs.existsSync(path.join(trashFilesDir, trashName))) {
    const ts = Date.now();
    trashName = `${name} ${ts}${ext}`;
  }

  // Write .trashinfo metadata
  const now = new Date();
  const deletionDate = now.toISOString().replace(/\.\d{3}Z$/, '');
  const trashInfo = `[Trash Info]\nPath=${filePath}\nDeletionDate=${deletionDate}\n`;
  fs.writeFileSync(path.join(trashInfoDir, `${trashName}.trashinfo`), trashInfo);

  fs.renameSync(filePath, path.join(trashFilesDir, trashName));
}
