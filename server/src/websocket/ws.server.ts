import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { handleConnection } from './ws.handler';
import { authenticateWebSocket } from '../auth/auth.middleware';
import { logger } from '../utils/logger';

const HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds — faster dead-connection detection on mobile
const MAX_MISSED_PONGS = 3; // terminate after 3 missed pongs (45s window — tolerates packet loss on mobile)

export function createWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 10_485_760, // 10 MB (TTS audio can be 3-5 MB base64)
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 }, // fastest compression, still good ratio for text
      threshold: 128,                   // only compress messages > 128 bytes
      concurrencyLimit: 10,
    },
  });

  server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
    if (!authenticateWebSocket(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req); // required for noServer mode — registers pong handler
      const ip = req.socket.remoteAddress || 'unknown';
      handleConnection(ws, ip);
    });
  });

  // ── Server-side heartbeat ──────────────────────────────────────────
  // Track liveness per-client using a WeakMap to avoid memory leaks
  const aliveMap = new WeakMap<WebSocket, number>(); // value = missed pong count

  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = aliveMap.get(ws) ?? 0;
      if (missed >= MAX_MISSED_PONGS) {
        logger.warn('Heartbeat: terminating unresponsive client');
        ws.terminate();
        continue;
      }
      aliveMap.set(ws, missed + 1);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  heartbeatInterval.unref();

  wss.on('connection', (ws) => {
    aliveMap.set(ws, 0);
    ws.on('pong', () => {
      aliveMap.set(ws, 0);
    });
  });

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  logger.success('WebSocket server ready');
  return wss;
}
