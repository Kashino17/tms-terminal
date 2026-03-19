import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateToken } from '../auth/jwt.service';
import { logger } from '../utils/logger';

interface UploadBody {
  filename: string;
  data: string; // base64
  mimeType?: string;
}

interface UploadOptions {
  outputDir: string;
  defaultExt: string;
  subDir: string;
}

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB

function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: UploadOptions,
): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Auth via Bearer token
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || !validateToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let rejected = false;

  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      rejected = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected) return;
    try {
      const body = Buffer.concat(chunks).toString('utf-8');
      const parsed = JSON.parse(body) as UploadBody;
      const { filename, data } = parsed;

      if (!filename || !data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing filename or data' }));
        return;
      }

      // Sanitise filename — keep extension, strip path separators
      const ext = path.extname(filename) || opts.defaultExt;
      const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
      const finalName = `${Date.now()}_${base}${ext}`;

      const dir = path.join(os.homedir(), 'Desktop', opts.outputDir);
      fs.mkdirSync(dir, { recursive: true });

      const filePath = path.join(dir, finalName);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

      logger.success(`${opts.subDir} saved: ${filePath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: filePath, filename: finalName }));
    } catch (err) {
      logger.error(`${opts.subDir} upload error: ${err}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed' }));
    }
  });
}

export function handleUploadRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  handleUpload(req, res, {
    outputDir: 'Screenshots',
    defaultExt: '.jpg',
    subDir: 'Screenshot',
  });
}

export function handleDrawingUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
  handleUpload(req, res, {
    outputDir: 'Drawings',
    defaultExt: '.png',
    subDir: 'Drawing',
  });
}
