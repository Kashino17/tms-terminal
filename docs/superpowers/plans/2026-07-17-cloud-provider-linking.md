# Cloud-Seite: Render & Vercel verknüpfen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (User-Vorgabe: Implementierung im Hauptkontext, KEINE Subagents.)

**Goal:** Die Season-2-Cloud-Seite kann Render- und Vercel-Konten per API-Key verbinden; Keys liegen im Android Keystore, sind im Konten-Sheet einsehbar/kopierbar und überleben App-Updates.

**Architecture:** Mockup (`mockups/season2/liquid-deck/index.html`) bekommt Empty-State-Verbinden-Karten + Konten-Sheet mit Demo-Stubs; `bridge.js` überschreibt die Stubs mit `post()`-Nachrichten; `useCloudBridge` wird zweigleisig (Vercel + Render, Provider-Präfix in Projekt-IDs); `cloudAuthStore` wandert von AsyncStorage-Klartext auf `expo-secure-store` mit Einmal-Migration.

**Tech Stack:** Vanilla JS (Mockup), React Native + Expo (`expo-secure-store` ~12.8.1, `expo-clipboard` ~5.0.1 — beide bereits installiert), Zustand persist, node:test für Mockup-Daten.

## Global Constraints

- **Zwei Worktrees:** Mockup/Daten in `/Users/ayysir/Desktop/TMS Terminal` (master); RN/Bridge/Store in `/Users/ayysir/Desktop/tms-terminal` (Branch `feat/manager-chat-redesign` — vor dem Push Remote prüfen, parallele Jobs pushen dorthin).
- **Git im `TMS Terminal`-Worktree nur per Plumbing** (hash-object/update-index/write-tree/commit-tree/update-ref) — normale tree-scannende Git-Befehle hängen (iCloud). Im `tms-terminal`-Worktree erst normal versuchen (timeout 60s), sonst ebenfalls Plumbing.
- **UI-Strings Deutsch, Code-Kommentare Englisch.**
- **Build-Script-Patches:** `mobile/scripts/build-season2-html.js` patcht per exaktem String-Match und wirft bei Nichttreffer. Mockup-Änderungen dürfen die gepatchten Strings nicht verändern (relevant: `const deploys = [` in `renderCloudDetail`, der `<script src="../shared/data.js">`-Tag, `initLiveSession();`-Block). Nach jeder Mockup-Änderung `npm run build:season2` laufen lassen.
- **Kein Test-Runner in `mobile/`** — RN-Seite wird per `npx tsc --noEmit` + manuell verifiziert; Mockup-Daten per `node --test`.
- **Ich laufe selbst im TMS-Server-PTY:** keine Server-Neustarts nötig (nur App-seitige Änderungen); Ja/Nein-Promptmuster nie ausschreiben.

---

### Task 1: Seed-Daten + Tests für Cloud-Konten (Mockup-Worktree)

**Files:**
- Modify: `mockups/season2/shared/data.js` (nach `cloudProjects`-Array, ca. Zeile 92)
- Test: `mockups/season2/shared/data.test.cjs`

**Interfaces:**
- Produces: `TMS_DATA.cloudAccounts: { vercel: { connected: boolean, maskedKey: string|null }, render: { … } }` — Task 2 (Mockup-UI) und Task 4 (Bridge `setCloudAccounts`) lesen exakt diese Form.

- [ ] **Step 1: Failing Test schreiben** — in `data.test.cjs` ergänzen:

```js
test('cloud accounts: both providers seeded as connected with masked keys', () => {
  const acc = DATA.cloudAccounts;
  assert.ok(acc && acc.vercel && acc.render);
  assert.equal(acc.vercel.connected, true);
  assert.equal(acc.render.connected, true);
  // Masked keys must never contain a full secret — middle is elided.
  assert.match(acc.vercel.maskedKey, /••••…/);
  assert.match(acc.render.maskedKey, /^rnd_/);
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `node --test mockups/season2/shared/data.test.cjs`
Expected: FAIL (`cloudAccounts` undefined)

- [ ] **Step 3: Seed ergänzen** — in `data.js` direkt nach dem `cloudProjects`-Array:

```js
    // Cloud provider accounts: demo shows both linked so the project list has
    // content; the real app overwrites this via TMSBridge.setCloudAccounts.
    cloudAccounts: {
      vercel: { connected: true, maskedKey: 'vc_a1••••…9zQ' },
      render: { connected: true, maskedKey: 'rnd_BH••••…sp4' },
    },
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `node --test mockups/season2/shared/data.test.cjs`
Expected: alle Tests PASS

- [ ] **Step 5: Commit (Plumbing)**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal"
for f in mockups/season2/shared/data.js mockups/season2/shared/data.test.cjs; do
  B=$(git hash-object -w "$f"); git update-index --add --cacheinfo 100644 "$B" "$f"; done
T=$(git write-tree); C=$(git commit-tree "$T" -p HEAD -m "feat(season2): Cloud-Konten-Seed (Vercel/Render) + Tests")
git update-ref HEAD "$C"
```

---

### Task 2: Mockup-UI — Verbinden-Karten, Zahnrad, Konten-Sheet (Mockup-Worktree)

**Files:**
- Modify: `mockups/season2/liquid-deck/index.html`
  - Sheet-Markup bei den anderen Sheets (nach `#browserPasswordsSheetWrap`, ca. Zeile 1798)
  - CSS im Cloud-Block (ca. Zeile 1117 ff.)
  - JS im Cloud-Abschnitt (`renderCloudShell`/`renderCloudGroups`, ca. Zeile 5644 ff.)

**Interfaces:**
- Consumes: `TMS_DATA.cloudAccounts` (Task 1), vorhandene Helfer `openSheet(wrapEl)`, `closeSheet(wrapEl)`, `escapeHtml`, `toast`, `renderCloudGroups`.
- Produces (globale, von der Bridge überschreibbare Stubs — Task 3 ersetzt sie):
  - `window.requestCloudConnect(provider, token)`
  - `window.requestCloudDisconnect(provider)`
  - `window.requestCloudRevealKey(provider)`
  - `window.requestCloudCopyKey(provider)`
  - Callbacks, die die Bridge aufruft: `window.cloudKeyRevealed(provider, key)`, `window.renderCloudAccountsSheet()` (beide global exportieren).
  - WICHTIG: Funktionsdeklarationen liegen im Top-Level-Script und sind damit automatisch `window.*` — dem bestehenden Muster folgen (vgl. `renderCloudGroups`).

- [ ] **Step 1: Sheet-Markup einfügen** (nach dem `browserPasswordsSheetWrap`-Block):

```html
<div class="sheet-wrap" id="cloudAccountsSheetWrap" hidden>
  <div class="sheet-backdrop" data-close-cloudaccounts></div>
  <div class="sheet-panel glass glass--strong">
    <div class="sheet-grabber"></div>
    <div class="sheet-head-row">
      <div class="sheet-title">Cloud-Konten</div>
      <button class="sheet-close-btn" id="cloudAccountsSheetClose">Schließen</button>
    </div>
    <div class="sheet-scroll-body" id="cloudAccountsSheetBody"></div>
  </div>
</div>
```

- [ ] **Step 2: CSS ergänzen** (im Cloud-CSS-Block):

```css
  /* ---------- Cloud account linking ---------- */
  .cloud-connect-card { padding: 18px 16px; margin-bottom: 12px; }
  .cloud-connect-card h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font: 700 15px var(--font-ui); }
  .cloud-connect-card p { margin: 0 0 12px; font: 12.5px var(--font-ui); color: var(--text-dim); }
  .cloud-connect-row { display: flex; gap: 8px; }
  .cloud-connect-row input { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(var(--overlay-rgb),.14); background: rgba(var(--overlay-rgb),.05); color: inherit; font: 13px var(--font-mono); }
  .cloud-account-row { padding: 14px 4px; border-top: 1px solid rgba(var(--overlay-rgb),.08); }
  .cloud-account-row:first-child { border-top: none; }
  .cloud-account-row__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .cloud-account-row__name { flex: 1; font: 700 14px var(--font-ui); }
  .cloud-account-key { display: flex; align-items: center; gap: 8px; }
  .cloud-account-key code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px var(--font-mono); color: var(--text-dim); }
  .cloud-key-invalid { color: #e03131; font: 12px var(--font-ui); margin-top: 6px; }
```

- [ ] **Step 3: Zahnrad-Button in die Toolbar** — in `renderCloudShell()` nach dem `cloudViewToggle`-`</div>`:

```html
            <button class="btn-chip" id="cloudAccountsBtn" type="button">Konten</button>
```

und im JS des Cloud-Abschnitts (bei den anderen Toolbar-Listenern):

```js
    document.getElementById('cloudAccountsBtn').addEventListener('click', () => {
      renderCloudAccountsSheet();
      openSheet(document.getElementById('cloudAccountsSheetWrap'));
    });
```

Sheet-Schließer einmalig beim Boot (bei den anderen Sheet-Verdrahtungen, ca. Zeile 2490):

```js
  const cloudAccountsWrap = document.getElementById('cloudAccountsSheetWrap');
  document.getElementById('cloudAccountsSheetClose').addEventListener('click', () => closeSheet(cloudAccountsWrap));
  cloudAccountsWrap.querySelector('[data-close-cloudaccounts]').addEventListener('click', () => closeSheet(cloudAccountsWrap));
```

- [ ] **Step 4: Empty-State + Verbinden-Logik** — im Cloud-Abschnitt (vor `renderCloudGroups`):

```js
  const CLOUD_PROVIDER_LABEL = { vercel: 'Vercel', render: 'Render' };
  const CLOUD_KEY_HINT = {
    vercel: 'vercel.com → Account Settings → Tokens',
    render: 'dashboard.render.com → Account Settings → API Keys',
  };

  function cloudConnectedProviders() {
    const acc = TMS_DATA.cloudAccounts || {};
    return ['vercel', 'render'].filter(p => acc[p] && acc[p].connected);
  }

  function cloudConnectCardHtml(provider) {
    return `
      <div class="cloud-connect-card glass" data-connect-card="${provider}">
        <h3><span class="provider-glyph">${CLOUD_GLYPH[provider]}</span>${CLOUD_PROVIDER_LABEL[provider]} verbinden</h3>
        <p>API-Key erstellen unter: ${escapeHtml(CLOUD_KEY_HINT[provider])}</p>
        <div class="cloud-connect-row">
          <input type="password" placeholder="API-Key" data-connect-input="${provider}" autocomplete="off">
          <button class="btn-chip is-on" data-connect-btn="${provider}" type="button">Verbinden</button>
        </div>
      </div>`;
  }

  function bindCloudConnectCards(host) {
    host.querySelectorAll('[data-connect-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const provider = btn.dataset.connectBtn;
        const input = host.querySelector(`[data-connect-input="${provider}"]`);
        const token = (input.value || '').trim();
        if (!token) { toast('Bitte API-Key eingeben'); return; }
        window.requestCloudConnect(provider, token);
      });
    });
  }
```

`renderCloudGroups()` am Anfang erweitern (VOR dem bestehenden `const list = …`):

```js
    const connected = cloudConnectedProviders();
    if (connected.length === 0) {
      host.innerHTML = cloudConnectCardHtml('vercel') + cloudConnectCardHtml('render');
      bindCloudConnectCards(host);
      return;
    }
```

und am Ende von `renderCloudGroups()` (nach dem bestehenden `host.innerHTML = …` beider Zweige — dafür die beiden `return`/Ende-Stellen um einen gemeinsamen Abschluss ergänzen):

```js
    const missing = ['vercel', 'render'].filter(p => !connected.includes(p));
    if (missing.length === 1) {
      host.insertAdjacentHTML('beforeend', cloudConnectCardHtml(missing[0]));
      bindCloudConnectCards(host);
    }
```

(Der `state.cloudProviderFilter`-Filter oben in `cloudFilteredProjects()` bleibt unverändert.)

- [ ] **Step 5: Konten-Sheet-Renderer + Demo-Stubs** (ebenfalls Cloud-Abschnitt):

```js
  let cloudRevealed = {}; // provider -> plaintext key while eye is open

  function renderCloudAccountsSheet() {
    const body = document.getElementById('cloudAccountsSheetBody');
    if (!body) return;
    const acc = TMS_DATA.cloudAccounts || {};
    body.innerHTML = ['vercel', 'render'].map(p => {
      const a = acc[p] || { connected: false };
      if (!a.connected) {
        return `<div class="cloud-account-row">
          <div class="cloud-account-row__head"><span class="provider-glyph">${CLOUD_GLYPH[p]}</span>
            <span class="cloud-account-row__name">${CLOUD_PROVIDER_LABEL[p]}</span>
            <span class="status-chip" data-status="inactive"><span class="dot"></span><span class="status-chip__label">nicht verbunden</span></span></div>
          <div class="cloud-connect-row">
            <input type="password" placeholder="API-Key" data-connect-input="${p}" autocomplete="off">
            <button class="btn-chip is-on" data-connect-btn="${p}" type="button">Verbinden</button>
          </div></div>`;
      }
      const key = cloudRevealed[p] || a.maskedKey || '••••';
      return `<div class="cloud-account-row">
        <div class="cloud-account-row__head"><span class="provider-glyph">${CLOUD_GLYPH[p]}</span>
          <span class="cloud-account-row__name">${CLOUD_PROVIDER_LABEL[p]}</span>
          <span class="status-chip" data-status="${a.invalid ? 'error' : 'ready'}"><span class="dot"></span><span class="status-chip__label">${a.invalid ? 'Key ungültig' : 'verbunden'}</span></span></div>
        <div class="cloud-account-key">
          <code>${escapeHtml(key)}</code>
          <button class="btn-chip" data-reveal="${p}" type="button">${cloudRevealed[p] ? 'Verbergen' : 'Anzeigen'}</button>
          <button class="btn-chip" data-copy="${p}" type="button">Kopieren</button>
          <button class="btn-chip" data-disconnect="${p}" type="button">Trennen</button>
        </div>
        ${a.invalid ? '<div class="cloud-key-invalid">Key ungültig — bitte neu eingeben (erst trennen).</div>' : ''}
      </div>`;
    }).join('');

    bindCloudConnectCards(body);
    body.querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () => {
      const p = b.dataset.reveal;
      if (cloudRevealed[p]) { delete cloudRevealed[p]; renderCloudAccountsSheet(); }
      else window.requestCloudRevealKey(p);
    }));
    body.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => window.requestCloudCopyKey(b.dataset.copy)));
    body.querySelectorAll('[data-disconnect]').forEach(b => b.addEventListener('click', () => {
      delete cloudRevealed[b.dataset.disconnect];
      window.requestCloudDisconnect(b.dataset.disconnect);
    }));
  }
  window.renderCloudAccountsSheet = renderCloudAccountsSheet;

  /** Bridge answer to requestCloudRevealKey — shows the plaintext key. */
  window.cloudKeyRevealed = function (provider, key) {
    if (!key) return;
    cloudRevealed[provider] = key;
    renderCloudAccountsSheet();
  };

  // ── Demo stubs — bridge.js overrides all four with post() calls. ──
  const CLOUD_DEMO_KEYS = { vercel: 'vc_a1b2c3d4e5f6g7h8i9zQ', render: 'rnd_BHdemoDEMOdemoDsp4' };
  function maskCloudKey(k) { return k.length <= 8 ? '••••' : k.slice(0, 4) + '••••…' + k.slice(-3); }
  window.requestCloudConnect = function (provider, token) {
    TMS_DATA.cloudAccounts[provider] = { connected: true, maskedKey: maskCloudKey(token) };
    CLOUD_DEMO_KEYS[provider] = token;
    toast(CLOUD_PROVIDER_LABEL[provider] + ' verbunden (Demo)');
    renderCloudGroups(); renderCloudAccountsSheet();
  };
  window.requestCloudDisconnect = function (provider) {
    TMS_DATA.cloudAccounts[provider] = { connected: false, maskedKey: null };
    toast(CLOUD_PROVIDER_LABEL[provider] + ' getrennt (Demo)');
    renderCloudGroups(); renderCloudAccountsSheet();
  };
  window.requestCloudRevealKey = function (provider) { window.cloudKeyRevealed(provider, CLOUD_DEMO_KEYS[provider]); };
  window.requestCloudCopyKey = function (provider) { toast('Kopiert (Demo)'); };
```

- [ ] **Step 6: Standalone-Mockup im Headless-Browser prüfen**

Mockup als `file://…/mockups/season2/liquid-deck/index.html` öffnen (Playwright-Plugin, headless), zur Cloud-Seite navigieren und Screenshots machen:
1. Normalzustand (beide verbunden, Projekte sichtbar, „Konten"-Chip in der Toolbar).
2. Konten-Sheet offen: maskierte Keys, Anzeigen deckt auf, Verbergen maskiert wieder.
3. In der Console `TMS_DATA.cloudAccounts.vercel.connected = false; TMS_DATA.cloudAccounts.render.connected = false; renderCloudGroups();` → beide Verbinden-Karten.
4. Demo-Key in eine Karte eingeben → „verbunden (Demo)"-Toast, Projekte erscheinen.

Expected: keine Console-Errors, Layout konsistent mit dem Rest der Seite (380 dp).

- [ ] **Step 7: Gegen die Build-Patches prüfen**

Run: `cd ~/Desktop/tms-terminal/mobile && npm run build:season2`
Expected: läuft ohne `patch "…" no longer matches`-Fehler durch. (Der Output-Commit kommt erst in Task 4.)

- [ ] **Step 8: Commit (Plumbing, wie Task 1 Step 5, Datei `mockups/season2/liquid-deck/index.html`)**

Message: `feat(season2): Cloud-Seite — Verbinden-Karten + Konten-Sheet (ansehen/kopieren/trennen)`

---

### Task 3: cloudAuthStore auf SecureStore migrieren (tms-terminal-Worktree)

**Files:**
- Modify: `~/Desktop/tms-terminal/mobile/src/store/cloudAuthStore.ts`

**Interfaces:**
- Consumes: `expo-secure-store` (bereits Dependency), bestehende Store-API.
- Produces: unveränderte Store-API (`tokens`, `setToken`, `clearPlatform`, …) — alle bestehenden Konsumenten (CloudSetup, Panels, Polling, Bridge) funktionieren unverändert. Neu exportiert: `hydrateCloudTokens(): Promise<void>` (wird am Modulende selbst aufgerufen).

- [ ] **Step 1: Store umbauen** — Tokens raus aus dem persistierten JSON, Write-Through nach SecureStore, Einmal-Migration:

```ts
import * as SecureStore from 'expo-secure-store';

const SECURE_PREFIX = 'tms_cloud_token_';
const PLATFORMS: CloudPlatform[] = ['render', 'vercel'];
```

`setToken` und `clearPlatform` schreiben zusätzlich nach SecureStore (fire-and-forget):

```ts
      setToken: (platform, token) => {
        if (token) SecureStore.setItemAsync(SECURE_PREFIX + platform, token).catch(() => {});
        else SecureStore.deleteItemAsync(SECURE_PREFIX + platform).catch(() => {});
        set({ tokens: { ...get().tokens, [platform]: token } });
      },
      // …
      clearPlatform: (platform) => {
        SecureStore.deleteItemAsync(SECURE_PREFIX + platform).catch(() => {});
        set({
          tokens: { ...get().tokens, [platform]: null },
          activeOwnerId: { ...get().activeOwnerId, [platform]: null },
        });
      },
```

persist-Optionen: Tokens ausklammern —

```ts
    {
      name: 'tms-cloud-auth',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        activeOwnerId: s.activeOwnerId,
        notificationsEnabled: s.notificationsEnabled,
        pollingIntervalMs: s.pollingIntervalMs,
      }),
    },
```

Hydration + Migration ans Modulende:

```ts
/**
 * Loads tokens from SecureStore into the store. One-time migration: tokens
 * that older versions persisted in the AsyncStorage JSON are moved into
 * SecureStore and stripped from the JSON.
 */
export async function hydrateCloudTokens(): Promise<void> {
  const tokens: Record<CloudPlatform, string | null> = { render: null, vercel: null };
  for (const p of PLATFORMS) {
    tokens[p] = await SecureStore.getItemAsync(SECURE_PREFIX + p).catch(() => null);
  }
  try {
    const raw = await AsyncStorage.getItem('tms-cloud-auth');
    if (raw) {
      const parsed = JSON.parse(raw);
      const legacy = parsed?.state?.tokens as Partial<Record<CloudPlatform, string>> | undefined;
      if (legacy) {
        for (const p of PLATFORMS) {
          if (!tokens[p] && legacy[p]) {
            tokens[p] = legacy[p]!;
            await SecureStore.setItemAsync(SECURE_PREFIX + p, legacy[p]!);
          }
        }
        delete parsed.state.tokens;
        await AsyncStorage.setItem('tms-cloud-auth', JSON.stringify(parsed));
      }
    }
  } catch { /* corrupt legacy JSON: keep whatever SecureStore had */ }
  useCloudAuthStore.setState({ tokens });
}

hydrateCloudTokens().catch(() => {});
```

- [ ] **Step 2: Typecheck**

Run: `cd ~/Desktop/tms-terminal/mobile && npx tsc --noEmit`
Expected: 0 Fehler

- [ ] **Step 3: Commit** (im tms-terminal-Worktree; erst normal mit Timeout, bei Hänger Plumbing):

```bash
cd ~/Desktop/tms-terminal && git add mobile/src/store/cloudAuthStore.ts && git commit -m "feat(cloud): API-Keys in SecureStore statt AsyncStorage — mit Einmal-Migration"
```

---

### Task 4: Bridge zweigleisig — Render + Konten-Nachrichten (tms-terminal-Worktree)

**Files:**
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/useSeasonTwoBackends.ts` (`useCloudBridge`)
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js` (Cloud-Block, ca. Zeile 1064 + TMSBridge-Block ca. Zeile 1268)
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/SeasonTwoWebRoot.tsx` (onMessage-Switch + Hook-Destrukturierung Zeile 144)
- Modify: `~/Desktop/tms-terminal/mobile/scripts/build-season2-html.js` (Boot-Reset der Konten)

**Interfaces:**
- Consumes: `TMS_DATA.cloudAccounts`-Form aus Task 1; Stub-Namen aus Task 2; `useCloudAuthStore` inkl. SecureStore-Write-Through aus Task 3; `createRenderService`/`createVercelService` (`CloudProvider`-Interface: `listOwners()`, `listProjects(ownerId)`, `listEnvVars(id)`, `getServiceLogs(id)`, `listDeployments(id)`); `TokenExpiredError` aus `cloud.types`.
- Produces: Bridge-Nachrichten `cloud:connect|disconnect|revealKey|copyKey {provider, token?}` (Web→RN); Page-Callbacks `TMSBridge.setCloudAccounts(accounts)`, `TMSBridge.cloudKeyRevealed(provider, key)` (RN→Web). `useCloudBridge` gibt zusätzlich `{ connect, disconnect, reveal, pushAccounts }` zurück.

- [ ] **Step 1: bridge.js — Stubs überschreiben + TMSBridge-Setter** (im `══ Cloud ══`-Block ergänzen):

```js
  window.requestCloudConnect = function (provider, token) { post('cloud:connect', { provider: provider, token: token }); };
  window.requestCloudDisconnect = function (provider) { post('cloud:disconnect', { provider: provider }); };
  window.requestCloudRevealKey = function (provider) { post('cloud:revealKey', { provider: provider }); };
  window.requestCloudCopyKey = function (provider) { post('cloud:copyKey', { provider: provider }); };
```

und bei den TMSBridge-Settern (neben `setCloud`):

```js
  window.TMSBridge.setCloudAccounts = function (accounts) {
    window.TMS_DATA.cloudAccounts = accounts;
    if (typeof window.renderCloudGroups === 'function') window.renderCloudGroups();
    if (typeof window.renderCloudAccountsSheet === 'function') window.renderCloudAccountsSheet();
  };
  window.TMSBridge.cloudKeyRevealed = function (provider, key) {
    if (typeof window.cloudKeyRevealed === 'function') window.cloudKeyRevealed(provider, key);
  };
```

- [ ] **Step 2: build-season2-html.js — Konten beim Boot leeren** (im Block, der `cloudProjects = []` setzt, Zeile ~46 ergänzen):

```js
window.TMS_DATA.cloudAccounts = { vercel: { connected: false, maskedKey: null }, render: { connected: false, maskedKey: null } };
```

- [ ] **Step 3: useCloudBridge zweigleisig umbauen** — kompletter Ersatz der Funktion:

```ts
import { createRenderService } from '../../services/render.service';
import { TokenExpiredError } from '../../services/cloud.types';
import type { CloudPlatform } from '../../store/cloudAuthStore';

const CLOUD_FACTORY = { vercel: createVercelService, render: createRenderService } as const;

function maskKey(t: string): string {
  return t.length <= 8 ? '••••' : `${t.slice(0, 4)}••••…${t.slice(-3)}`;
}

export function useCloudBridge(ready: boolean, call: Call) {
  const tokens = useCloudAuthStore((s) => s.tokens);
  const activeOwnerId = useCloudAuthStore((s) => s.activeOwnerId);
  const setToken = useCloudAuthStore((s) => s.setToken);
  const clearPlatform = useCloudAuthStore((s) => s.clearPlatform);
  const services = useRef<Record<CloudPlatform, CloudProvider | null>>({ vercel: null, render: null });
  // (Import ergänzen: `import type { CloudProvider } from '../../services/cloud.types';`)
  const invalid = useRef<Record<CloudPlatform, boolean>>({ vercel: false, render: false });

  const pushAccounts = useCallback(() => {
    const acc = {} as Record<CloudPlatform, object>;
    (['vercel', 'render'] as CloudPlatform[]).forEach((p) => {
      const t = tokens[p];
      acc[p] = { connected: !!t, maskedKey: t ? maskKey(t) : null, invalid: invalid.current[p] };
    });
    call('setCloudAccounts', acc);
  }, [tokens, call]);

  /** Loads one provider's projects; returns [] when unlinked or failing. */
  const loadProvider = useCallback(async (p: CloudPlatform) => {
    const token = tokens[p];
    if (!token) { services.current[p] = null; return []; }
    try {
      const svc = CLOUD_FACTORY[p](token);
      services.current[p] = svc;
      const ownerId = activeOwnerId[p] ?? (await svc.listOwners())[0]?.id;
      if (!ownerId) return [];
      const page = await svc.listProjects(ownerId);
      invalid.current[p] = false;
      return page.items.map((proj: Project) => ({
        id: `${p}:${proj.id}`,
        provider: p,
        name: proj.name,
        folder: proj.repo ?? (p === 'vercel' ? 'Vercel' : 'Render'),
        favorite: false,
        status: STATUS_MAP[proj.status] ?? 'ready',
        lastDeploy: relativeTime(proj.updatedAt),
        env: [], logs: [],
      }));
    } catch (e: any) {
      if (e instanceof TokenExpiredError) { invalid.current[p] = true; pushAccounts(); }
      call('toast', `Cloud (${p}): ${e?.message ?? 'Laden fehlgeschlagen'}`);
      return [];
    }
  }, [tokens, activeOwnerId, call, pushAccounts]);

  const loadProjects = useCallback(async () => {
    if (!ready) return;
    const [vercel, render] = await Promise.all([loadProvider('vercel'), loadProvider('render')]);
    call('setCloud', [...vercel, ...render]);
  }, [ready, loadProvider, call]);

  /** Env, Logs and Deploys for one project — id carries the provider prefix. */
  const loadDetail = useCallback(async (prefixedId: string) => {
    const sep = prefixedId.indexOf(':');
    const provider = prefixedId.slice(0, sep) as CloudPlatform;
    const projectId = prefixedId.slice(sep + 1);
    const svc = services.current[provider];
    if (!svc) return;
    const [env, logs, deploys] = await Promise.all([
      svc.listEnvVars(projectId).catch(() => [] as EnvVar[]),
      svc.getServiceLogs(projectId).catch(() => [] as LogEntry[]),
      svc.listDeployments(projectId).then((r) => r.items).catch(() => [] as Deployment[]),
    ]);
    call('setCloudDetail', prefixedId, {
      env: env.map((e) => ({ key: e.key, value: e.value })),
      logs: logs.map((l) => `${new Date(l.timestamp).toLocaleTimeString('de-DE')} ${l.message}`),
      deploys: deploys.slice(0, 10).map((d, i) => ({
        version: d.commitHash ? d.commitHash.slice(0, 7) : `#${deploys.length - i}`,
        time: relativeTime(d.createdAt),
        status: STATUS_MAP[d.status] ?? d.status,
      })),
    });
  }, [call]);

  /** Validates the key with a cheap call before saving — bad keys never persist. */
  const connect = useCallback(async (provider: CloudPlatform, token: string) => {
    try {
      const svc = CLOUD_FACTORY[provider](token.trim());
      await svc.listOwners();
      invalid.current[provider] = false;
      setToken(provider, token.trim());
      call('toast', `${provider === 'vercel' ? 'Vercel' : 'Render'} verbunden`);
    } catch {
      call('toast', 'Key ungültig — bitte prüfen');
    }
  }, [setToken, call]);

  const disconnect = useCallback((provider: CloudPlatform) => {
    invalid.current[provider] = false;
    clearPlatform(provider);
  }, [clearPlatform]);

  const reveal = useCallback((provider: CloudPlatform) => {
    call('cloudKeyRevealed', provider, useCloudAuthStore.getState().tokens[provider] ?? '');
  }, [call]);

  // Token changes (connect/disconnect) refresh accounts + project list.
  useEffect(() => {
    if (!ready) return;
    pushAccounts();
    loadProjects();
  }, [ready, tokens.vercel, tokens.render]); // eslint-disable-line react-hooks/exhaustive-deps

  return { loadProjects, loadDetail, connect, disconnect, reveal, pushAccounts };
}
```

- [ ] **Step 4: SeasonTwoWebRoot verdrahten** — Destrukturierung (Zeile ~144) erweitern:

```ts
  const { loadProjects: loadCloud, loadDetail: loadCloudDetail, connect: cloudConnect, disconnect: cloudDisconnect, reveal: cloudReveal, pushAccounts: pushCloudAccounts } = useCloudBridge(ready, call);
```

Im onMessage-Switch neben `case 'cloud:open'` ergänzen:

```ts
      case 'cloud:connect':
        cloudConnect(payload.provider, payload.token);
        break;

      case 'cloud:disconnect':
        cloudDisconnect(payload.provider);
        break;

      case 'cloud:revealKey':
        cloudReveal(payload.provider);
        break;

      case 'cloud:copyKey': {
        const key = useCloudAuthStore.getState().tokens[payload.provider as CloudPlatform];
        if (key) Clipboard.setStringAsync(key).then(() => call('toast', 'Key kopiert'));
        break;
      }
```

(Import ergänzen: `import { useCloudAuthStore, type CloudPlatform } from '../store/cloudAuthStore';` — Pfad an die bestehenden Imports der Datei anpassen. `Clipboard` ist bereits importiert.)

`case 'nav:screen'`: bei `payload.screen === 'cloud'` zusätzlich `pushCloudAccounts();` vor `loadCloud();`.

Die `useCallback`-Dependency-Liste von `onMessage` (Zeile ~707) um `cloudConnect, cloudDisconnect, cloudReveal, pushCloudAccounts` erweitern.

- [ ] **Step 5: Build + Typecheck**

Run: `cd ~/Desktop/tms-terminal/mobile && npm run build:season2 && npx tsc --noEmit`
Expected: Build ohne Patch-Fehler, tsc 0 Fehler. (`liquidDeckHtml.ts` wird mit committet.)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal && git add mobile/src/season2/web/bridge.js mobile/src/season2/web/useSeasonTwoBackends.ts mobile/src/season2/web/liquidDeckHtml.ts mobile/src/season2/SeasonTwoWebRoot.tsx mobile/scripts/build-season2-html.js && git commit -m "feat(season2): Cloud-Konten real — Render+Vercel verbinden, Key ansehen/kopieren, SecureStore"
```

---

### Task 5: Ende-zu-Ende-Verifikation + Ship

**Files:** keine neuen — Verifikation und Release.

- [ ] **Step 1: Remote-Stand prüfen** (parallele Jobs pushen auf denselben Branch):

Run: `cd ~/Desktop/tms-terminal && git fetch origin feat/manager-chat-redesign && git status -sb`
Bei Divergenz: rebase/patchen statt kopieren.

- [ ] **Step 2: Push + CI-Build** (lokaler APK-Build hängt am Metro-Headless — Release via GitHub-Actions-Tag-Workflow, wie gehabt):

```bash
git push origin feat/manager-chat-redesign
```

Danach Release-Tag nach Absprache mit dem User (Versionsschema wie bisher, z. B. v1.96.0).

- [ ] **Step 3: Manueller Gerätetest (User, Fold 7)** — Checkliste an den User:
  1. Cloud-Seite ohne Keys → zwei Verbinden-Karten.
  2. Echten Render-Key eingeben → „Render verbunden", Services erscheinen mit `R`-Glyph; Env/Logs/Deploys im Detail.
  3. Vercel-Key eingeben → gemischte Liste, Filter Alle/Vercel/Render funktioniert.
  4. Konten-Sheet: Key anzeigen, kopieren (Toast „Key kopiert", in anderer App einfügbar), trennen.
  5. App schließen + neu öffnen → Keys noch da. App-Update installieren → Keys noch da.
  6. Absichtlich falschen Key eingeben → „Key ungültig — bitte prüfen", nichts gespeichert.
