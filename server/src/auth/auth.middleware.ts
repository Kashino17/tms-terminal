import * as http from 'http';
import { validateToken } from './jwt.service';
import { logger } from '../utils/logger';

export function authenticateWebSocket(req: http.IncomingMessage): boolean {
  const parsed = new URL(req.url || '', 'http://localhost');
  const token = parsed.searchParams.get('token');

  if (!token) {
    logger.warn('WebSocket connection rejected: no token');
    return false;
  }

  if (!validateToken(token)) {
    logger.warn('WebSocket connection rejected: invalid token');
    return false;
  }

  return true;
}
