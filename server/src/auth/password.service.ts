import * as bcrypt from 'bcrypt';
import { loadServerConfig, saveServerConfig } from '../config';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string): Promise<boolean> {
  const cfg = loadServerConfig();
  if (!cfg.passwordHash) return false;
  return bcrypt.compare(password, cfg.passwordHash);
}

export async function setPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  saveServerConfig({ passwordHash: hash });
}

export function isPasswordSet(): boolean {
  const cfg = loadServerConfig();
  return !!cfg.passwordHash;
}
