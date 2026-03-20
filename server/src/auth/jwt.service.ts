import * as jwt from 'jsonwebtoken';
import { config, loadServerConfig } from '../config';

// Cache the secret in memory after first successful read
let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;

  const cfg = loadServerConfig();
  const secret = cfg.jwtSecret || config.jwtSecret || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('No JWT secret configured. Run setup first.');
  }
  cachedSecret = secret;
  return cachedSecret;
}

export function generateToken(): string {
  // Token never expires — the app stores it permanently
  return jwt.sign(
    { iat: Math.floor(Date.now() / 1000) },
    getSecret(),
  );
}

export function validateToken(token: string): boolean {
  try {
    jwt.verify(token, getSecret());
    return true;
  } catch {
    return false;
  }
}
