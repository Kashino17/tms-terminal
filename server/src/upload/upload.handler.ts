import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateToken } from '../auth/jwt.service';
import { logger } from '../utils/logger';
import Busboy from 'busboy';

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
const MAX_MULTIPART_SIZE = 500 * 1024 * 1024; // 500 MB

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/webm',
]);

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

function handleMultipartUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: UploadOptions,
): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !validateToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const dir = path.join(os.homedir(), 'Desktop', opts.outputDir);
  fs.mkdirSync(dir, { recursive: true });

  let fileSaved = false;
  let finalPath = '';
  let finalName = '';
  let tempPath = '';
  let responded = false;

  const respond = (status: number, body: object) => {
    if (responded) return;
    responded = true;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const cleanup = () => {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  };

  let busboy: ReturnType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_MULTIPART_SIZE, files: 1 },
    });
  } catch (err) {
    respond(400, { error: 'Invalid multipart request' });
    return;
  }

  busboy.on('file', (fieldname: string, file: NodeJS.ReadableStream & { resume: () => void }, info: { filename: string; encoding: string; mimeType: string }) => {
    const { filename, mimeType } = info;

    // Validate MIME type
    const isImage = mimeType.startsWith('image/');
    const isVideo = ALLOWED_VIDEO_MIMES.has(mimeType);
    if (!isImage && !isVideo) {
      file.resume(); // drain
      respond(400, { error: `Unsupported file type: ${mimeType}` });
      return;
    }

    const ext = path.extname(filename) || opts.defaultExt;
    const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    finalName = `${Date.now()}_${base}${ext}`;
    finalPath = path.join(dir, finalName);
    tempPath = finalPath + '.tmp';

    const writeStream = fs.createWriteStream(tempPath);

    file.on('limit', () => {
      writeStream.destroy();
      cleanup();
      respond(413, { error: 'File too large (max 500 MB)' });
    });

    file.pipe(writeStream);

    writeStream.on('finish', () => {
      try {
        fs.renameSync(tempPath, finalPath);
        fileSaved = true;
      } catch (err) {
        cleanup();
        respond(500, { error: 'Failed to save file' });
      }
    });

    writeStream.on('error', (err) => {
      cleanup();
      respond(500, { error: 'Write error' });
    });
  });

  busboy.on('finish', () => {
    if (fileSaved) {
      logger.success(`${opts.subDir} saved: ${finalPath}`);
      respond(200, { path: finalPath, filename: finalName });
    } else if (!responded) {
      cleanup();
      respond(400, { error: 'No file received' });
    }
  });

  busboy.on('error', (err: Error) => {
    cleanup();
    respond(500, { error: 'Upload failed' });
  });

  req.on('close', () => {
    if (!fileSaved) cleanup();
  });

  req.pipe(busboy);
}

export function handleUploadRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('multipart/form-data')) {
    handleMultipartUpload(req, res, {
      outputDir: 'Screenshots',
      defaultExt: '.mp4',
      subDir: 'Media',
    });
  } else {
    handleUpload(req, res, {
      outputDir: 'Screenshots',
      defaultExt: '.jpg',
      subDir: 'Screenshot',
    });
  }
}

export function handleDrawingUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
  handleUpload(req, res, {
    outputDir: 'Drawings',
    defaultExt: '.png',
    subDir: 'Drawing',
  });
}
