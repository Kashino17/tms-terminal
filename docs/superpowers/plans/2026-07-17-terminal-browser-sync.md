# Terminal → App Browser-Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a CLI in a TMS terminal opens a browser (e.g. `vercel login`), forward the URL to the phone's in-app browser and relay the OAuth `localhost` callback back to the PC over Tailscale, so browser logins can be completed from the phone.

**Architecture:** A PTY-injected `tms-open` shim intercepts `http(s)` browser-opens and POSTs them to a loopback-only server endpoint. If a global app toggle is ON, the server pushes the URL to the app (In-App-Browser + FCM push); otherwise the shim opens locally. After login, the in-app WebView intercepts navigations to `localhost`/`127.0.0.1` and relays the full callback URL over the existing WebSocket to the server, which fetches it on loopback so the waiting CLI receives its token (Weg A — server-relay).

**Tech Stack:** Node.js + TypeScript + node-pty + ws (server); React Native + Expo + react-native-webview (app); Node built-in test runner (`node --test` via ts-node).

## Global Constraints

- Server tests: `node --require ts-node/register --test 'src/**/*.test.ts'` (import from `node:test` + `node:assert/strict`).
- No new open ports on the Tailscale interface. The loopback endpoint binds to the existing HTTP server; access is gated by a per-PTY secret.
- The relay may fetch **only** hosts `localhost`, `127.0.0.1`, `[::1]` — never other addresses.
- Toggle defaults **OFF**. When OFF or no app connected, browser-opens fall back to opening locally on the PC (never swallowed).
- Only `http`/`https` URLs are intercepted by the shim; every other argument (`open .`, `open file.txt`, `open -a App`) is passed to the real binary unchanged.
- UI strings German; code/comments English (project convention).
- Primary target platform: macOS (real `open` = `/usr/bin/open`). Linux/Windows shims are best-effort.

---

## File Structure

**Server (`server/`)**
- Create `src/browserbridge/url.utils.ts` — pure predicates: `isForwardableUrl`, `isLoopbackCallbackUrl`.
- Create `src/browserbridge/shim.ts` — `materializeShimDir()` + the embedded `tms-open` Node script source.
- Create `src/browserbridge/browserbridge.manager.ts` — toggle state, `decideOpen`, `relayCallback`, app-notify + push hooks (singleton).
- Modify `src/utils/platform.ts` — `getTermEnv()` injects PATH/BROWSER/secret/port.
- Modify `src/terminal/terminal.factory.ts` + `src/terminal/terminal.manager.ts` — inject per-session `TMS_SESSION_ID`.
- Modify `src/index.ts` — `POST /internal/open-url` loopback endpoint.
- Modify `src/websocket/ws.handler.ts` — handle `browserbridge:toggle` / `browserbridge:callback`; wire manager's notify hook to `send(ws, …)`.

**Shared (`shared/`)**
- Modify `protocol.ts` — add `browserbridge:*` client/server message types.

**App (`mobile/src/`)**
- Create `store/browserBridgeStore.ts` — global toggle (persisted), mirrors pattern of `store/autoApproveStore.ts`.
- Modify `season2/SeasonTwoWebRoot.tsx` — handle `browserbridge:open` / `browserbridge:callback_result`; send `browserbridge:toggle`; relay `browserbridge:callback` from the WebView.
- Modify `season2/web/NativeBrowserLayer.tsx` — `onShouldStartLoadWithRequest` localhost interceptor → `BrowserHandle.onLoopbackCallback`.
- Modify `season2/web/bridge.js` + master-worktree mockup — settings row for the toggle (see Task 9).
- Modify `services/notifications.service.ts` — local/FCM push "🔐 Login öffnen".

Natural ordering: build & test the server half (Tasks 1–8) first — it's independently testable — then the app half (Tasks 9–12), then on-device verification (Task 13).

---

### Task 1: URL predicates (pure, testable)

**Files:**
- Create: `server/src/browserbridge/url.utils.ts`
- Test: `server/src/browserbridge/url.utils.test.ts`

**Interfaces:**
- Produces: `isForwardableUrl(arg: string): boolean`, `isLoopbackCallbackUrl(url: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/browserbridge/url.utils.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isForwardableUrl, isLoopbackCallbackUrl } from './url.utils';

test('isForwardableUrl: only http/https', () => {
  assert.equal(isForwardableUrl('https://vercel.com/oauth'), true);
  assert.equal(isForwardableUrl('http://example.com'), true);
  assert.equal(isForwardableUrl('/Users/x/file.txt'), false); // `open file`
  assert.equal(isForwardableUrl('.'), false);                 // `open .`
  assert.equal(isForwardableUrl('-a'), false);                // `open -a App`
  assert.equal(isForwardableUrl('file:///tmp/x'), false);
  assert.equal(isForwardableUrl(''), false);
});

test('isLoopbackCallbackUrl: only localhost hosts', () => {
  assert.equal(isLoopbackCallbackUrl('http://localhost:51763/cb?code=1'), true);
  assert.equal(isLoopbackCallbackUrl('http://127.0.0.1:8976/cb'), true);
  assert.equal(isLoopbackCallbackUrl('http://[::1]:9000/cb'), true);
  assert.equal(isLoopbackCallbackUrl('https://vercel.com/cb'), false);
  assert.equal(isLoopbackCallbackUrl('http://100.64.0.1:9000/cb'), false); // Tailscale IP is NOT loopback
  assert.equal(isLoopbackCallbackUrl('not a url'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/browserbridge/url.utils.test.ts`
Expected: FAIL — `Cannot find module './url.utils'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/browserbridge/url.utils.ts
export function isForwardableUrl(arg: string): boolean {
  if (!arg) return false;
  try {
    const u = new URL(arg);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function isLoopbackCallbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(host) || host === '::1';
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/browserbridge/url.utils.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/browserbridge/url.utils.ts server/src/browserbridge/url.utils.test.ts
git commit -m "feat(browserbridge): url predicates (forwardable + loopback)"
```

---

### Task 2: BrowserBridge manager (toggle + decision + relay)

**Files:**
- Create: `server/src/browserbridge/browserbridge.manager.ts`
- Test: `server/src/browserbridge/browserbridge.manager.test.ts`

**Interfaces:**
- Consumes: `isLoopbackCallbackUrl` (Task 1)
- Produces (singleton `browserBridge`):
  - `setEnabled(on: boolean): void`
  - `isEnabled(): boolean`
  - `readonly secret: string`
  - `setNotifier(fn: ((ev: { url: string; host: string; sessionId: string }) => void) | null): void`
  - `decideOpen(url: string, sessionId: string): 'handled' | 'local'`
  - `relayCallback(url: string): Promise<{ status: number; html: string }>`

`decideOpen` returns `'local'` when disabled OR no notifier is set (no app connected); otherwise it calls the notifier and returns `'handled'`. `relayCallback` rejects non-loopback URLs and otherwise does a GET on loopback.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/browserbridge/browserbridge.manager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { browserBridge } from './browserbridge.manager';

test('decideOpen: local when disabled', () => {
  browserBridge.setEnabled(false);
  browserBridge.setNotifier(() => {});
  assert.equal(browserBridge.decideOpen('https://x.com', 's1'), 'local');
});

test('decideOpen: local when no notifier even if enabled', () => {
  browserBridge.setEnabled(true);
  browserBridge.setNotifier(null);
  assert.equal(browserBridge.decideOpen('https://x.com', 's1'), 'local');
});

test('decideOpen: handled + notifies when enabled and connected', () => {
  browserBridge.setEnabled(true);
  const seen: any[] = [];
  browserBridge.setNotifier((ev) => seen.push(ev));
  const r = browserBridge.decideOpen('https://vercel.com/oauth?x=1', 's7');
  assert.equal(r, 'handled');
  assert.deepEqual(seen, [{ url: 'https://vercel.com/oauth?x=1', host: 'vercel.com', sessionId: 's7' }]);
});

test('relayCallback: rejects non-loopback', async () => {
  await assert.rejects(() => browserBridge.relayCallback('https://evil.com/cb'));
});

test('relayCallback: GETs the loopback callback and returns body', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('CLI GOT ' + req.url); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  const out = await browserBridge.relayCallback(`http://127.0.0.1:${port}/cb?code=abc`);
  assert.equal(out.status, 200);
  assert.equal(out.html, 'CLI GOT /cb?code=abc');
  srv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/browserbridge/browserbridge.manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/browserbridge/browserbridge.manager.ts
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { isLoopbackCallbackUrl } from './url.utils';

type Notifier = (ev: { url: string; host: string; sessionId: string }) => void;

class BrowserBridgeManager {
  readonly secret = randomBytes(24).toString('hex');
  private enabled = false;
  private notifier: Notifier | null = null;

  setEnabled(on: boolean): void { this.enabled = on; }
  isEnabled(): boolean { return this.enabled; }
  setNotifier(fn: Notifier | null): void { this.notifier = fn; }

  decideOpen(url: string, sessionId: string): 'handled' | 'local' {
    if (!this.enabled || !this.notifier) return 'local';
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep '' */ }
    this.notifier({ url, host, sessionId });
    return 'handled';
  }

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/browserbridge/browserbridge.manager.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/browserbridge/browserbridge.manager.ts server/src/browserbridge/browserbridge.manager.test.ts
git commit -m "feat(browserbridge): manager with toggle, open-decision, loopback relay"
```

---

### Task 3: `tms-open` shim + shim-dir materializer

**Files:**
- Create: `server/src/browserbridge/shim.ts`
- Test: `server/src/browserbridge/shim.test.ts`

**Interfaces:**
- Consumes: `browserBridge.secret` (Task 2) is passed via env at runtime, not import.
- Produces: `materializeShimDir(): string` (returns an absolute dir containing an executable `tms-open` plus command-name symlinks `open`, `xdg-open`, `sensible-browser`, `www-browser`).

The shim script logic (embedded as a string in `shim.ts`, written to disk):
1. `cmd = basename(argv[1])`; `arg = first non-flag argv after 2`.
2. If `arg` is an http(s) URL → POST `{url, sessionId, secret}` to `http://127.0.0.1:$TMS_SERVER_PORT/internal/open-url`. On `{action:'handled'}` exit 0. On `{action:'local'}` or any failure → fall through to open-locally.
3. Open-locally: if `cmd === 'tms-open'`, use the platform opener (`/usr/bin/open` on darwin, `xdg-open` on linux); else `exec` the real `cmd` found on PATH **excluding** the shim dir.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/browserbridge/shim.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { materializeShimDir } from './shim';

test('materializeShimDir creates executable tms-open + command symlinks', () => {
  const dir = materializeShimDir();
  const tmsOpen = path.join(dir, 'tms-open');
  assert.ok(fs.existsSync(tmsOpen), 'tms-open exists');
  // executable bit
  assert.ok((fs.statSync(tmsOpen).mode & 0o111) !== 0, 'tms-open is executable');
  for (const name of ['open', 'xdg-open', 'sensible-browser', 'www-browser']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} exists`);
  }
  // script contains the loopback endpoint path and URL guard
  const src = fs.readFileSync(tmsOpen, 'utf8');
  assert.ok(src.includes('/internal/open-url'));
  assert.ok(src.includes('http:') && src.includes('https:'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/browserbridge/shim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/browserbridge/shim.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The shim runs as a standalone Node process inside the PTY. It reuses no
// project imports (it may run under any Node on PATH), so the URL guard is
// inlined. `open`/`xdg-open`/… are symlinks to this file; basename(argv[1])
// tells us which command we're standing in for.
const SHIM_SRC = `#!/usr/bin/env node
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cmd = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const urlArg = args.find((a) => /^https?:\\/\\//i.test(a));

function realBinary(name) {
  if (name === 'open') return '/usr/bin/open'; // macOS stable path
  const shimDir = path.dirname(process.argv[1]);
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (!p || path.resolve(p) === path.resolve(shimDir)) continue;
    const cand = path.join(p, name);
    try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch {}
  }
  return null;
}

function openLocally() {
  if (cmd === 'tms-open') {
    const opener = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    spawn(opener, args, { stdio: 'ignore', detached: true }).unref();
    return process.exit(0);
  }
  const real = realBinary(cmd);
  if (!real) process.exit(0);
  const child = spawn(real, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
}

if (!urlArg) return openLocally();

const body = JSON.stringify({
  url: urlArg,
  sessionId: process.env.TMS_SESSION_ID || '',
  secret: process.env.TMS_BROWSERBRIDGE_SECRET || '',
});
const req = http.request(
  { host: '127.0.0.1', port: process.env.TMS_SERVER_PORT || '8767',
    path: '/internal/open-url', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
  (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      let action = 'local';
      try { action = JSON.parse(d).action; } catch {}
      if (action === 'handled') process.exit(0);
      openLocally();
    });
  },
);
req.on('error', openLocally); // server down → open on the PC, never swallow
req.write(body);
req.end();
`;

let cachedDir: string | null = null;

export function materializeShimDir(): string {
  if (cachedDir && fs.existsSync(path.join(cachedDir, 'tms-open'))) return cachedDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-browserbridge-'));
  const tmsOpen = path.join(dir, 'tms-open');
  fs.writeFileSync(tmsOpen, SHIM_SRC, { mode: 0o755 });
  for (const name of ['open', 'xdg-open', 'sensible-browser', 'www-browser']) {
    const link = path.join(dir, name);
    try { fs.symlinkSync('tms-open', link); } catch { fs.copyFileSync(tmsOpen, link); fs.chmodSync(link, 0o755); }
  }
  cachedDir = dir;
  return dir;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --require ts-node/register --test src/browserbridge/shim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/browserbridge/shim.ts server/src/browserbridge/shim.test.ts
git commit -m "feat(browserbridge): tms-open shim + shim-dir materializer"
```

---

### Task 4: Inject shim env into PTYs

**Files:**
- Modify: `server/src/utils/platform.ts` (`getTermEnv`)
- Modify: `server/src/terminal/terminal.factory.ts` (`createPty` — accept per-session extra env)
- Modify: `server/src/terminal/terminal.manager.ts` (pass `sessionId` at spawn)
- Test: `server/src/utils/platform.test.ts`

**Interfaces:**
- Consumes: `materializeShimDir` (Task 3), `browserBridge.secret` (Task 2)
- Produces: `getTermEnv()` now sets `BROWSER`, prepends the shim dir to `PATH`, sets `TMS_BROWSERBRIDGE_SECRET`, `TMS_SERVER_PORT`. `createPty(cols, rows, extraEnv?: Record<string,string>)` merges `extraEnv` (used for `TMS_SESSION_ID`).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/browserbridge env injection — add to server/src/utils/platform.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTermEnv } from './platform';
import * as path from 'node:path';

test('getTermEnv injects the browser-bridge shim', () => {
  const env = getTermEnv();
  assert.ok(env.BROWSER && env.BROWSER.endsWith('tms-open'), 'BROWSER points at tms-open');
  assert.ok(env.TMS_BROWSERBRIDGE_SECRET && env.TMS_BROWSERBRIDGE_SECRET.length >= 16);
  const shimDir = path.dirname(env.BROWSER);
  assert.ok(env.PATH.split(path.delimiter)[0] === shimDir, 'shim dir is first on PATH');
  assert.ok(env.TMS_SERVER_PORT && env.TMS_SERVER_PORT.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/utils/platform.test.ts`
Expected: FAIL — `env.BROWSER` is undefined.

- [ ] **Step 3: Implement (getTermEnv)** — inside `getTermEnv`, after the base `env` object is built and before `if (platform === 'win32')`, insert:

```ts
  // ── Browser-Bridge: capture http(s) browser-opens from CLIs and route them to
  //    the phone (see docs/superpowers/specs/2026-07-17-terminal-browser-sync-design.md).
  //    The shim opens locally as a fallback whenever the toggle is off / no app.
  const { materializeShimDir } = require('../browserbridge/shim') as typeof import('../browserbridge/shim');
  const { browserBridge } = require('../browserbridge/browserbridge.manager') as typeof import('../browserbridge/browserbridge.manager');
  const shimDir = materializeShimDir();
  env.PATH = shimDir + path.delimiter + (env.PATH || process.env.PATH || '');
  env.BROWSER = path.join(shimDir, 'tms-open');
  env.TMS_BROWSERBRIDGE_SECRET = browserBridge.secret;
  env.TMS_SERVER_PORT = process.env.TMS_TERMINAL_PORT || String(getConfiguredPort());
```

Note: add `import * as path from 'node:path';` at the top of `platform.ts` if absent, and resolve `getConfiguredPort()` to however the server reads its port (see `src/index.ts`; if the port is a module constant, import it — do not hardcode `8767`). Because `getTermEnv` is cached, the shim dir + secret are computed once, which is correct (they are stable for the process lifetime).

- [ ] **Step 4: Implement per-session id** — `createPty`:

```ts
// server/src/terminal/terminal.factory.ts — signature + opts.env
export function createPty(cols: number, rows: number, extraEnv: Record<string, string> = {}): pty.IPty {
  // ...
  const env = { ...getTermEnv(), ...extraEnv };
  // ... unchanged, opts.env = env
}
```

In `terminal.manager.ts`, at the call site that creates the pty for a session, pass the session id (use whatever id the manager assigns to the session — the same value later used in WS `terminal:*` messages):

```ts
const pty = createPty(cols, rows, { TMS_SESSION_ID: session.id });
```

- [ ] **Step 5: Run tests**

Run: `cd server && node --require ts-node/register --test src/utils/platform.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/utils/platform.ts server/src/utils/platform.test.ts server/src/terminal/terminal.factory.ts server/src/terminal/terminal.manager.ts
git commit -m "feat(browserbridge): inject shim env + per-session TMS_SESSION_ID into PTYs"
```

---

### Task 5: Loopback `POST /internal/open-url` endpoint

**Files:**
- Modify: `server/src/index.ts` (HTTP request handler)
- Create: `server/src/browserbridge/open-url.handler.ts`
- Test: `server/src/browserbridge/open-url.handler.test.ts`

**Interfaces:**
- Consumes: `browserBridge` (Task 2), `isForwardableUrl` (Task 1)
- Produces: `handleOpenUrl(reqBody: string, remoteAddr: string | undefined): { status: number; json: { action: 'handled' | 'local' } | { error: string } }` — a pure function so `index.ts` just wires req/res to it.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/browserbridge/open-url.handler.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOpenUrl } from './open-url.handler';
import { browserBridge } from './browserbridge.manager';

const good = (extra = {}) => JSON.stringify({ url: 'https://vercel.com/o', sessionId: 's1', secret: browserBridge.secret, ...extra });

test('rejects non-loopback caller', () => {
  const r = handleOpenUrl(good(), '100.64.0.9');
  assert.equal(r.status, 403);
});

test('rejects bad secret', () => {
  const r = handleOpenUrl(JSON.stringify({ url: 'https://x', sessionId: 's', secret: 'nope' }), '127.0.0.1');
  assert.equal(r.status, 403);
});

test('rejects non-forwardable url', () => {
  const r = handleOpenUrl(good({ url: '/tmp/f' }), '127.0.0.1');
  assert.equal(r.status, 400);
});

test('enabled+connected → handled', () => {
  browserBridge.setEnabled(true); browserBridge.setNotifier(() => {});
  const r = handleOpenUrl(good(), '127.0.0.1');
  assert.deepEqual(r.json, { action: 'handled' });
});

test('disabled → local', () => {
  browserBridge.setEnabled(false);
  const r = handleOpenUrl(good(), '::1');
  assert.deepEqual(r.json, { action: 'local' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --require ts-node/register --test src/browserbridge/open-url.handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/browserbridge/open-url.handler.ts
import { browserBridge } from './browserbridge.manager';
import { isForwardableUrl } from './url.utils';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function handleOpenUrl(
  reqBody: string,
  remoteAddr: string | undefined,
): { status: number; json: { action: 'handled' | 'local' } | { error: string } } {
  if (!remoteAddr || !LOOPBACK.has(remoteAddr)) return { status: 403, json: { error: 'not loopback' } };
  let b: { url?: string; sessionId?: string; secret?: string };
  try { b = JSON.parse(reqBody); } catch { return { status: 400, json: { error: 'bad json' } }; }
  if (b.secret !== browserBridge.secret) return { status: 403, json: { error: 'bad secret' } };
  if (!b.url || !isForwardableUrl(b.url)) return { status: 400, json: { error: 'bad url' } };
  const action = browserBridge.decideOpen(b.url, b.sessionId ?? '');
  return { status: 200, json: { action } };
}
```

- [ ] **Step 4: Wire into `index.ts`** — inside the existing `http.createServer((req, res) => …)` request handler, before the other route checks, add:

```ts
if (req.method === 'POST' && req.url === '/internal/open-url') {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { handleOpenUrl } = require('./browserbridge/open-url.handler') as typeof import('./browserbridge/open-url.handler');
    const out = handleOpenUrl(body, req.socket.remoteAddress ?? undefined);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.json));
  });
  return;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && node --require ts-node/register --test src/browserbridge/open-url.handler.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/browserbridge/open-url.handler.ts server/src/browserbridge/open-url.handler.test.ts server/src/index.ts
git commit -m "feat(browserbridge): loopback /internal/open-url endpoint"
```

---

### Task 6: Shared protocol message types

**Files:**
- Modify: `shared/protocol.ts`

**Interfaces:**
- Produces (added to the discriminated unions):
  - ClientMessage: `{ type: 'browserbridge:toggle'; payload: { enabled: boolean } }`, `{ type: 'browserbridge:callback'; payload: { url: string; sessionId: string } }`
  - ServerMessage: `{ type: 'browserbridge:open'; payload: { url: string; host: string; sessionId: string } }`, `{ type: 'browserbridge:callback_result'; payload: { status: number; html: string } }`

- [ ] **Step 1: Add the client message members** to the `ClientMessage` union in `shared/protocol.ts` (match the existing member formatting exactly):

```ts
  | { type: 'browserbridge:toggle'; payload: { enabled: boolean } }
  | { type: 'browserbridge:callback'; payload: { url: string; sessionId: string } }
```

- [ ] **Step 2: Add the server message members** to the `ServerMessage` union:

```ts
  | { type: 'browserbridge:open'; payload: { url: string; host: string; sessionId: string } }
  | { type: 'browserbridge:callback_result'; payload: { status: number; html: string } }
```

- [ ] **Step 3: Typecheck both sides**

Run: `cd server && npx tsc --noEmit` and `cd ../mobile && npx tsc --noEmit`
Expected: no new errors (the unions still compile; unused members are fine).

- [ ] **Step 4: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(browserbridge): protocol message types"
```

---

### Task 7: Server WS wiring (toggle + callback + notify)

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`

**Interfaces:**
- Consumes: `browserBridge` (Task 2), `send(ws, msg)` (existing, ws.handler.ts:31), the discriminated `ServerMessage` (Task 6)
- Produces: on client `browserbridge:toggle` → `browserBridge.setEnabled`; on `browserbridge:callback` → `browserBridge.relayCallback` then send `browserbridge:callback_result`; a notifier bound to the current client `ws` that sends `browserbridge:open`.

- [ ] **Step 1: Bind the notifier on connect** — where the handler already tracks the active client socket (search for `currentWs` / where `client:register_token` is handled), set:

```ts
browserBridge.setNotifier((ev) => send(ws, { type: 'browserbridge:open', payload: ev }));
```

and on socket close, clear it: `browserBridge.setNotifier(null);` (find the existing `ws.on('close', …)` block). Add `import { browserBridge } from '../browserbridge/browserbridge.manager';` at the top.

- [ ] **Step 2: Add the two cases** to the `switch (msg.type)` at ws.handler.ts:820:

```ts
      case 'browserbridge:toggle': {
        browserBridge.setEnabled(msg.payload.enabled);
        break;
      }
      case 'browserbridge:callback': {
        browserBridge.relayCallback(msg.payload.url)
          .then((r) => send(ws, { type: 'browserbridge:callback_result', payload: r }))
          .catch(() => send(ws, { type: 'browserbridge:callback_result', payload: { status: 0, html: '' } }));
        break;
      }
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors (the `msg.payload.enabled` / `.url` narrow correctly via the discriminated union).

- [ ] **Step 4: Manual smoke test** — start the server, connect a throwaway `wscat`/node client, send `{"type":"browserbridge:toggle","payload":{"enabled":true}}`, then `curl -s -XPOST http://127.0.0.1:<port>/internal/open-url -d '{"url":"https://x.com","sessionId":"s","secret":"<paste server secret from a debug log>"}'` — expect `{"action":"handled"}` and a `browserbridge:open` frame on the ws client. (Add a one-line `logger.info` of the secret behind a debug flag if needed, then remove.)

- [ ] **Step 5: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(browserbridge): ws wiring — toggle, callback relay, open notify"
```

---

### Task 8: App — global toggle store + Settings row

**Files:**
- Create: `mobile/src/store/browserBridgeStore.ts` (model on `mobile/src/store/autoApproveStore.ts`)
- Modify: `mobile/src/season2/SeasonTwoWebRoot.tsx` (send `browserbridge:toggle` on connect + on change)
- Modify master-worktree mockup `mockups/season2/liquid-deck/index.html` + `mobile/src/season2/web/bridge.js` (a Settings row that flips the toggle), then `npm run build:season2`

**Interfaces:**
- Produces: `useBrowserBridgeStore` with `{ enabled: boolean; setEnabled(on:boolean): void }`, persisted (AsyncStorage) like autoApproveStore. Bridge message `browserbridge:toggle` from a Settings switch.

- [ ] **Step 1** — Create the store mirroring `autoApproveStore.ts` (same persistence pattern), single boolean `enabled` (default `false`).
- [ ] **Step 2** — In `SeasonTwoWebRoot.tsx`, when `ready && state === 'connected'`, send the current toggle: `wsService.send({ type: 'browserbridge:toggle', payload: { enabled: useBrowserBridgeStore.getState().enabled } })`. Re-send on server switch (same effect hook that pushes other per-connection state) and whenever the toggle changes.
- [ ] **Step 3** — Add a Settings row "Terminal-Browser aufs Handy leiten" (a switch) in the Season-2 settings group (extend the group added by `renderSettings` in `bridge.js`, next to "Klassische Oberfläche"). On toggle, post a new bridge message `nav:browserbridgeToggle` → RN updates the store + sends `browserbridge:toggle`. Wire the bridge name in all three places (mockup stub, `bridge.js` override, RN `onMessage` case) exactly like the cloud messages (see `project_cloud_provider_linking` memory). Rebuild: `cd mobile && npm run build:season2`.
- [ ] **Step 4** — Typecheck: `cd mobile && npx tsc --noEmit`. Verify the Settings row renders (headless mockup render at 412×915, same method used for the cloud-link feature).
- [ ] **Step 5: Commit**

```bash
git add mobile/src/store/browserBridgeStore.ts mobile/src/season2/SeasonTwoWebRoot.tsx mobile/src/season2/web/bridge.js mobile/src/season2/web/liquidDeckHtml.ts
git commit -m "feat(browserbridge): app global toggle + settings row"
```

---

### Task 9: App — handle `browserbridge:open` (open in-app browser + push)

**Files:**
- Modify: `mobile/src/season2/SeasonTwoWebRoot.tsx`
- Modify: `mobile/src/services/notifications.service.ts`

**Interfaces:**
- Consumes: `browserbridge:open` (Task 6), the existing `call('...')` bridge, `AppState` (already imported)
- Produces: on `browserbridge:open`, if `AppState.currentState === 'active'` → `call('openBrowserUrl', payload.url)` (a thin bridge fn that calls `window.TMSBridge.openBrowser(url)`); always post a local notification "🔐 Login öffnen · {host}" whose tap opens the same url.

- [ ] **Step 1** — Add a `browserbridge:open` case to the `wsService` message effect in `SeasonTwoWebRoot.tsx` (near the `terminal:prompt_detected` handler). Foreground → open immediately; store `payload.url` as the pending login url for the notification-tap route.
- [ ] **Step 2** — In `notifications.service.ts`, add `notifyBrowserLogin(host: string, url: string)` that schedules a local notification (title "🔐 Login öffnen", body host) with data `{ kind: 'browserbridge', url }`; extend the existing notification-response handler to, on `kind==='browserbridge'`, open the in-app browser to `url`.
- [ ] **Step 3** — Add the `openBrowserUrl` bridge fn: in `bridge.js`, `window.TMSBridge.openBrowserUrl = (url) => window.TMSBridge.openBrowser(url);` (mockup already has `openBrowser`); rebuild season2.
- [ ] **Step 4** — Typecheck `cd mobile && npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add mobile/src/season2/SeasonTwoWebRoot.tsx mobile/src/services/notifications.service.ts mobile/src/season2/web/bridge.js mobile/src/season2/web/liquidDeckHtml.ts
git commit -m "feat(browserbridge): app opens in-app browser + push on login url"
```

---

### Task 10: App — WebView localhost callback interceptor

**Files:**
- Modify: `mobile/src/season2/web/NativeBrowserLayer.tsx`
- Modify: `mobile/src/season2/SeasonTwoWebRoot.tsx`

**Interfaces:**
- Consumes: react-native-webview `onShouldStartLoadWithRequest`, `browserbridge:callback` (Task 6), `browserbridge:callback_result`
- Produces: when the WebView tries to load a `localhost`/`127.0.0.1`/`[::1]` URL, cancel it and call `props.onLoopbackCallback(url)`; `SeasonTwoWebRoot` forwards it as `browserbridge:callback` and, on `browserbridge:callback_result`, shows a success page in the WebView.

- [ ] **Step 1** — In `NativeBrowserLayer.tsx`, add prop `onLoopbackCallback?: (url: string) => void` and implement `onShouldStartLoadWithRequest={(req) => { if (isLoopback(req.url)) { onLoopbackCallback?.(req.url); return false; } return true; }}` where `isLoopback` checks the host against `localhost`/`127.0.0.1`/`[::1]` (inline, same set as server `url.utils`).
- [ ] **Step 2** — In `SeasonTwoWebRoot.tsx`, pass `onLoopbackCallback={(url) => wsService.send({ type: 'browserbridge:callback', payload: { url, sessionId: pendingLoginSessionId.current ?? '' } })}` (track `pendingLoginSessionId` from the `browserbridge:open` payload in Task 9).
- [ ] **Step 3** — Handle `browserbridge:callback_result`: navigate the in-app browser to a data: success page (`data:text/html,<h2>Login abgeschlossen ✓</h2>`) on `status>=200 && <400`, else show "Login fehlgeschlagen — im Terminal prüfen".
- [ ] **Step 4** — Typecheck `cd mobile && npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add mobile/src/season2/web/NativeBrowserLayer.tsx mobile/src/season2/SeasonTwoWebRoot.tsx
git commit -m "feat(browserbridge): WebView localhost callback interceptor + result page"
```

---

### Task 11: End-to-end verification (on-device)

**Files:** none (verification only).

- [ ] **Step 1** — Ship a build (version bump + CI tag per the release workflow) OR sideload a debug build.
- [ ] **Step 2** — On the phone: Settings → turn ON "Terminal-Browser aufs Handy leiten".
- [ ] **Step 3** — In a TMS terminal on the PC, run a login that uses a localhost callback (e.g. `vercel login` → choose the browser flow, or `npx --yes vercel@latest login`). Confirm: push appears / in-app browser opens the provider URL.
- [ ] **Step 4** — Complete the login in the in-app browser. Confirm: the WebView shows "Login abgeschlossen ✓" AND the CLI on the PC reports success (token stored).
- [ ] **Step 5** — Toggle OFF; run the same command; confirm the browser opens on the PC (fallback), not the phone.
- [ ] **Step 6** — Sanity: `open .` and `open some.pdf` in a terminal still open locally (URL-only guard).

---

## Self-Review

**Spec coverage:** Ziel/Ablauf → Tasks 1–5,7,9,10. Globaler Schalter → Task 8. Callback Weg A → Tasks 2 (relay),10 (intercept),7 (wire). Push + Auto-Öffnen → Task 9. Sicherheit (loopback+secret, relay-only-localhost) → Tasks 2,5. Fallback lokal öffnen → Task 3. Nicht-Ziele (kein Mirroring, kein Output-URL-Fang) → out of scope, no task. ✅ All covered.

**Placeholder scan:** No TBD/TODO; code shown for every implementation step; wiring steps give exact snippets/file anchors. Where a step references an existing pattern (autoApproveStore, cloud message 3-place sync), the pattern file is named. ✅

**Type consistency:** `decideOpen`/`relayCallback`/`setNotifier`/`isForwardableUrl`/`isLoopbackCallbackUrl`/`handleOpenUrl`/`materializeShimDir` names identical across producing/consuming tasks; message `type` strings identical between Task 6 and Tasks 7–10; `{url,host,sessionId}` open payload consistent (Task 2 notifier → Task 6 type → Task 9 handler). ✅

**Known plan-time nuance:** `TMS_SERVER_PORT` in Task 4 must use the real configured port from `index.ts` (not hardcoded 8767) — flagged in the step.
