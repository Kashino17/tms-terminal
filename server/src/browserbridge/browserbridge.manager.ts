// Terminal→app browser bridge: holds the global toggle, decides whether a
// captured browser-open goes to the app or opens locally, and relays the OAuth
// localhost callback to the CLI's loopback listener (Weg A — server-relay).
// See docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { isLoopbackCallbackUrl } from './url.utils';

type Notifier = (ev: { url: string; host: string; sessionId: string }) => void;

class BrowserBridgeManager {
  /** Per-process secret injected into every PTY; gates the loopback endpoint. */
  readonly secret = randomBytes(24).toString('hex');
  private enabled = false;
  private notifier: Notifier | null = null;

  setEnabled(on: boolean): void { this.enabled = on; }
  isEnabled(): boolean { return this.enabled; }
  /** Bound to the current app WebSocket; null when no app is connected. */
  setNotifier(fn: Notifier | null): void { this.notifier = fn; }

  /** 'handled' → the app was notified; 'local' → shim should open on the PC. */
  decideOpen(url: string, sessionId: string): 'handled' | 'local' {
    if (!this.enabled || !this.notifier) return 'local';
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep '' */ }
    this.notifier({ url, host, sessionId });
    return 'handled';
  }

  /** GET the CLI's loopback callback so it receives its OAuth code. Refuses any
   *  non-loopback host (no SSRF to other addresses). */
  async relayCallback(url: string): Promise<{ status: number; html: string }> {
    if (!isLoopbackCallbackUrl(url)) throw new Error('relayCallback: refusing non-loopback host');
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, html: body }));
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => req.destroy(new Error('relay timeout')));
    });
  }
}

export const browserBridge = new BrowserBridgeManager();
