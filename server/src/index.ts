import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config, loadServerConfig, ensureConfigDir } from './config';
import { handleAuthRequest } from './auth/auth.controller';
import { handleOpenUrl } from './browserbridge/open-url.handler';
import { handleFileList, handleFileRead, handleFileDownload, handleMkdir, handleMove, handleTrash, handleRename } from './files/file.handler';
import { handleFileZip } from './files/zip.handler';
import { handlePdfjsAsset } from './files/pdfjs.handler';
import { handleUploadRequest, handleDrawingUpload } from './upload/upload.handler';
import { validateToken } from './auth/jwt.service';
import { createWebSocketServer } from './websocket/ws.server';
import { isPasswordSet } from './auth/password.service';
import { logger } from './utils/logger';
import { getPlatform, getDefaultShell } from './utils/platform';
import { fcmService } from './notifications/fcm.service';
import { watcherService } from './watchers/watcher.service';
import { globalManager } from './terminal/terminal.manager';
import { Snapshotter, setActiveSnapshotter } from './terminal/restore/snapshotter';
import { restoreTerminals } from './terminal/restore/restore';
import { consumeSnapshot } from './terminal/restore/snapshot.store';
import { PtyDaemonClient } from './terminal/ptyd/client';
import { usePtyKeeper } from './terminal/terminal.factory';
import { titleStore } from './terminal/titles';
import { clipboardHub } from './clipboard';
import { shutdown as shutdownWhisper, prewarm as prewarmWhisper } from './audio/whisper-sidecar';
import { shutdown as shutdownRewriter, prewarm as prewarmRewriter } from './audio/prompt-rewriter-sidecar';
import { managerService } from './websocket/ws.handler';
import { isAutoApprove, setAutoApprove } from './websocket/auto.approve.state';

// ── Global error handlers ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
  // Give the logger time to flush, then exit
  setTimeout(() => process.exit(1), 100);
});

async function main(): Promise<void> {
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
  // Terminal-Waechter (ptyd): haelt die Terminals ausserhalb dieses Prozesses,
  // damit ein Neustart, ein Update oder ein Absturz des Servers sie NICHT mehr
  // beendet. Was dort weiterlief, wird hier einfach uebernommen — kein
  // Wiederherstellen, kein `claude --resume`: Claude hat nichts gemerkt.
  // Windows bleibt beim direkten Weg.
  let keeper: PtyDaemonClient | null = null;
  const adoptedIds = new Set<string>();
  if (getPlatform() !== 'win32') {
    // Unix-Socket-Pfade sind auf macOS auf 104 Zeichen begrenzt (sonst EINVAL
    // beim listen). Bei einem ungewoehnlich langen Home-Pfad nach /tmp
    // ausweichen — der Socket selbst ist ohnehin nur fuer uns lesbar (0600).
    const preferred = path.join(config.configDir, 'ptyd.sock');
    const socketPath = preferred.length <= 100
      ? preferred
      : path.join('/tmp', `tms-ptyd-${process.getuid?.() ?? 'u'}.sock`);
    keeper = await PtyDaemonClient.start(
      socketPath,
      require.resolve('./terminal/ptyd/daemon'),
      path.join(config.configDir, 'ptyd.log'),
    );
    if (keeper) {
      usePtyKeeper(keeper);
      for (const t of keeper.adopted) {
        try {
          globalManager.adoptSession(t.id, t.pty, t.cols, t.rows);
          adoptedIds.add(t.id);
        } catch (e) {
          logger.warn(`Terminal-Waechter: ${t.id} nicht uebernommen — ${(e as Error).message}`);
        }
      }
      logger.info(`Terminal-Waechter (pid ${keeper.daemonPid}): ${adoptedIds.size} laufende(s) Terminal(s) uebernommen`);
    } else {
      logger.warn('Terminal-Waechter nicht erreichbar — Terminals haengen direkt am Server und sterben mit einem Neustart');
    }
  }

  // Terminals aus der letzten Aufnahme zurueckholen — nur noch die, die NICHT
  // im Waechter weiterliefen (z. B. nach einem Neustart des Macs). Laeuft vor
  // dem Manager, damit dessen erste Uebersicht die Terminals schon kennt.
  const restoreResult = await restoreTerminals({
    now: () => Date.now(),
    takeSnapshot: () => {
      const snap = consumeSnapshot();
      if (!snap) return snap;
      // Uebernommene Terminals behalten ihren Auto-Approve-Schalter.
      for (const e of snap.entries) {
        if (adoptedIds.has(e.id)) setAutoApprove(e.id, e.autoApprove ?? true);
      }
      return { ...snap, entries: snap.entries.filter((e) => !adoptedIds.has(e.id)) };
    },
    // Sendet KEIN Signal — prueft nur, ob der Prozess existiert.
    isPidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    createSession: (entry, onOutput) => {
      try {
        globalManager.createSession(
          { id: entry.id, cwd: entry.cwd, cols: entry.cols, rows: entry.rows },
          (_id, data) => onOutput(data),
          () => { /* Schliessen laeuft ueber den normalen Weg, sobald ein Client dranhaengt */ },
        );
        return true;
      } catch {
        return false;
      }
    },
    writeToSession: (id, data) => { globalManager.write(id, data); },
    markSession: (id, text) => { globalManager.injectOutput(id, text); },
    applyAutoApprove: (id, on) => setAutoApprove(id, on),
    maxSessions: 50,
  });

  // Titel von Terminals, die es nach Waechter-Uebernahme und Wiederherstellung
  // nicht mehr gibt, sind Ballast. Die uebrigen geben dem Manager gleich die
  // richtigen Namen (statt "Shell 4" in seinen Meldungen).
  titleStore.prune(new Set(globalManager.listSessions().map((x) => x.id)));
  clipboardHub.start(); // gemeinsame Zwischenablage: Kopien am Mac landen im Verlauf
  for (const [id, title] of Object.entries(titleStore.all())) managerService.setSessionLabel(id, title);

  if (!managerService.isEnabled()) {
    managerService.start();
    logger.info('Manager: auto-started in headless mode (no client needed)');
  }
  if (restoreResult.restored.length > 0) {
    const parts = [`${restoreResult.restored.length} Terminal(s) nach dem Neustart wiederhergestellt.`];
    if (restoreResult.resumed.length > 0) {
      parts.push(`${restoreResult.resumed.length} Claude-Sitzung(en) fortgesetzt.`);
    }
    if (restoreResult.interrupted.length > 0) {
      // Der Teil, der wirklich gesagt werden muss: diese Sitzungen arbeiten
      // NICHT weiter, sie warten auf eine Eingabe.
      parts.push(
        `${restoreResult.interrupted.length} davon wurde(n) mitten in der Arbeit ` +
        `unterbrochen und wartet/warten jetzt auf dich.`,
      );
    }
    if (restoreResult.failed.length > 0) {
      parts.push(`${restoreResult.failed.length} liess(en) sich nicht wiederherstellen.`);
    }
    managerService.pushSystemNotice(`\u267b\ufe0f ${parts.join(' ')}`, `restore:${Date.now()}`);
  }

  // Ab jetzt laufend mitschreiben — auch ein Absturz soll abgedeckt sein,
  // und da laeuft kein Signal-Handler mehr.
  const snapshotter = new Snapshotter({
    now: () => Date.now(),
    serverPid: process.pid,
    source: {
      listSessions: () => globalManager.listSessions().map(sess => ({
        id: sess.id, pid: sess.pty.pid, cols: sess.cols, rows: sess.rows, cwd: sess.cwd,
      })),
      labelFor: (id) => managerService.getSessionList().find(x => x.sessionId === id)?.label,
      autoApproveFor: (id) => isAutoApprove(id),
    },
  });
  snapshotter.start();
  setActiveSnapshotter(snapshotter);


  // TODO: TLS certificates are generated (see config.certFile / config.keyFile) but not yet used.
  // For future HTTPS implementation, create an https.Server using these certs instead of http.

  // Create HTTP server (Tailscale handles encryption)
  const server = http.createServer((req, res) => {
    // Browser-Bridge: the tms-open shim (loopback + per-PTY secret) POSTs
    // captured http(s) browser-opens here. See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
    if (req.method === 'POST' && req.url === '/internal/open-url') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const out = handleOpenUrl(body, req.socket.remoteAddress ?? undefined);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
      return;
    }
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
    } else if (req.url?.startsWith('/files/')) {
      // pdf.js viewer assets are public statics — the PDF itself still needs
      // the token via /files/download.
      if (req.url.startsWith('/files/pdfjs/')) { handlePdfjsAsset(req, res); return; }
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
      else if (req.url.startsWith('/files/rename') && req.method === 'POST') handleRename(req, res);
      else if (req.url.startsWith('/files/zip'))      handleFileZip(req, res);
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

    // Warm both audio sidecars in the background so the first dictation after
    // a server restart never pays the model-load (or iCloud re-download) cost.
    void prewarmWhisper();
    void prewarmRewriter();
  });

  // Graceful shutdown
  const shutdown = (): void => {
    const forceExit = setTimeout(() => { logger.warn('Forced exit after timeout'); process.exit(1); }, 5000);
    forceExit.unref();
    logger.info('Shutting down...');
    void titleStore.flush();
    clipboardHub.stop();
    watcherService.shutdown();
    shutdownWhisper();
    shutdownRewriter();

    // Letzte, exakte Aufnahme — fuer den Fall, dass auch der Waechter nicht
    // ueberlebt (Neustart des Macs).
    snapshotter.stop();
    void snapshotter.captureNow();

    // Mit Waechter: loslassen, NICHT beenden — die Terminals laufen weiter und
    // der naechste Server uebernimmt sie. Ohne Waechter sind die PTYs unsere
    // Kinder und muessen sauber beendet werden.
    if (keeper) {
      globalManager.releaseAllSessions();
      keeper.release();
    } else {
      globalManager.closeAllSessions();
    }

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

void main();
