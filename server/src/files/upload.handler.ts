import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFile } from 'child_process';
import { resolvePath, isWithinHome, isDeniedPath } from './file.handler';
import { logger } from '../utils/logger';

/**
 * Handy → Rechner: eine Datei in einen Ordner des Rechners legen.
 *
 *   POST /files/upload?dir=<ordner>&name=<dateiname>[&reveal=1]   Rumpf = Dateiinhalt
 *
 * Der Rumpf ist die rohe Datei (kein multipart) und wird gestreamt — auch
 * grosse Videos landen ohne Zwischenspeicher im Arbeitsspeicher. Die App
 * schickt ohne Content-Type und mit ?token=. Eine Vorabfrage (OPTIONS) kann
 * trotzdem kommen (Private Network Access) — sie wird VOR der Token-Pruefung
 * beantwortet; alle Antworten tragen die CORS-Koepfe.
 *
 * Gleiche Grenzen wie der Datei-Explorer: nur im Home-Ordner, nie in
 * .ssh/.tms-terminal & Co. Vorhandenes wird nie ueberschrieben ("name (2).ext").
 * reveal=1 zeigt die Datei danach im Finder/Explorer — im Fernzugriff sieht
 * man so sofort, wo sie liegt.
 */
export const DEFAULT_UPLOAD_DIR = '~/Downloads/TMS';

function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Chrome/WebView fragen vor Anfragen an private Adressen (Tailscale 100.x) eigens nach.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function reply(res: http.ServerResponse, status: number, body: object) {
  if (res.headersSent) return;
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Nur der Dateiname, ohne Pfad und ohne Zeichen, die Mac/Windows nicht moegen. */
export function safeUploadName(raw: string): string {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '').trim().slice(0, 200);
  return clean || 'datei';
}

/** Freier Zielpfad: "name.ext", sonst "name (2).ext", "name (3).ext" … */
export function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem} (${n})${ext === name ? '' : ext}`);
  }
  return candidate;
}

function reveal(file: string) {
  if (process.platform === 'darwin') {
    execFile('/usr/bin/open', ['-R', file], { timeout: 5000 }, () => {});
  } else if (process.platform === 'win32') {
    execFile('explorer.exe', [`/select,${file}`], { timeout: 5000, windowsHide: true }, () => {});
  }
}

/** Max. Groesse eines Stuecks im Stueck-Modus (Base64-Text). */
const MAX_PART_BYTES = 16 * 1024 * 1024;

/**
 * Stueck-Modus: ?up=<id>&part=<n>[&final=1]&enc=b64 — der Rumpf ist ein
 * Base64-Stueck der Datei. Die App reicht so Dateien weiter, die die Seite
 * selbst nicht senden darf (Chromium sperrt Anfragen von der App-Seite ins
 * lokale Netz/Tailnet). Stueck 0 legt die Zwischendatei an, jedes weitere
 * haengt an, final=1 benennt sie um wie beim Strom-Modus.
 */
function handlePartUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL, dir: string, name: string): void {
  const up = url.searchParams.get('up') || '';
  if (!/^[A-Za-z0-9-]{4,64}$/.test(up)) return reply(res, 400, { error: 'Ungültige Upload-Kennung' });
  const part = Number(url.searchParams.get('part') || '0');
  if (!Number.isInteger(part) || part < 0) return reply(res, 400, { error: 'Ungültiges Stück' });
  const tmp = path.join(dir, `.${name}.${up}.tms-upload`);
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_PART_BYTES) { tooBig = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    const raw = Buffer.concat(chunks);
    const data = url.searchParams.get('enc') === 'b64' ? Buffer.from(raw.toString('ascii'), 'base64') : raw;
    try {
      if (part === 0) fs.writeFileSync(tmp, data);
      else {
        if (!fs.existsSync(tmp)) return reply(res, 409, { error: 'Upload-Anfang fehlt' });
        fs.appendFileSync(tmp, data);
      }
      if (url.searchParams.get('final') !== '1') return reply(res, 200, { ok: true, size: fs.statSync(tmp).size });
      const target = uniqueTarget(dir, name);
      fs.renameSync(tmp, target);
      const total = fs.statSync(target).size;
      logger.info(`Upload vom Handy: ${target} (${total} B, ${part + 1} Stücke)`);
      if (url.searchParams.get('reveal') === '1') reveal(target);
      reply(res, 200, { path: target, name: path.basename(target), size: total });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* schon weg */ }
      reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  req.on('error', () => { try { fs.unlinkSync(tmp); } catch { /* schon weg */ } });
}

export function handleFileUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  // Faehigkeits-Abfrage der App vor dem ersten Stueck: ein alter Server
  // (404) wuerde den Base64-Text sonst als fertige Datei ablegen.
  if (req.method === 'GET') return reply(res, 200, { parts: true });
  if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });

  let url: URL;
  try { url = new URL(req.url!, 'http://localhost'); } catch { return reply(res, 400, { error: 'Ungültige Adresse' }); }
  const rawName = url.searchParams.get('name');
  if (!rawName) return reply(res, 400, { error: 'Dateiname fehlt' });
  const dir = resolvePath(url.searchParams.get('dir') || DEFAULT_UPLOAD_DIR);
  if (!isWithinHome(dir)) return reply(res, 403, { error: 'Access denied: path is outside home directory' });
  if (isDeniedPath(dir)) return reply(res, 403, { error: 'Access denied: sensitive path' });

  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return reply(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  if (url.searchParams.has('up')) return handlePartUpload(req, res, url, dir, safeUploadName(rawName));
  const target = uniqueTarget(dir, safeUploadName(rawName));
  // Versteckte Zwischendatei im selben Ordner: erst nach vollstaendigem
  // Empfang umbenannt — ein abgebrochener Upload hinterlaesst keine halbe Datei.
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tms-upload`);
  const out = fs.createWriteStream(tmp);
  let finished = false;
  const drop = () => { try { fs.unlinkSync(tmp); } catch { /* schon weg */ } };

  out.on('error', (e) => { drop(); reply(res, 500, { error: `Schreiben fehlgeschlagen: ${e.message}` }); });
  out.on('finish', () => {
    finished = true;
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      drop();
      return reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    const size = fs.statSync(target).size;
    logger.info(`Upload vom Handy: ${target} (${size} B)`);
    if (url.searchParams.get('reveal') === '1') reveal(target);
    reply(res, 200, { path: target, name: path.basename(target), size });
  });
  req.on('aborted', () => { if (!finished) { out.destroy(); drop(); } });
  req.pipe(out);
}
