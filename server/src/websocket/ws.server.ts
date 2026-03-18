import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { handleConnection } from './ws.handler';
import { authenticateWebSocket } from '../auth/auth.middleware';
import { logger } from '../utils/logger';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MISSED_PONGS = 2;

export function createWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576, // 1 MB
  });

  server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
    if (!authenticateWebSocket(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
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
