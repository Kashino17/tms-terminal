// Loopback-only endpoint the tms-open shim POSTs to. Gated by the per-PTY
// secret so no other local process can inject URLs.
// See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
import { browserBridge } from './browserbridge.manager';
import { isForwardableUrl } from './url.utils';

// Node reports loopback callers with these remoteAddress values.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function handleOpenUrl(
  reqBody: string,
  remoteAddr: string | undefined,
): { status: number; json: { action: 'handled' | 'local' } | { error: string } } {
  if (!remoteAddr || !LOOPBACK.has(remoteAddr)) return { status: 403, json: { error: 'not loopback' } };
  let b: { url?: string; sessionId?: string; secret?: string };
  try {
    b = JSON.parse(reqBody);
  } catch {
    return { status: 400, json: { error: 'bad json' } };
  }
  if (b.secret !== browserBridge.secret) return { status: 403, json: { error: 'bad secret' } };
  if (!b.url || !isForwardableUrl(b.url)) return { status: 400, json: { error: 'bad url' } };
  const action = browserBridge.decideOpen(b.url, b.sessionId ?? '');
  return { status: 200, json: { action } };
}
