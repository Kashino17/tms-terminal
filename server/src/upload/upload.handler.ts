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

export interface MediaOptions {
  /** Absolute folder the file ends up in. */
  dir: string;
  defaultExt: string;
  /** Word used in the log lines. */
  label: string;
  maxBytes?: number;
}

/**
 * Streams one multipart file (image or video) to disk and answers with its
 * path. No auth in here — handleMultipartUpload does that first.
 *
 * The answer is sent only after the file is completely written AND renamed.
 * Busboy reports "done" as soon as the request body is parsed; the disk write
 * is still running at that moment. Answering on busboy's signal alone reported
 * "No file received" for every single upload and deleted the half-written
 * file — that is why videos never arrived.
 */
export function receiveMedia(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: MediaOptions,
): void {
  const maxBytes = opts.maxBytes ?? MAX_MULTIPART_SIZE;
  let responded = false;
  let tempPath = '';
  let out: fs.WriteStream | null = null;
  /** Settles when the file is on disk under its final name. */
  let stored: Promise<{ path: string; filename: string }> | null = null;

  const respond = (status: number, body: object) => {
    if (responded) return;
    responded = true;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const cleanup = () => {
    if (out && !out.destroyed) out.destroy();
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
  };

  const fail = (status: number, error: string) => {
    cleanup();
    if (!responded) logger.error(`${opts.label} upload failed (${status}): ${error}`);
    respond(status, { error });
  };

  let busboy: ReturnType<typeof Busboy>;
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } });
  } catch (err) {
    fail(400, 'Invalid multipart request');
    return;
  }

  busboy.on('file', (_field: string, file: NodeJS.ReadableStream & { resume: () => void }, info: { filename: string; encoding: string; mimeType: string }) => {
    const { filename, mimeType } = info;
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
      file.resume(); // drain
      stored = Promise.reject(Object.assign(new Error(`Unsupported file type: ${mimeType}`), { status: 400 }));
      stored.catch(() => {}); // handled in 'close'
      return;
    }

    const ext = path.extname(filename) || opts.defaultExt;
    const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const finalName = `${Date.now()}_${base}${ext}`;
    const finalPath = path.join(opts.dir, finalName);
    tempPath = finalPath + '.tmp';
    const ws = fs.createWriteStream(tempPath);
    out = ws;

    stored = new Promise((resolve, reject) => {
      let tooLarge = false;
      // Busboy cuts the stream at the limit and then ends it normally, so the
      // write still "finishes" — with a truncated file. Remember that it was cut.
      file.on('limit', () => { tooLarge = true; });
      file.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => {
        if (tooLarge) {
          const mb = Math.round(maxBytes / 1024 / 1024);
          reject(Object.assign(new Error(`File too large (max ${mb} MB)`), { status: 413 }));
          return;
        }
        try {
          fs.renameSync(tempPath, finalPath);
          resolve({ path: finalPath, filename: finalName });
        } catch (err) { reject(err); }
      });
    });
    stored.catch(() => {}); // handled in 'close'
    file.pipe(ws);
  });

  // 'close' = the whole request body is parsed. The file may still be flushing.
  busboy.on('close', () => {
    if (!stored) { fail(400, 'No file received'); return; }
    stored.then(
      (saved) => {
        logger.success(`${opts.label} saved: ${saved.path}`);
        respond(200, saved);
      },
      (err: Error & { status?: number }) => fail(err.status ?? 500, err.status ? err.message : `Write error: ${err.message}`),
    );
  });

  busboy.on('error', (err: Error) => fail(400, `Invalid upload: ${err.message}`));

  // Connection dropped mid-upload (phone lost the network): no half file stays.
  // A normally finished request also emits 'close' — req.complete tells them apart.
  req.on('close', () => {
    if (!req.complete && !responded) {
      logger.error(`${opts.label} upload aborted by the client`);
      responded = true;
      cleanup();
    }
  });

  req.pipe(busboy);
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

  receiveMedia(req, res, {
    dir: path.join(os.homedir(), 'Desktop', opts.outputDir),
    defaultExt: opts.defaultExt,
    label: opts.subDir,
  });
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
