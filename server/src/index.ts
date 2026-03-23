import * as http from 'http';
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
  });

  // Graceful shutdown
  const shutdown = (): void => {
    const forceExit = setTimeout(() => { logger.warn('Forced exit after timeout'); process.exit(1); }, 5000);
    forceExit.unref();
    logger.info('Shutting down...');
    watcherService.shutdown();

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
