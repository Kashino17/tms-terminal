import * as http from 'http';
import { verifyPassword } from './password.service';
import { generateToken } from './jwt.service';
import { logger } from '../utils/logger';
import { config } from '../config';

interface RateLimitEntry {
  attempts: number;
  firstAttempt: number;
  blockedUntil?: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

const RATE_LIMIT_WINDOW = config.rateLimitWindow;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const AUTH_BODY_LIMIT = 1024; // 1 KB

// Prune stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW && (!entry.blockedUntil || now >= entry.blockedUntil)) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function getRateLimitEntry(ip: string): RateLimitEntry {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now - entry.firstAttempt > config.rateLimitWindow) {
    entry = { attempts: 0, firstAttempt: now };
    // Cap map size to prevent memory exhaustion
    if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      // Delete the oldest entry
      const firstKey = rateLimitMap.keys().next().value;
      if (firstKey !== undefined) rateLimitMap.delete(firstKey);
    }
    rateLimitMap.set(ip, entry);
  }

  return entry;
}

function isRateLimited(ip: string): boolean {
  const entry = getRateLimitEntry(ip);
  const now = Date.now();

  if (entry.blockedUntil && now < entry.blockedUntil) {
    return true;
  }

  if (entry.blockedUntil && now >= entry.blockedUntil) {
    rateLimitMap.delete(ip);
    return false;
  }

  return false;
}

function recordAttempt(ip: string): void {
  const entry = getRateLimitEntry(ip);
  entry.attempts++;

  if (entry.attempts >= config.rateLimitMax) {
    entry.blockedUntil = Date.now() + config.rateLimitBlock;
    logger.warn(`Rate limit: ${ip} blocked for 15 minutes`);
  }
}

function getClientIp(req: http.IncomingMessage): string {
  // Use socket remote address by default. Do NOT trust X-Forwarded-For
  // unless running behind a trusted reverse proxy (configure via config flag).
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleAuthRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // CORS headers — scoped to same-origin (no wildcard)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/auth/login') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    logger.warn(`Blocked login attempt from ${ip} (rate limited)`);
    sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    return;
  }

  let body = '';
  let bodySize = 0;
  let rejected = false;

  req.on('data', (chunk: Buffer | string) => {
    if (rejected) return;
    const chunkLen = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    bodySize += chunkLen;
    if (bodySize > AUTH_BODY_LIMIT) {
      rejected = true;
      sendJson(res, 413, { error: 'Request body too large' });
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', async () => {
    // If request was already destroyed due to body size limit, don't process
    if (rejected) return;

    try {
      const { password } = JSON.parse(body);

      if (!password || typeof password !== 'string') {
        sendJson(res, 400, { error: 'Password required' });
        return;
      }

      const valid = await verifyPassword(password);

      if (!valid) {
        recordAttempt(ip);
        logger.warn(`Failed login from ${ip}`);
        sendJson(res, 401, { error: 'Invalid password' });
        return;
      }

      // Reset rate limit on success
      rateLimitMap.delete(ip);

      const token = generateToken();
      logger.success(`Login successful from ${ip}`);
      sendJson(res, 200, { token });
    } catch {
      sendJson(res, 400, { error: 'Invalid request body' });
    }
  });
}
