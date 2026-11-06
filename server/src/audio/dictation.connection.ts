// Dictation messages, shared by the app's main connection and the lean
// dictation-only connection used by the Android bubble (`?role=dictation`).
//
// Why a separate connection type: every normal connection becomes the
// server's "current app socket" (manager messages, browser bridge, distill on
// close). The bubble runs in the background next to the app — it must never
// take that role away from it.

import type WebSocket from 'ws';
import { DictationManager, type DictationEvent } from './dictation';
import { ConnectionRateLimiter } from '../websocket/rate-limiter';

const DICTATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// ~1h of 96 kbit/s AAC; anything bigger is not a dictation.
const DICTATION_MAX_BYTES = 64 * 1024 * 1024;

type Out = { type: string; payload: Record<string, unknown> };

export function isDictationRequest(url: string | undefined): boolean {
  if (!url) return false;
  const q = url.indexOf('?');
  if (q < 0) return false;
  return new URLSearchParams(url.slice(q + 1)).get('role') === 'dictation';
}

/** Handles a `dictation:*` message. Returns false for anything else. */
export function handleDictationMessage(manager: DictationManager, msg: { type?: unknown; payload?: unknown }, send: (m: Out) => void): boolean {
  const type = msg.type;
  if (type !== 'dictation:start' && type !== 'dictation:chunk' && type !== 'dictation:end'
    && type !== 'dictation:cancel' && type !== 'dictation:resume') return false;
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  const id = p.id;
  if (typeof id !== 'string' || !DICTATION_ID_RE.test(id)) return true;
  const sink = (ev: DictationEvent) => {
    const { type: t, ...payload } = ev;
    send({ type: t, payload });
  };
  switch (type) {
    case 'dictation:start':
      manager.start(id, p.format === 'adts' ? 'adts' : 'file', p.enhance === true, sink);
      break;
    case 'dictation:chunk': {
      const offset = p.offset;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || typeof p.data !== 'string') return true;
      const data = Buffer.from(p.data, 'base64');
      if (offset + data.length > DICTATION_MAX_BYTES) {
        send({ type: 'dictation:error', payload: { id, message: 'Aufnahme zu groß' } });
        manager.cancel(id);
        return true;
      }
      manager.chunk(id, offset, data, sink);
      break;
    }
    case 'dictation:end': {
      const total = p.totalBytes;
      if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || total > DICTATION_MAX_BYTES) return true;
      manager.end(id, total, sink);
      break;
    }
    case 'dictation:cancel':
      manager.cancel(id);
      break;
    case 'dictation:resume':
      manager.resume(id, sink);
      break;
  }
  return true;
}

/** A connection that ONLY speaks the dictation protocol. */
export function createDictationConnectionHandler(manager: DictationManager, log: (m: string) => void) {
  return (ws: WebSocket, ip: string): void => {
    log(`[dictation] bubble connected: ${ip}`);
    const limiter = new ConnectionRateLimiter();
    const send = (m: Out) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    ws.on('message', (raw: Buffer) => {
      let msg: { type?: unknown; payload?: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg?.type !== 'string' || !limiter.consume(msg.type)) return;
      handleDictationMessage(manager, msg, send);
    });
    ws.on('close', () => log(`[dictation] bubble disconnected: ${ip}`));
  };
}
