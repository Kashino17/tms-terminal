import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config, loadServerConfig, ensureConfigDir } from './config';
import { handleAuthRequest } from './auth/auth.controller';
import { handleFileList, handleFileRead, handleFileDownload, handleMkdir, handleMove, handleTrash } from './files/file.handler';
import { handleUploadRequest, handleDrawingUpload } from './upload/upload.handler';
import { validateToken } from './auth/jwt.service';
import { createWebSocketServer } from './websocket/ws.server';
import { isPasswordSet } from './auth/password.service';
import { logger } from './utils/logger';
import { getPlatform, getDefaultShell } from './utils/platform';
import { fcmService } from './notifications/fcm.service';
import { watcherService } from './watchers/watcher.service';
import { globalManager } from './terminal/terminal.manager';
import { shutdown as shutdownWhisper } from './audio/whisper-sidecar';
import { managerService } from './websocket/ws.handler';
import { ensureAckAudios } from './manager/voice.ack-audio';

// ── Voice video & character HTML paths ────────────────────────────────
const VOICE_VIDEOS_DIR = path.join(os.homedir(), '.tms-terminal', 'voice-videos');
const CHARACTER_HTML_PATH = path.join(__dirname, '..', '..', '..', '..', 'prototype', 'voice-design', 'index.html');

// ── Global error handlers ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
  // Give the logger time to flush, then exit
  setTimeout(() => process.exit(1), 100);
});

function main(): void {
  ensureConfigDir();

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║        TMS Terminal – Server         ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Check setup
  if (!isPasswordSet()) {
    logger.error('No password configured. Run: npm run setup');
    process.exit(1);
  }

  const serverConfig = loadServerConfig();
  const port = serverConfig.port || config.port;

  // Apply JWT secret from config
  if (serverConfig.jwtSecret) {
    config.jwtSecret = serverConfig.jwtSecret;
  }

  logger.info(`Platform: ${getPlatform()}`);
  logger.info(`Shell: ${getDefaultShell()}`);

  // Initialize FCM push notifications (optional — skips gracefully if not configured)
  fcmService.init();

  // Initialize watchers (file/process/keyword monitors with push notifications)
  watcherService.init();

  // Auto-start Manager Agent in headless mode.
  // The Manager runs autonomously (heartbeat, task tracking, AI calls).
  // When a client connects, callbacks get wired up for UI streaming.
  // Until then, messages are buffered and flushed on first connect.
  if (!managerService.isEnabled()) {
    managerService.start();
    logger.info('Manager: auto-started in headless mode (no client needed)');
  }

  // TODO: TLS certificates are generated (see config.certFile / config.keyFile) but not yet used.
  // For future HTTPS implementation, create an https.Server using these certs instead of http.

  // Create HTTP server (Tailscale handles encryption)
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/auth/')) {
      handleAuthRequest(req, res);
    } else if (req.url === '/upload/screenshot' || req.url === '/upload/media') {
      handleUploadRequest(req, res);
    } else if (req.url === '/upload/drawing') {
      handleDrawingUpload(req, res);
    } else if (req.url?.startsWith('/generated-images/')) {
      // Serve generated images (JWT-protected)
      const authHeader = req.headers['authorization'] ?? '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) {
        try {
          const u = new URL(req.url, 'http://localhost');
          token = u.searchParams.get('token') ?? '';
        } catch {}
      }
      if (!token || !validateToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const filename = decodeURIComponent(req.url.replace('/generated-images/', '').split('?')[0]);
      // Prevent path traversal
      if (filename.includes('..') || filename.includes('/')) {
        res.writeHead(400); res.end('Bad request'); return;
      }
      const filePath = path.join(os.homedir(), 'Desktop', 'Image Generations', filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const ext = path.extname(filename).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(filePath).pipe(res);
    } else if (req.url?.startsWith('/generated-tts/')) {
      // Serve generated TTS audio (JWT-protected)
      const authHeader = req.headers['authorization'] ?? '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) { try { const u = new URL(req.url, 'http://localhost'); token = u.searchParams.get('token') ?? ''; } catch {} }
      if (!token || !validateToken(token)) { res.writeHead(401); res.end('Unauthorized'); return; }
      const filename = decodeURIComponent(req.url.replace('/generated-tts/', '').split('?')[0]);
      if (filename.includes('..') || filename.includes('/')) { res.writeHead(400); res.end('Bad request'); return; }
      const filePath = path.join(__dirname, '..', '..', 'generated-tts', filename);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(filePath).pipe(res);
    } else if (req.url?.startsWith('/generated-presentations/')) {
      // Serve generated presentations (JWT-protected)
      const authHeader = req.headers['authorization'] ?? '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) {
        try {
          const u = new URL(req.url, 'http://localhost');
          token = u.searchParams.get('token') ?? '';
        } catch {}
      }
      if (!token || !validateToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const filename = decodeURIComponent(req.url.replace('/generated-presentations/', '').split('?')[0]);
      // Prevent path traversal
      if (filename.includes('..') || filename.includes('/')) {
        res.writeHead(400); res.end('Bad request'); return;
      }
      const filePath = path.join(__dirname, '..', 'generated-presentations', filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(filePath).pipe(res);
    } else if (req.url?.startsWith('/voice-videos/')) {
      // Serve voice video loops (public, no auth — Tailscale handles network trust)
      const name = req.url.slice('/voice-videos/'.length).replace(/[^a-zA-Z0-9_.-]/g, '');
      if (!name.endsWith('.mp4')) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const filePath = path.join(VOICE_VIDEOS_DIR, name);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Cache-Control': 'max-age=86400',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else if (req.url === '/voice-character.html') {
      // Serve character animation HTML (public, no auth — Tailscale handles network trust)
      if (!fs.existsSync(CHARACTER_HTML_PATH)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=3600' });
      fs.createReadStream(CHARACTER_HTML_PATH).pipe(res);
      return;
    } else if (req.url?.startsWith('/files/')) {
      // JWT-protected file browser endpoints
      // Accept token from Authorization header OR ?token= query param (for Image/download URLs)
      const authHeader = req.headers['authorization'] ?? '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) {
        try {
          const u = new URL(req.url, 'http://localhost');
          token = u.searchParams.get('token') ?? '';
        } catch {}
      }
      if (!token || !validateToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.url.startsWith('/files/list'))          handleFileList(req, res);
      else if (req.url.startsWith('/files/read'))      handleFileRead(req, res);
      else if (req.url.startsWith('/files/download'))  handleFileDownload(req, res);
      else if (req.url.startsWith('/files/mkdir') && req.method === 'POST')  handleMkdir(req, res);
      else if (req.url.startsWith('/files/move') && req.method === 'POST')   handleMove(req, res);
      else if (req.url.startsWith('/files/trash') && req.method === 'POST')  handleTrash(req, res);
      else { res.writeHead(404); res.end('Not found'); }
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', platform: getPlatform() }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // Attach WebSocket
  const wss = createWebSocketServer(server);

  server.listen(port, '0.0.0.0', () => {
    logger.success(`Server listening on http://0.0.0.0:${port}`);
    logger.info('Waiting for connections...');

    // Ensure voice-videos directory exists
  if (!fs.existsSync(VOICE_VIDEOS_DIR)) {
    fs.mkdirSync(VOICE_VIDEOS_DIR, { recursive: true, mode: 0o700 });
    logger.info(`Voice: created videos directory at ${VOICE_VIDEOS_DIR}`);
  }

    // Initialize ack audio pre-generation (fire-and-forget)
    ensureAckAudios().catch((err) => {
      logger.warn(`Voice: ack audio init failed: ${err instanceof Error ? err.message : err}`);
    });

    // Log CHARACTER_HTML_PATH for verification
    logger.info(`Voice: character HTML path: ${CHARACTER_HTML_PATH}`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    const forceExit = setTimeout(() => { logger.warn('Forced exit after timeout'); process.exit(1); }, 5000);
    forceExit.unref();
    logger.info('Shutting down...');
    watcherService.shutdown();
    shutdownWhisper();

    // Close all terminal sessions
    globalManager.closeAllSessions();

    // Close all WebSocket connections
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }

    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
