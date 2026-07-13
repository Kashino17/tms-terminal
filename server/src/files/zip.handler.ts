import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import archiver = require('archiver');

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
