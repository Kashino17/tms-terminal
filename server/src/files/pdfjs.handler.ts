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
