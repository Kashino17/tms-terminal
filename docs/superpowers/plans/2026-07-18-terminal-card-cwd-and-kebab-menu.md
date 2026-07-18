# Terminal-Karte: Ordner-Zeile + Kebab-Menü — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Hinweis für dieses Projekt:** Der Nutzer will die Umsetzung **inline im Hauptkontext** (keine Subagents). Also: executing-plans, kein subagent-driven.

**Goal:** Unter dem Terminal-Titel eine kleine graue Zeile mit dem aktuellen Ordnernamen (live per `cd`), und den ⚡-Auto-Approve-Button durch ein ⋮-Kebab-Menü (Auto-Approve-Schalter + „Terminal schließen" mit Rückfrage) ersetzen.

**Architecture:** Der Server liest den echten cwd neu, sobald der PTY-Output nach einem Befehl zur Ruhe kommt (Debounce), und pusht `terminal:cwd` nur bei Änderung. RN-Host (`SeasonTwoWebRoot`) reicht das an die Seite weiter (`bridge.js` → `window.__tmsSetSessionCwd`), das Mockup patcht die graue `.card-cwd`-Zeile in-place. Das Kebab-Menü ist reine Mockup-UI, die die schon vorhandenen Wege `toggleCardAutoApprove`/`closeTerminal` (→ `autoapprove:set`/`terminal:close`) wiederverwendet.

**Tech Stack:** TypeScript (Node server, `node-pty`, `ws`), React Native (Expo, WebView-Host), Vanilla-JS/HTML/CSS-Mockup. Server-Tests: `node:test`. Mockup-Verifikation: Headless-Browser bei 412×915.

## Global Constraints

- **Zwei Worktrees / zwei Branches:**
  - **Mockup-Quelle** (Anzeige) = master-Worktree `/Users/ayysir/Desktop/TMS Terminal`, Branch `master`: `mockups/season2/liquid-deck/index.html`, `mockups/season2/shared/data.js`, sowie dieser Plan/Spec.
  - **App + Server** = feat-Worktree `/Users/ayysir/Desktop/tms-terminal`, Branch `feat/manager-chat-redesign`: `server/**`, `shared/protocol.ts`, `mobile/src/season2/**`.
- **`ws.handler.ts`-Zeilennummern gelten für den feat-Worktree** (master hat andere Nummern — nicht mischen).
- **Build-Kette:** `mobile/scripts/build-season2-html.js` liest das Mockup **fest** aus dem master-Worktree-Pfad und generiert `mobile/src/season2/web/liquidDeckHtml.ts` (nie von Hand editieren). Nach Mockup-Änderungen im feat-Worktree `npm run build:season2` laufen lassen.
- **Server-Neustart macht der NUTZER**, nicht der Assistent: die laufende Claude-Sitzung lebt IM TMS-Server-PTY — ein Neustart killt sie. Also Server-Code committen und den Nutzer neustarten lassen.
- **Git ist im iCloud-Desktop langsam:** Commits mit explizitem Pathspec (`git commit -- <pfade>`); wenn es hängt, Plumbing (`hash-object`/`read-tree`/`write-tree`/`commit-tree`/`update-ref` mit temporärem `GIT_INDEX_FILE`).
- **Sprache:** UI-Strings Deutsch, Code/Kommentare Englisch.
- **cwd-Normalisierung:** Der Server sendet Home als `~` (z.B. `~/Desktop/TMS Terminal`); das Mockup zeigt nur den letzten Ordnernamen.

---

### Task 1: Protocol-Message `terminal:cwd` + `normalizeCwd`-Helper (Server)

**Files:**
- Modify: `server/src/../../shared/protocol.ts` (feat-Worktree: `/Users/ayysir/Desktop/tms-terminal/shared/protocol.ts`)
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/terminal/cwd.utils.ts`
- Test: `/Users/ayysir/Desktop/tms-terminal/server/src/terminal/cwd.utils.test.ts` (neu)

**Interfaces:**
- Produces: `normalizeCwd(p: string, home?: string): string` — collapst Home zu `~`.
- Produces: Server-Message `{ type: 'terminal:cwd', sessionId: string, payload: { cwd: string } }`.

- [ ] **Step 1: Failing test schreiben**

Create `/Users/ayysir/Desktop/tms-terminal/server/src/terminal/cwd.utils.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCwd } from './cwd.utils';

const HOME = '/Users/ayysir';

test('normalizeCwd: home itself -> ~', () => {
  assert.equal(normalizeCwd('/Users/ayysir', HOME), '~');
  assert.equal(normalizeCwd('/Users/ayysir/', HOME), '~');
});

test('normalizeCwd: under home -> ~/rest', () => {
  assert.equal(normalizeCwd('/Users/ayysir/Desktop/TMS Terminal', HOME), '~/Desktop/TMS Terminal');
  assert.equal(normalizeCwd('/Users/ayysir/projects/api/', HOME), '~/projects/api');
});

test('normalizeCwd: outside home unchanged', () => {
  assert.equal(normalizeCwd('/etc/nginx', HOME), '/etc/nginx');
  assert.equal(normalizeCwd('/', HOME), '/');
});

test('normalizeCwd: home-prefixed but not a path boundary stays literal', () => {
  // "/Users/ayysir-backup" must NOT become "~-backup"
  assert.equal(normalizeCwd('/Users/ayysir-backup/x', HOME), '/Users/ayysir-backup/x');
});

test('normalizeCwd: empty stays empty', () => {
  assert.equal(normalizeCwd('', HOME), '');
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd /Users/ayysir/Desktop/tms-terminal/server && npm test`
Expected: FAIL — `normalizeCwd` ist kein Export von `./cwd.utils`.

- [ ] **Step 3: `normalizeCwd` implementieren**

In `/Users/ayysir/Desktop/tms-terminal/server/src/terminal/cwd.utils.ts` (`os` ist oben bereits importiert) direkt nach den Imports einfügen:

```ts
/** Collapse the user's home directory to `~` for compact display.
 *  `/Users/x` -> `~`, `/Users/x/proj` -> `~/proj`, other paths unchanged.
 *  Only collapses at a path boundary so `/Users/x-backup` is left intact. */
export function normalizeCwd(p: string, home: string = os.homedir()): string {
  if (!p) return p;
  const clean = p.length > 1 ? p.replace(/\/+$/, '') : p;
  if (clean === home) return '~';
  if (clean.startsWith(home + '/')) return '~' + clean.slice(home.length);
  return clean;
}
```

- [ ] **Step 4: Test laufen lassen — muss grün sein**

Run: `cd /Users/ayysir/Desktop/tms-terminal/server && npm test`
Expected: PASS (alle `normalizeCwd`-Tests grün; restliche Suite unverändert).

- [ ] **Step 5: Protocol-Message ergänzen**

In `/Users/ayysir/Desktop/tms-terminal/shared/protocol.ts` nach `TerminalReattachedMessage` (dem Interface, das mit `payload: { cols… processName?… }` endet) einfügen:

```ts
export interface TerminalCwdMessage {
  type: 'terminal:cwd';
  sessionId: string;
  /** Working directory, home-normalized to `~`. Pushed live when it changes. */
  payload: { cwd: string };
}
```

Und in der `export type ServerMessage =` Union `| TerminalCwdMessage` hinzufügen (z.B. direkt nach `| TerminalReattachedMessage`).

- [ ] **Step 6: Server-Build prüfen**

Run: `cd /Users/ayysir/Desktop/tms-terminal/server && npm run build`
Expected: PASS (tsc ohne Fehler; `TerminalCwdMessage` ist Teil von `ServerMessage`).

- [ ] **Step 7: Commit**

```bash
git -C /Users/ayysir/Desktop/tms-terminal add -- shared/protocol.ts server/src/terminal/cwd.utils.ts server/src/terminal/cwd.utils.test.ts
git -C /Users/ayysir/Desktop/tms-terminal commit -m "feat(server): terminal:cwd message + normalizeCwd helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: cwd live erkennen + pushen (Server, `ws.handler.ts`)

**Files:**
- Modify: `/Users/ayysir/Desktop/tms-terminal/server/src/websocket/ws.handler.ts`

**Interfaces:**
- Consumes: `normalizeCwd`, `readProcessCwd` (Task 1 / vorhandene `cwd.utils`), `globalManager.getSession(id): TerminalSession | undefined`, `send(ws, msg)`.
- Produces: `terminal:cwd`-Push an den Client bei Ordnerwechsel + einmal initial beim Attach.

- [ ] **Step 1: Import ergänzen**

In `ws.handler.ts` zu den bestehenden Imports (nahe Zeile 6–21) hinzufügen:

```ts
import { readProcessCwd, normalizeCwd } from '../terminal/cwd.utils';
```

- [ ] **Step 2: Debounce-State + Helper (Modul-Scope) einfügen**

Nach der `send(...)`-Funktion (nach Zeile 36) einfügen:

```ts
// ── Live working-directory tracking ──────────────────────────────────
// A cd/pushd changes the shell's cwd. Rather than parse the output text,
// we re-read the real cwd once the terminal output settles after a command,
// and push it only when it actually changed. Timers are unref'd; a timer
// that fires after the session is gone is a no-op (getSession returns
// undefined), so no explicit teardown is required for correctness.
const cwdCheckTimers = new Map<string, NodeJS.Timeout>();
const CWD_SETTLE_MS = 500;

/** Read the shell's real cwd and push it if it differs from the last known. */
async function refreshCwd(ws: WebSocket, sessionId: string): Promise<void> {
  const session = globalManager.getSession(sessionId);
  if (!session) return;
  const raw = await readProcessCwd(session.pty.pid);
  if (!raw || raw === session.cwd) return;
  session.cwd = raw; // store raw absolute path (consistent with factory/detach)
  send(ws, { type: 'terminal:cwd', sessionId, payload: { cwd: normalizeCwd(raw) } });
}

/** Debounced cwd re-read — called on every output chunk. */
function scheduleCwdCheck(ws: WebSocket, sessionId: string): void {
  const prev = cwdCheckTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    cwdCheckTimers.delete(sessionId);
    void refreshCwd(ws, sessionId);
  }, CWD_SETTLE_MS);
  t.unref();
  cwdCheckTimers.set(sessionId, t);
}

/** Cancel a pending cwd re-read (called from a session's exit callback). */
function clearCwdCheck(sessionId: string): void {
  const t = cwdCheckTimers.get(sessionId);
  if (t) { clearTimeout(t); cwdCheckTimers.delete(sessionId); }
}

/** Push the current best-known cwd immediately (on attach/create) so the
 *  folder label is correct right away; scheduleCwdCheck then keeps it live. */
function pushInitialCwd(ws: WebSocket, sessionId: string): void {
  const session = globalManager.getSession(sessionId);
  if (!session?.cwd) return;
  send(ws, { type: 'terminal:cwd', sessionId, payload: { cwd: normalizeCwd(session.cwd) } });
}
```

- [ ] **Step 3: `scheduleCwdCheck` in alle drei Output-Callbacks hängen**

Jeweils direkt nach `idleDetector.activity(...)`:

(a) `createTerminalForManager`-Output-Callback — nach Zeile 275 (`idleDetector.activity(sessionId);`):
```ts
          scheduleCwdCheck(ws, sessionId);
```

(b) `attachToThisClient`-Output-Callback — nach Zeile 377 (`idleDetector.activity(sid);`):
```ts
        scheduleCwdCheck(ws, sid);
```

(c) Client-`terminal:create`-Output-Callback — nach Zeile 889 (`idleDetector.activity(sessionId);`):
```ts
              scheduleCwdCheck(ws, sessionId);
```

- [ ] **Step 4: `clearCwdCheck` in alle drei Exit-Callbacks hängen**

Jeweils direkt nach `idleDetector.unwatch(...)`:

(a) nach Zeile 282 (`idleDetector.unwatch(sessionId);`): `clearCwdCheck(sessionId);`
(b) nach Zeile 384 (`idleDetector.unwatch(sid);`): `clearCwdCheck(sid);`
(c) nach Zeile 896 (`idleDetector.unwatch(sessionId);`): `clearCwdCheck(sessionId);`

- [ ] **Step 5: Initial-Push nach jedem Attach/Create**

(a) `createTerminalForManager` — nach `watchSessionIdle(session.id);` (Zeile 290):
```ts
      pushInitialCwd(ws, session.id);
```

(b) `attachToThisClient` — nach dem `send(ws, { type: 'terminal:reattached', … })`-Block (nach Zeile 404):
```ts
    pushInitialCwd(ws, session.id);
```

(c) Client-`terminal:create` — nach `watchSessionIdle(session.id);` (Zeile 907):
```ts
          pushInitialCwd(ws, session.id);
```

- [ ] **Step 6: Server-Build prüfen**

Run: `cd /Users/ayysir/Desktop/tms-terminal/server && npm run build`
Expected: PASS (tsc ohne Fehler).

- [ ] **Step 7: Manuelle Verifikation dokumentieren (kein Unit-Test — Timer/lsof/PTY)**

Nach Server-Neustart **durch den Nutzer** (siehe Global Constraints): in einem Terminal `cd` in einen anderen Ordner ausführen und im Server-Log prüfen, dass **genau ein** `terminal:cwd` mit dem neuen (normalisierten) Pfad rausgeht; ohne Verzeichniswechsel **kein** Push. (Der Nutzer sieht die Logs nicht selbst — beim Debuggen grepe ich `~/.tms-terminal/*.log` bzw. die Server-Konsole.)

- [ ] **Step 8: Commit**

```bash
git -C /Users/ayysir/Desktop/tms-terminal add -- server/src/websocket/ws.handler.ts
git -C /Users/ayysir/Desktop/tms-terminal commit -m "feat(server): live cwd detection on output-settle + terminal:cwd push

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `terminal:cwd` an die Seite weiterreichen (RN-Host + bridge.js)

**Files:**
- Modify: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/SeasonTwoWebRoot.tsx:326` (Message-Listener)
- Modify: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/web/bridge.js:1018` (Handler-Map, nach `setSessionStatus`)

**Interfaces:**
- Consumes: Server-Message `terminal:cwd` (Task 2); `call(fn, ...args)`; `cardOf(sessionId)` (bridge); `window.__tmsSetSessionCwd(cardId, cwd)` (Task 4).
- Produces: Aufruf `window.__tmsSetSessionCwd(cardId, cwd)` in der Seite.

- [ ] **Step 1: RN-Message-Case ergänzen**

In `SeasonTwoWebRoot.tsx`, im `wsService.addMessageListener`-Callback, direkt nach dem `terminal:output`-Block (nach Zeile 333) einfügen:

```tsx
      if (m?.type === 'terminal:cwd' && m.sessionId && typeof m.payload?.cwd === 'string') {
        call('setSessionCwd', m.sessionId, m.payload.cwd);
        return;
      }
```

- [ ] **Step 2: bridge.js-Handler ergänzen**

In `bridge.js`, in der Handler-Map direkt nach dem `setSessionStatus`-Eintrag (nach Zeile 1018) einfügen:

```js
    /** Server-reported working directory -> the mockup's folder subtitle. */
    setSessionCwd: function (sessionId, cwd) {
      var cardId = cardOf(sessionId);
      if (cardId && typeof window.__tmsSetSessionCwd === 'function') window.__tmsSetSessionCwd(cardId, cwd);
    },
```

- [ ] **Step 3: Mobile-Typecheck**

Run: `cd /Users/ayysir/Desktop/tms-terminal/mobile && npx tsc --noEmit`
Expected: PASS (keine neuen TS-Fehler; `m` ist bereits `any` im Listener).

- [ ] **Step 4: Commit**

```bash
git -C /Users/ayysir/Desktop/tms-terminal add -- mobile/src/season2/SeasonTwoWebRoot.tsx mobile/src/season2/web/bridge.js
git -C /Users/ayysir/Desktop/tms-terminal commit -m "feat(season2): forward terminal:cwd to the card folder subtitle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Hinweis: `bridge.js` wird zusätzlich beim `build:season2` (Task 6) in `liquidDeckHtml.ts` eingebettet — der Commit hier ist die Quelle.

---

### Task 4: Ordner-Zeile im Mockup (`index.html` + `data.js`)

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/shared/data.js:57-69` (Demo-cwds)
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (CSS, `folderLabel`, `cardHeaderHtml`, `__tmsSetSessionCwd`, cardState-Init)

**Interfaces:**
- Produces: `window.__tmsSetSessionCwd(cardId, cwd)` (von Task 3 konsumiert), `folderLabel(cwd): string`, CSS-Klasse `.card-cwd`.
- Consumes: bestehende Helfer `escapeHtml`, `cardState`, `TMS_DATA.sessions`.

- [ ] **Step 1: Demo-cwds in `data.js`**

In `mockups/season2/shared/data.js` je Session ein `cwd` ergänzen:

- Zeile 57 (`id: 't1'`): nach `live: true,` einfügen `cwd: '~/Kunden/pinterest-scraper',`
- Zeile 61 (`id: 't2'`): nach `live: false,` einfügen `cwd: '~/Desktop/TMS Terminal/server',`
- Zeile 65 (`id: 't3'`): nach `live: false,` einfügen `cwd: '~/Desktop/tms-landing',`
- Zeile 69 (`id: 't4'`): nach `live: false,` einfügen `cwd: '~',`

- [ ] **Step 2: `.card-cwd`-CSS**

In `index.html` direkt nach der `.card-desc[data-editing…]`-Regel (nach Zeile 733) einfügen:

```css
  /* Auto-info under the title: last folder of the working directory. Reuses the
     .card-desc look but is a non-editable <span>. Empty -> collapses (no gap). */
  .card-cwd { display: block; min-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); color: var(--text-dim); margin-top: 1px; line-height: 1.15; }
  .card-cwd:empty { display: none; }
```

- [ ] **Step 3: `folderLabel`-Helfer**

In `index.html` direkt vor `function cardHeaderHtml(` (vor Zeile 2965) einfügen:

```js
  // Last path component of a (home-normalized) cwd. '~' and '/' pass through,
  // empty -> '' so the .card-cwd line collapses.
  function folderLabel(cwd) {
    if (!cwd) return '';
    if (cwd === '~' || cwd === '/') return cwd;
    const parts = cwd.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || cwd;
  }
```

- [ ] **Step 4: `.card-cwd`-Span im Header rendern**

In `cardHeaderHtml` (Zeile 2970–2972) den `.card-name-wrap`-Block ersetzen:

Von:
```js
          <div class="card-name-wrap">
            <input class="card-name" value="${escapeHtml(session.name)}" readonly aria-label="Terminal-Name">
          </div>
```
Zu:
```js
          <div class="card-name-wrap">
            <input class="card-name" value="${escapeHtml(session.name)}" readonly aria-label="Terminal-Name">
            <span class="card-cwd" data-card-cwd>${escapeHtml(folderLabel(cs.cwd || ''))}</span>
          </div>
```

- [ ] **Step 5: `cwd` in cardState-Init + neue Sessions**

- Zeile 2120 (`cardState[s.id] = { … showReplay: false };`): vor `showReplay: false` ein `cwd: s.cwd || '',` ergänzen.
- Zeile 2149 (`cardState[id] = { … showReplay: false };`): vor `showReplay: false` ein `cwd: session.cwd || '',` ergänzen.
- Zeile 2145 (im `createTerminalSession`-Session-Objekt, nach `notes: [], todos: [],`): `cwd: '~',` ergänzen.

- [ ] **Step 6: `window.__tmsSetSessionCwd`-Hook**

In `index.html` direkt nach `folderLabel` (aus Step 3) einfügen:

```js
  // Bridge hook: server-reported working directory -> in-place patch of the
  // grey .card-cwd line (Stack + Liste), no full re-render.
  window.__tmsSetSessionCwd = function (cardId, cwd) {
    const cs = cardState[cardId];
    if (cs) cs.cwd = cwd;
    const session = TMS_DATA.sessions.find(s => s.id === cardId);
    if (session) session.cwd = cwd;
    const label = folderLabel(cwd);
    document.querySelectorAll(`.term-card[data-id="${cardId}"] .card-cwd`).forEach(el => { el.textContent = label; });
  };
```

- [ ] **Step 7: Headless-Verifikation (412×915)**

Mockup `mockups/season2/liquid-deck/index.html` im Headless-Browser bei 412×915 laden (Chrome-DevTools-/Playwright-MCP). Prüfen:
- Unter jedem Titel eine graue, kleine Zeile: t1 „pinterest-scraper", t2 „server", t3 „tms-landing", t4 „~".
- Der Header ist **nicht** höher als vorher (Screenshot mit vorherigem Stand vergleichen).
- In der DevTools-Konsole `window.__tmsSetSessionCwd('t1','~/Desktop/TMS Terminal')` → t1-Zeile wird live zu „TMS Terminal".
- `window.__tmsSetSessionCwd('t4','')` → t4-Zeile verschwindet (kein Leerraum).
- Beide Ansichten (Stack + Liste) zeigen die Zeile.

- [ ] **Step 8: Commit (master-Worktree, Plumbing bei iCloud-Hänger)**

```bash
git -C "/Users/ayysir/Desktop/TMS Terminal" commit -- mockups/season2/liquid-deck/index.html mockups/season2/shared/data.js -m "feat(season2): grey folder subtitle under the terminal title

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Falls Git hängt: Plumbing-Variante (siehe Global Constraints).

---

### Task 5: Kebab-Menü ersetzt den ⚡-Button (`index.html`)

**Files:**
- Modify: `/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (Icon, CSS, `cardHeaderHtml`, `wireCardHeader`, `updateAutoToggleUI`, neue Menü-Funktionen, `removeTerminalCard`, zwei Ignore-Listen)

**Interfaces:**
- Consumes: `toggleCardAutoApprove(id)`, `closeTerminal(id)`, `cardState`, `icon()`.
- Produces: `openCardMenu(id, btn)`, `closeCardMenu()` (body-appended Popover).

- [ ] **Step 1: Vertikales Punkte-Icon**

In `ICON_PATHS` nach `dots:` (Zeile 2210) einfügen:

```js
    dotsV: '<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>',
```

- [ ] **Step 2: CSS — Button ⋮ + Popover + Schalter + Confirm**

Den `.auto-toggle`-Block (Zeilen 736–740) **ersetzen** durch:

```css
  /* Per-terminal ⋮ menu button (replaces the old ⚡ auto-toggle). */
  .card-menu-btn { flex: none; display: flex; align-items: center; justify-content: center; height: 30px; width: 30px; padding: 0; border-radius: var(--radius-pill); color: var(--text-dim); background: rgba(var(--overlay-rgb),.06); border: 1px solid var(--glass-border); transition: color 160ms var(--spring), background 160ms var(--spring); }
  .card-menu-btn .ic { width: var(--icon-sm); height: var(--icon-sm); flex: none; }
  .card-menu-btn:active { transform: scale(.94); }
  .card-menu-btn[aria-expanded="true"] { color: var(--text); background: rgba(var(--overlay-rgb),.12); }

  /* Body-appended dropdown so it never clips inside a card (Stack + Liste). */
  .card-menu { position: fixed; z-index: 200; min-width: 200px; padding: 5px; border-radius: 14px; display: flex; flex-direction: column; gap: 2px; box-shadow: 0 14px 44px rgba(0,0,0,.45); }
  .card-menu__row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 11px; border: none; background: none; color: var(--text); font-size: var(--fs-body); border-radius: 10px; cursor: pointer; text-align: left; }
  .card-menu__row:active { background: rgba(var(--overlay-rgb),.10); }
  .card-menu__row .ic { flex: none; color: var(--text-dim); }
  .card-menu__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-menu__row--danger, .card-menu__row--danger .ic { color: var(--err); }
  .card-menu__switch { flex: none; width: 34px; height: 20px; border-radius: 999px; background: rgba(var(--overlay-rgb),.25); position: relative; transition: background 160ms var(--spring); }
  .card-menu__switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 160ms var(--spring); }
  .card-menu__switch[data-on="true"] { background: var(--ok); }
  .card-menu__switch[data-on="true"]::after { transform: translateX(14px); }
  .card-menu__confirm { display: flex; align-items: center; gap: 8px; padding: 10px 11px; }
  .card-menu__confirm .card-menu__label { color: var(--err); }
  .card-menu__confirm button { flex: none; padding: 5px 12px; border-radius: 8px; font-size: var(--fs-label); border: 1px solid var(--glass-border); background: rgba(var(--overlay-rgb),.08); color: var(--text); cursor: pointer; }
  .card-menu__confirm .card-menu__confirm-yes { color: var(--err); border-color: rgba(var(--err-rgb),.4); background: rgba(var(--err-rgb),.12); }
```

- [ ] **Step 3: Header-Button austauschen**

In `cardHeaderHtml` die `.auto-toggle`-Zeile (Zeile 2974) ersetzen:

Von:
```js
          <button class="auto-toggle${cs.autoApprove ? ' is-on' : ''}" data-act="auto" aria-pressed="${cs.autoApprove}" aria-label="Auto-Approve umschalten" title="Auto-Approve">${icon('bolt', 15)}</button>
```
Zu:
```js
          <button class="card-menu-btn" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-label="Terminal-Menü" title="Menü">${icon('dotsV', 18)}</button>
```

- [ ] **Step 4: `wireCardHeader` umhängen**

In `wireCardHeader` (Zeilen 3400–3401) ersetzen:

Von:
```js
    const auto = card.querySelector('.auto-toggle');
    if (auto) auto.addEventListener('click', e => { e.stopPropagation(); toggleCardAutoApprove(id); });
```
Zu:
```js
    const menuBtn = card.querySelector('.card-menu-btn');
    if (menuBtn) menuBtn.addEventListener('click', e => { e.stopPropagation(); openCardMenu(id, menuBtn); });
```

- [ ] **Step 5: `updateAutoToggleUI` auf den Menü-Schalter umstellen**

Die Funktion `updateAutoToggleUI` (Zeilen 4286–4294) ersetzen durch:

```js
  // Reflect the per-terminal Auto-Approve flag on the open ⋮ menu switch
  // (if any) and the permission sheet's Auto button.
  function updateAutoToggleUI(id) {
    const on = cardState[id] ? cardState[id].autoApprove : false;
    if (openMenuEl && openMenuEl.dataset.id === id) {
      const sw = openMenuEl.querySelector('.card-menu__switch');
      if (sw) sw.setAttribute('data-on', String(on));
      const row = openMenuEl.querySelector('[data-menu="auto"]');
      if (row) row.setAttribute('aria-checked', String(on));
    }
    const permBtn = document.getElementById('permAutoBtn');
    if (permBtn && state.pendingPromptId === id) permBtn.setAttribute('aria-pressed', String(on));
  }
```

- [ ] **Step 6: Menü-Funktionen einfügen**

Direkt vor `updateAutoToggleUI` (vor Zeile 4285/„Per-terminal Auto-Approve toggle"-Kommentar) einfügen:

```js
  // ── Per-card ⋮ menu: Auto-Approve switch + „Terminal schließen" (confirm) ──
  // Body-appended popover so it never clips inside a card. Only one open.
  let openMenuEl = null;
  function onMenuOutside(e) {
    if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.card-menu-btn')) closeCardMenu();
  }
  function onMenuKey(e) { if (e.key === 'Escape') closeCardMenu(); }
  function closeCardMenu() {
    if (!openMenuEl) return;
    const btn = document.querySelector(`.term-card[data-id="${openMenuEl.dataset.id}"] .card-menu-btn`);
    if (btn) btn.setAttribute('aria-expanded', 'false');
    openMenuEl.remove();
    openMenuEl = null;
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function openCardMenu(id, btn) {
    if (openMenuEl && openMenuEl.dataset.id === id) { closeCardMenu(); return; }
    closeCardMenu();
    const on = cardState[id] ? cardState[id].autoApprove : true;
    const menu = document.createElement('div');
    menu.className = 'card-menu glass glass--dark';
    menu.dataset.id = id;
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button class="card-menu__row" data-menu="auto" role="menuitemcheckbox" aria-checked="${on}">
        <span class="card-menu__label">Auto-Approve</span>
        <span class="card-menu__switch" data-on="${on}"></span>
      </button>
      <button class="card-menu__row card-menu__row--danger" data-menu="close" role="menuitem">
        <span class="card-menu__label">Terminal schließen</span>
        ${icon('trash', 16)}
      </button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    left = Math.max(8, left);
    menu.style.left = left + 'px';
    menu.style.top = (r.bottom + 6) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    openMenuEl = menu;
    menu.querySelector('[data-menu="auto"]').addEventListener('click', e => {
      e.stopPropagation();
      toggleCardAutoApprove(id); // updates the switch via updateAutoToggleUI
    });
    menu.querySelector('[data-menu="close"]').addEventListener('click', e => {
      e.stopPropagation();
      armCloseConfirm(menu, id);
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', onMenuOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
  }
  function armCloseConfirm(menu, id) {
    const row = menu.querySelector('[data-menu="close"]');
    const confirm = document.createElement('div');
    confirm.className = 'card-menu__confirm';
    confirm.innerHTML = `
      <span class="card-menu__label">Wirklich schließen?</span>
      <button class="card-menu__confirm-yes" data-menu="close-yes">Ja</button>
      <button class="card-menu__confirm-no" data-menu="close-no">Abbrechen</button>`;
    row.replaceWith(confirm);
    confirm.querySelector('[data-menu="close-yes"]').addEventListener('click', e => {
      e.stopPropagation(); closeCardMenu(); closeTerminal(id);
    });
    confirm.querySelector('[data-menu="close-no"]').addEventListener('click', e => {
      e.stopPropagation(); closeCardMenu();
    });
  }
```

- [ ] **Step 7: Menü bei Kartenabbau schließen**

In `removeTerminalCard` (Zeile 3281) als erste Zeile im Funktionskörper einfügen:

```js
    if (typeof closeCardMenu === 'function') closeCardMenu();
```

- [ ] **Step 8: Zwei Ignore-Listen aktualisieren (`.auto-toggle` → `.card-menu-btn`)**

- Zeile 3823: im `closest('.card-body-shell, .card-name, .card-desc, .status-chip, .auto-toggle, .replay-pill, .keys-panel, .term-input-row')` das `.auto-toggle` durch `.card-menu-btn` ersetzen.
- Zeile 4686: im `closest('.term-input-row, .card-name, .card-desc, .auto-toggle, .status-chip, .chevron-btn, .replay-pill, .jump-bottom-orb, .keys-panel')` das `.auto-toggle` durch `.card-menu-btn` ersetzen.

- [ ] **Step 9: Sanity-Grep — keine `.auto-toggle`-Reste**

Run: `grep -n "auto-toggle\|'bolt'" "/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html"`
Expected: nur noch die Perm-Sheet-Regel `.perm-actions button[data-act="auto"]` (Zeile ~640) — **keine** `.auto-toggle`-Klasse und **kein** `icon('bolt', 15)` im Karten-Header mehr.

- [ ] **Step 10: Headless-Verifikation (412×915)**

Mockup laden. Prüfen:
- Statt ⚡ nun ⋮ (drei vertikale Punkte) rechts im Header.
- Tap auf ⋮ → Popover mit „Auto-Approve" (Schalter spiegelt Zustand) + rotem „Terminal schließen".
- Schalter tippen → Zustand kippt sichtbar (grün/aus) und `cardState[id].autoApprove` folgt.
- „Terminal schließen" tippen → Zeile wird zu „Wirklich schließen? · Ja / Abbrechen"; „Abbrechen" schließt Menü, „Ja" entfernt die Karte.
- Außen-Tap und `Esc` schließen das Menü; nie zwei Menüs gleichzeitig.
- Funktioniert in Stack **und** Liste.

- [ ] **Step 11: Commit (master-Worktree)**

```bash
git -C "/Users/ayysir/Desktop/TMS Terminal" commit -- mockups/season2/liquid-deck/index.html -m "feat(season2): kebab menu (auto-approve switch + close-with-confirm) replaces ⚡

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Build + Integrations-Verifikation

**Files:**
- Generated: `/Users/ayysir/Desktop/tms-terminal/mobile/src/season2/web/liquidDeckHtml.ts` (via Build)

- [ ] **Step 1: Mockup in die App bauen**

Run: `cd /Users/ayysir/Desktop/tms-terminal/mobile && npm run build:season2`
Expected: `liquidDeckHtml.ts` neu generiert (liest Mockup aus dem master-Worktree, bettet `bridge.js` ein).

- [ ] **Step 2: Typechecks**

Run: `cd /Users/ayysir/Desktop/tms-terminal/server && npm run build && npm test`
Run: `cd /Users/ayysir/Desktop/tms-terminal/mobile && npx tsc --noEmit`
Expected: beide PASS.

- [ ] **Step 3: Commit der generierten Datei**

```bash
git -C /Users/ayysir/Desktop/tms-terminal add -- mobile/src/season2/web/liquidDeckHtml.ts
git -C /Users/ayysir/Desktop/tms-terminal commit -m "build(season2): regenerate liquidDeckHtml (folder subtitle + kebab menu)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Server-Neustart durch den Nutzer anstoßen**

Den Nutzer bitten, den `tms-terminal`-Server neu zu starten (ich darf das nicht selbst — meine Sitzung läuft im Server-PTY und würde sterben).

- [ ] **Step 5: End-to-End in der App**

- Terminal öffnen, `cd` in einen anderen Ordner → die graue Zeile unter dem Titel wechselt **live** zum neuen letzten Ordnernamen, ohne App-Neustart.
- ⋮ öffnen → Auto-Approve umschalten (Server-Log zeigt `client:set_auto_approve`), „Terminal schließen" → Rückfrage → „Ja" beendet die echte PTY-Session.

---

## Self-Review

**1. Spec-Coverage:**
- Spec §1 Ordner-Zeile (Anzeige/folderLabel/leer-bei-unbekannt/beide Ansichten) → Task 4. ✅
- Spec §2 Server event-getrieben (Output-Settle, Push nur bei Änderung, Initial-Push) → Task 2 (+ `normalizeCwd`/Message Task 1). ✅
- Spec §3 Kebab (⋮ statt ⚡, Auto-Approve-Schalter, Close mit Rückfrage, ein Popover, Esc/Außen-Tap) → Task 5. ✅
- Spec §4 Datenfluss (SeasonTwoWebRoot `terminal:cwd` → `call('setSessionCwd')` → bridge `__tmsSetSessionCwd`) → Task 3 (+ Hook in Task 4). ✅
- Spec §5 Dateiliste inkl. generierte `liquidDeckHtml.ts` → Task 6. ✅
- Spec §6 Edge Cases (leer, Schalter, Home→`~`, Header-Höhe, beide Ansichten) → Tasks 4/5 Verifikationsschritte. ✅
- Spec §7 Verifikation (headless + Server-Log + E2E) → Tasks 2/4/5/6. ✅

**2. Placeholder-Scan:** keine TBD/TODO; jeder Code-Schritt zeigt vollständigen Code oder exakte Ersetzung. Bewusste Nicht-Tests (Timer/lsof/PTY in Task 2, HTML-UI in Task 4/5) sind durch dokumentierte Headless-/E2E-Verifikation abgedeckt — kein blindes „Tests hinzufügen".

**3. Typ-Konsistenz:** `normalizeCwd`/`readProcessCwd` (Task 1) ↔ Verwendung in Task 2; Message `terminal:cwd`/`payload.cwd` identisch in Task 1 (Definition), Task 2 (Send), Task 3 (Empfang). Bridge-Kette `call('setSessionCwd', sessionId, cwd)` → `setSessionCwd(sessionId, cwd)` → `window.__tmsSetSessionCwd(cardId, cwd)` durchgängig gleich benannt. `openCardMenu/closeCardMenu/armCloseConfirm/openMenuEl/updateAutoToggleUI` konsistent zwischen Task 5 Steps.
