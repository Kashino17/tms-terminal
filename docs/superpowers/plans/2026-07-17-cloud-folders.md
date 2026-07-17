# Cloud-Ordner & Übersicht — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (User-Vorgabe: Implementierung im Hauptkontext, KEINE Subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eigene Projektordner auf der Cloud-Seite — Ordnerleiste mit Start-Ordner, persistente Standardfilter + Suche, ruhige Status-Farben, Mehrfachauswahl zum Zuweisen; Organisation persistiert in einem RN-Store (AsyncStorage).

**Architecture:** Mockup rendert alles aus `TMS_DATA.cloudOrg` (Seed in data.js); Änderungen laufen über den überschreibbaren Stub `window.requestCloudOrgUpdate(org)`. Die Bridge ersetzt ihn durch `post('cloud:org:update')`; RN persistiert in `cloudOrgStore` und pusht `setCloudOrg(org)` beim Öffnen. Favoriten wandern von localStorage in den Org-Zustand (einmalige Migration in der Seite).

**Tech Stack:** Vanilla JS (Mockup), zustand + AsyncStorage (RN), node:test (Seed), Headless-Chrome (UI-Verifikation).

## Global Constraints

- Worktrees/Git/Build/Test-Regeln wie im Plan `2026-07-17-cloud-provider-linking.md` (Plumbing-Commits hier; Build-Patches nicht brechen; kein Test-Runner in mobile → tsc + headless; UI Deutsch, Kommentare Englisch).
- **User-Gate:** Nach dem Mockup (Task 3) Screenshots an den User; RN-Verkabelung (Task 4/5) erst nach dessen Ok. Ship (Task 6) wie gehabt via Tag/CI, Versionsnummer vorher gegen Remote-Tags prüfen (parallele Jobs!).
- Virtuelle Ordner-IDs: `'fav' | 'all' | 'unsorted'`; Palette: `#f03e3e #f76707 #f59f00 #37b24d #1c7ed6 #7048e8 #d6336c #64748B`.
- Jede globale Terminal-Heuristik der Bridge braucht weiterhin die `cloud-`-Ausnahme; die neuen `.cloud-row`s sind KEINE `.card-body[data-card-id]` — nicht betroffen.

---

### Task 1: Seed `cloudOrg` + Tests (Mockup-Worktree)

**Files:**
- Modify: `mockups/season2/shared/data.js` (nach `cloudAccounts`)
- Test: `mockups/season2/shared/data.test.cjs`

**Interfaces:**
- Produces: `TMS_DATA.cloudOrg = { folders: [{id,name,color,order}], assignments: {projektId→folderId}, favorites: {projektId→true}, startFolderId, defaultFilters: {provider,status} }` — Task 2/3 rendern daraus, Task 5 spiegelt exakt diese Form im RN-Store.

- [ ] **Step 1: Failing Test** in `data.test.cjs`:

```js
test('cloud org seed: folders, assignments, favorites, start folder, filters', () => {
  const org = DATA.cloudOrg;
  assert.ok(Array.isArray(org.folders) && org.folders.length >= 2);
  for (const f of org.folders) assert.ok(f.id && f.name && /^#/.test(f.color) && typeof f.order === 'number');
  const ids = new Set(DATA.cloudProjects.map(p => p.id));
  for (const pid of Object.keys(org.assignments)) assert.ok(ids.has(pid));
  for (const pid of Object.keys(org.favorites)) assert.ok(ids.has(pid));
  assert.ok(['fav', 'all', 'unsorted'].includes(org.startFolderId) || org.folders.some(f => f.id === org.startFolderId));
  assert.ok(['all', 'vercel', 'render'].includes(org.defaultFilters.provider));
  assert.ok(['all', 'active', 'attention'].includes(org.defaultFilters.status));
});
```

- [ ] **Step 2:** `node --test mockups/season2/shared/data.test.cjs` → FAIL (cloudOrg undefined)

- [ ] **Step 3: Seed** in data.js nach `cloudAccounts` (Demo zeigt die Ordnerwelt; `favorite`-Felder der cloudProjects bleiben als tote Daten stehen, gelesen wird nur noch org.favorites):

```js
    // Custom folder organisation — the app persists this in React Native
    // (cloudOrgStore) and pushes it via TMSBridge.setCloudOrg.
    cloudOrg: {
      folders: [
        { id: 'f-pin',   name: 'Pinterest', color: '#d6336c', order: 0 },
        { id: 'f-infra', name: 'Infra',     color: '#1c7ed6', order: 1 },
      ],
      assignments: { c1: 'f-pin', c4: 'f-pin', c5: 'f-infra' },
      favorites: { c1: true, c3: true, c5: true },
      startFolderId: 'fav',
      defaultFilters: { provider: 'all', status: 'all' },
    },
```

- [ ] **Step 4:** Tests → alle PASS
- [ ] **Step 5:** Plumbing-Commit `feat(season2): Cloud-Org-Seed (Ordner/Zuweisungen/Favoriten) + Tests`

---

### Task 2: Mockup — Ordnerleiste, Filterzeile, neue Service-Zeilen

**Files:**
- Modify: `mockups/season2/liquid-deck/index.html` (Cloud-CSS-Block ~Z.1117; `renderCloudShell`/`renderCloudGroups`/`wireCloudToolbar` im Cloud-Abschnitt)

**Interfaces:**
- Consumes: `TMS_DATA.cloudOrg` (Task 1), `TMS_DATA.cloudProjects`, `CLOUD_GLYPH`, `escapeHtml`, `icon`, `toast`, `openSheet/closeSheet`.
- Produces (global, für Task 3/5): `renderCloudFolderBar()`, `renderCloudList()` (ersetzt `renderCloudGroups` — Alias `window.renderCloudGroups = renderCloudList` für die Bridge), `cloudOrgChanged()` (persistiert via `window.requestCloudOrgUpdate(structuredClone(TMS_DATA.cloudOrg))` und rendert neu), Helfer `repoShort(p)`, `visibleCloudProjects()`, `folderOf(pid)`, `projectCountFor(folderId)`.
- State-Erweiterung: `state.cloudFolder` (aktiver Ordner, init null → beim Screen-Öffnen Start-Ordner), `state.cloudStatusFilter ('all'|'active'|'attention')`, `state.cloudSearch ''`, `state.cloudSelect = null | { ids: Set }`.

- [ ] **Step 1: CSS ergänzen/ersetzen** (im Cloud-Block; `.cloud-connect-*`/`.cloud-account-*` bleiben):

```css
  /* ---------- Folder bar ---------- */
  .cloud-folderbar { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 10px; scrollbar-width: none; }
  .cloud-folderbar::-webkit-scrollbar { display: none; }
  .folder-chip { flex: none; display: flex; align-items: center; gap: 7px; padding: 8px 13px; border-radius: 999px; font: 600 12.5px var(--font-ui); color: var(--text-dim); background: rgba(var(--overlay-rgb),.05); border: 1px solid var(--glass-border); cursor: pointer; }
  .folder-chip.active { color: var(--text); background: rgba(var(--accent-rgb),.16); border-color: rgba(var(--accent-rgb),.4); }
  .folder-chip__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .folder-chip__count { font: 600 11px var(--font-mono); color: var(--text-dim); }
  .folder-chip__warn { color: #f59f00; font-size: 11px; }
  .folder-chip--add { padding: 8px 12px; font-size: 15px; line-height: 1; }
  /* ---------- Filter row ---------- */
  .cloud-filterrow { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .cloud-filterrow .chip-group button { padding: 6px 10px; font-size: 11.5px; }
  .cloud-search { flex: 1; min-width: 110px; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--glass-border); background: rgba(var(--overlay-rgb),.05); color: inherit; font: 12.5px var(--font-ui); }
  /* ---------- Dense service rows ---------- */
  .svc-row { display: flex; align-items: center; gap: 11px; width: 100%; padding: 10px 10px; text-align: left; cursor: pointer; border-radius: 12px; border-left: 3px solid transparent; }
  .svc-row:active { background: rgba(var(--overlay-rgb),.05); }
  .svc-row + .svc-row { margin-top: 2px; }
  .svc-row--error { border-left-color: #f03e3e; background: rgba(240,62,62,.06); }
  .svc-glyph { flex: none; width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font: 700 13px var(--font-mono); background: rgba(var(--overlay-rgb),.08); }
  .svc-glyph--vercel { color: var(--text); }
  .svc-glyph--render { color: #9775fa; }
  .svc-row__main { flex: 1; min-width: 0; }
  .svc-row__name { font: 700 13.5px var(--font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .svc-row__repo { font: 11px var(--font-mono); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .svc-row__side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .svc-status { display: flex; align-items: center; gap: 5px; font: 11px var(--font-mono); color: var(--text-dim); }
  .svc-status .dot { width: 7px; height: 7px; border-radius: 50%; }
  .svc-status[data-s="ready"] .dot { background: rgba(55,178,77,.55); }
  .svc-status[data-s="building"] .dot { background: #f59f00; animation: dotBreathe 1.3s ease-in-out infinite; }
  .svc-status[data-s="error"] .dot { background: #f03e3e; }
  .svc-status[data-s="suspended"] .dot, .svc-status[data-s="inactive"] .dot { background: #64748B; }
  .svc-row .fav-btn { margin-left: 2px; }
  .svc-check { flex: none; width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--glass-border); display: none; align-items: center; justify-content: center; font-size: 12px; }
  .cloud-selecting .svc-check { display: flex; }
  .svc-row.is-checked .svc-check { background: rgba(var(--accent-rgb),.3); border-color: var(--accent); }
  /* ---------- Selection action bar ---------- */
  .cloud-actionbar { position: sticky; bottom: 8px; display: flex; gap: 8px; padding: 10px; border-radius: 14px; margin-top: 10px; }
  .cloud-actionbar .btn-chip { flex: 1; text-align: center; }
  .cloud-empty { text-align: center; color: var(--text-dim); font: 12.5px var(--font-ui); padding: 28px 0 16px; }
```

- [ ] **Step 2: `renderCloudShell()` neu** (ersetzt Toolbar-Markup; Konten-Chip wandert in die Filterzeile):

```js
  function renderCloudShell() {
    const host = document.querySelector('[data-screen="cloud"]');
    host.innerHTML = `
      <h1 class="screen-title">Cloud</h1>
      <div class="screen-col">
        <div id="cloudList">
          <div class="cloud-folderbar" id="cloudFolderBar"></div>
          <div class="cloud-filterrow">
            <div class="chip-group" id="cloudProviderFilter">
              <button data-provider="all" class="active">Alle</button>
              <button data-provider="vercel">▲</button>
              <button data-provider="render">R</button>
            </div>
            <div class="chip-group" id="cloudStatusFilter">
              <button data-status="all" class="active">Alle</button>
              <button data-status="active">Aktiv</button>
              <button data-status="attention">Probleme</button>
            </div>
            <input type="search" class="cloud-search" id="cloudSearch" placeholder="Suchen…" autocomplete="off">
            <div class="chip-group">
              <button id="cloudDefaultBtn" type="button" title="Filter als Standard">Standard</button>
              <button id="cloudAccountsBtn" type="button">Konten</button>
            </div>
          </div>
          <div id="cloudGroups"></div>
        </div>
        <div id="cloudDetail" hidden></div>
      </div>`;
  }
```

- [ ] **Step 3: Helfer + Renderer** (ersetzt `cloudConnectedProviders`-Umfeld NICHT — die Connect-Karten-Logik bleibt und wird in `renderCloudList` weiterverwendet):

```js
  const CLOUD_FOLDER_PALETTE = ['#f03e3e', '#f76707', '#f59f00', '#37b24d', '#1c7ed6', '#7048e8', '#d6336c', '#64748B'];
  const VIRTUAL_FOLDERS = [
    { id: 'fav', name: '★ Favoriten' },
    { id: 'all', name: 'Alle' },
    { id: 'unsorted', name: 'Unsortiert' },
  ];

  function cloudOrg() { return TMS_DATA.cloudOrg; }
  function folderOf(pid) { return cloudOrg().assignments[pid] || null; }
  function repoShort(p) {
    const raw = String(p.folder || '');
    const seg = raw.replace(/\/+$/, '').split('/').pop() || '';
    return (seg || p.provider).toLowerCase();
  }
  function isAttention(p) { return p.status === 'error' || p.status === 'suspended'; }

  function projectsInFolder(folderId) {
    const org = cloudOrg();
    return TMS_DATA.cloudProjects.filter(p => {
      if (folderId === 'all') return true;
      if (folderId === 'fav') return !!org.favorites[p.id];
      if (folderId === 'unsorted') return !folderOf(p.id);
      return folderOf(p.id) === folderId;
    });
  }

  function visibleCloudProjects() {
    const q = state.cloudSearch.trim().toLowerCase();
    return projectsInFolder(state.cloudFolder).filter(p =>
      (state.cloudProviderFilter === 'all' || p.provider === state.cloudProviderFilter) &&
      (state.cloudStatusFilter === 'all' ||
        (state.cloudStatusFilter === 'active' ? (p.status === 'ready' || p.status === 'building') : isAttention(p))) &&
      (!q || p.name.toLowerCase().includes(q)));
  }

  /** Single write path: hand the whole org to the app (or the demo stub). */
  function cloudOrgChanged() {
    window.requestCloudOrgUpdate(JSON.parse(JSON.stringify(cloudOrg())));
    renderCloudFolderBar();
    renderCloudList();
  }

  function renderCloudFolderBar() {
    const bar = document.getElementById('cloudFolderBar');
    if (!bar) return;
    const org = cloudOrg();
    const customs = [...org.folders].sort((a, b) => a.order - b.order);
    const chips = [...VIRTUAL_FOLDERS, ...customs].map(f => {
      const list = projectsInFolder(f.id);
      const warn = list.some(isAttention) ? '<span class="folder-chip__warn">⚠</span>' : '';
      const dot = f.color ? `<span class="folder-chip__dot" style="background:${f.color}"></span>` : '';
      return `<button class="folder-chip${state.cloudFolder === f.id ? ' active' : ''}" data-folder="${f.id}">
        ${dot}<span>${escapeHtml(f.name)}</span><span class="folder-chip__count">${list.length}</span>${warn}</button>`;
    }).join('');
    bar.innerHTML = chips + '<button class="folder-chip folder-chip--add" id="cloudFolderAdd" type="button">+</button>';
  }

  function svcRowHtml(p) {
    const org = cloudOrg();
    const checked = state.cloudSelect && state.cloudSelect.ids.has(p.id);
    return `
      <button class="svc-row${p.status === 'error' ? ' svc-row--error' : ''}${checked ? ' is-checked' : ''}" data-project="${p.id}">
        <span class="svc-check">${checked ? '✓' : ''}</span>
        <span class="svc-glyph svc-glyph--${p.provider}">${CLOUD_GLYPH[p.provider] || '?'}</span>
        <span class="svc-row__main">
          <span class="svc-row__name">${escapeHtml(p.name)}</span>
          <span class="svc-row__repo">${escapeHtml(repoShort(p))}</span>
        </span>
        <span class="svc-row__side">
          <span class="svc-status" data-s="${p.status}"><span class="dot"></span>${p.status === 'suspended' ? '⏸ ' : ''}${escapeHtml(p.lastDeploy)}</span>
        </span>
        <span class="fav-btn${org.favorites[p.id] ? ' is-fav' : ''}" data-fav="${p.id}" role="button" aria-label="Favorit">${icon('star')}</span>
      </button>`;
  }

  function renderCloudList() {
    const host = document.getElementById('cloudGroups');
    if (!host) return;
    const connected = cloudConnectedProviders();
    if (connected.length === 0) {
      host.innerHTML = cloudConnectCardHtml('vercel') + cloudConnectCardHtml('render');
      bindCloudConnectCards(host);
      return;
    }
    const list = visibleCloudProjects();
    host.classList.toggle('cloud-selecting', !!state.cloudSelect);
    const rows = list.map(svcRowHtml).join('');
    const empty = list.length ? '' : '<div class="cloud-empty">Keine Services hier — Filter prüfen oder Services über Long-Press zuweisen.</div>';
    const bar = state.cloudSelect ? `
      <div class="cloud-actionbar glass glass--strong">
        <button class="btn-chip is-on" id="selMoveBtn" type="button">In Ordner ▾</button>
        <button class="btn-chip" id="selFavBtn" type="button">★ Favorit</button>
        <button class="btn-chip" id="selDoneBtn" type="button">Fertig (${state.cloudSelect.ids.size})</button>
      </div>` : '';
    host.innerHTML = `<div class="folder-group glass"><div class="folder-group__rows">${rows}</div></div>${empty}${bar}`;
    const missing = ['vercel', 'render'].filter(pv => !connected.includes(pv));
    if (missing.length === 1 && state.cloudFolder === 'all') {
      host.insertAdjacentHTML('beforeend', cloudConnectCardHtml(missing[0]));
      bindCloudConnectCards(host);
    }
    if (state.cloudSelect) {
      document.getElementById('selMoveBtn').addEventListener('click', openMoveSheet);
      document.getElementById('selFavBtn').addEventListener('click', () => {
        const org = cloudOrg();
        state.cloudSelect.ids.forEach(id => { if (org.favorites[id]) delete org.favorites[id]; else org.favorites[id] = true; });
        cloudOrgChanged();
      });
      document.getElementById('selDoneBtn').addEventListener('click', () => { state.cloudSelect = null; renderCloudList(); });
    }
  }
  window.renderCloudGroups = renderCloudList; // bridge + alte Aufrufer
  window.renderCloudFolderBar = renderCloudFolderBar; // bridge aktualisiert die Chip-Zähler
```

- [ ] **Step 4: `wireCloudToolbar()` erweitern** (bestehende Provider-Filter-Verdrahtung anpassen, View-Toggle-Code entfernen):

```js
    document.getElementById('cloudStatusFilter').addEventListener('click', e => {
      const btn = e.target.closest('button[data-status]');
      if (!btn) return;
      state.cloudStatusFilter = btn.dataset.status;
      document.querySelectorAll('#cloudStatusFilter button').forEach(b => b.classList.toggle('active', b === btn));
      renderCloudList(); syncDefaultBtn();
    });
    document.getElementById('cloudSearch').addEventListener('input', e => {
      state.cloudSearch = e.target.value; renderCloudList();
    });
    function syncDefaultBtn() {
      const d = cloudOrg().defaultFilters;
      document.getElementById('cloudDefaultBtn').classList.toggle('is-on',
        d.provider === state.cloudProviderFilter && d.status === state.cloudStatusFilter);
    }
    document.getElementById('cloudDefaultBtn').addEventListener('click', () => {
      cloudOrg().defaultFilters = { provider: state.cloudProviderFilter, status: state.cloudStatusFilter };
      cloudOrgChanged(); syncDefaultBtn(); toast('Filter als Standard gespeichert');
    });
    document.getElementById('cloudFolderBar').addEventListener('click', e => {
      if (e.target.closest('#cloudFolderAdd')) { openFolderEditSheet(null); return; }
      const chip = e.target.closest('[data-folder]');
      if (!chip) return;
      state.cloudFolder = chip.dataset.folder;
      renderCloudFolderBar(); renderCloudList();
    });
```

Provider-Filter-Handler: `renderCloudGroups()`-Aufruf durch `renderCloudList(); syncDefaultBtn();` ersetzen. Der `cloudGroups`-Click-Handler behandelt zusätzlich Auswahlmodus (Task 3 Step 2).

- [ ] **Step 5: Screen-Hook** — beim Öffnen Start-Ordner + Standardfilter anwenden (bestehenden `SCREEN_HOOKS.cloud = showCloudList` erweitern):

```js
  SCREEN_HOOKS.cloud = function () {
    showCloudList();
    const org = cloudOrg();
    state.cloudFolder = org.startFolderId || (Object.keys(org.favorites).length ? 'fav' : 'all');
    state.cloudProviderFilter = org.defaultFilters.provider;
    state.cloudStatusFilter = org.defaultFilters.status;
    state.cloudSearch = '';
    document.querySelectorAll('#cloudProviderFilter button').forEach(b => b.classList.toggle('active', b.dataset.provider === state.cloudProviderFilter));
    document.querySelectorAll('#cloudStatusFilter button').forEach(b => b.classList.toggle('active', b.dataset.status === state.cloudStatusFilter));
    const s = document.getElementById('cloudSearch'); if (s) s.value = '';
    renderCloudFolderBar(); renderCloudList();
  };
```

(Alte `loadFavorites`/`saveFavorites` + FAV_KEY-Nutzung im Render-Pfad entfernen; `window.loadFavorites` bleibt als Migrationsquelle ungenutzt — Löschung erfolgt in Task 5 über die Seite.)

- [ ] **Step 6:** Headless-Smoke (Demo): Cloud öffnen → Ordnerleiste mit ★ Favoriten aktiv (Seed startFolderId 'fav'), Chips Alle/Unsortiert/Pinterest/Infra mit Zählern; Wechsel auf „Alle" zeigt 6 Demo-Services als dichte Zeilen mit Repo-Unterzeile. Keine Console-Errors.
- [ ] **Step 7:** Plumbing-Commit `feat(season2): Cloud-Ordnerleiste + Filterzeile + dichte Service-Zeilen`

---

### Task 3: Mockup — Sheets, Mehrfachauswahl, Demo-Stubs, Screenshots (User-Gate)

**Files:**
- Modify: `mockups/season2/liquid-deck/index.html` (Sheet-Markup bei den anderen Sheets; Cloud-Abschnitt)

**Interfaces:**
- Produces: `openFolderEditSheet(folderIdOrNull)`, `openFolderManageSheet(folderId)`, `openMoveSheet()`, Long-Press auf `.svc-row` startet Auswahl; Demo-Stub `window.requestCloudOrgUpdate(org)` (Bridge ersetzt ihn in Task 5).

- [ ] **Step 1: Sheet-Markup** (ein generisches Cloud-Org-Sheet neben `#cloudAccountsSheetWrap`):

```html
<div class="sheet-wrap" id="cloudOrgSheetWrap" hidden>
  <div class="sheet-backdrop" data-close-cloudorg></div>
  <div class="sheet-panel glass glass--strong">
    <div class="sheet-grabber"></div>
    <div class="sheet-head-row">
      <div class="sheet-title" id="cloudOrgSheetTitle"></div>
      <button class="sheet-close-btn" id="cloudOrgSheetClose">Schließen</button>
    </div>
    <div class="sheet-scroll-body" id="cloudOrgSheetBody"></div>
  </div>
</div>
```

CSS dazu:

```css
  .org-color-row { display: flex; gap: 10px; margin: 12px 0 16px; flex-wrap: wrap; }
  .org-color { width: 30px; height: 30px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
  .org-color.is-sel { border-color: var(--text); }
  .org-name-input { width: 100%; padding: 11px 13px; border-radius: 12px; border: 1px solid var(--glass-border); background: rgba(var(--overlay-rgb),.05); color: inherit; font: 13.5px var(--font-ui); margin-bottom: 4px; }
  .org-list-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 13px 6px; border-top: 1px solid rgba(var(--overlay-rgb),.08); font: 600 13.5px var(--font-ui); cursor: pointer; text-align: left; background: none; border-left: none; border-right: none; border-bottom: none; color: inherit; }
  .org-list-row:first-child { border-top: none; }
```

- [ ] **Step 2: Sheet-Logik + Long-Press + Row-Click-Routing** (Cloud-Abschnitt; Sheet-Schließer analog Konten-Sheet in `wireCloudToolbar` verdrahten):

```js
  function openCloudOrgSheet(title, bodyHtml, bind) {
    document.getElementById('cloudOrgSheetTitle').textContent = title;
    const body = document.getElementById('cloudOrgSheetBody');
    body.innerHTML = bodyHtml;
    if (bind) bind(body);
    openSheet(document.getElementById('cloudOrgSheetWrap'));
  }
  const closeCloudOrgSheet = () => closeSheet(document.getElementById('cloudOrgSheetWrap'));

  /** Create (folder==null) or rename/recolor an existing folder. */
  function openFolderEditSheet(folderId) {
    const org = cloudOrg();
    const f = folderId ? org.folders.find(x => x.id === folderId) : null;
    const sel = f ? f.color : CLOUD_FOLDER_PALETTE[4];
    openCloudOrgSheet(f ? 'Ordner bearbeiten' : 'Neuer Ordner', `
      <input class="org-name-input" id="orgName" placeholder="Ordnername" value="${f ? escapeHtml(f.name) : ''}">
      <div class="org-color-row">${CLOUD_FOLDER_PALETTE.map(c =>
        `<button class="org-color${c === sel ? ' is-sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
      <button class="btn-chip is-on" id="orgSaveBtn" style="width:100%;text-align:center;">${f ? 'Speichern' : 'Erstellen'}</button>
    `, body => {
      let color = sel;
      body.querySelectorAll('.org-color').forEach(b => b.addEventListener('click', () => {
        color = b.dataset.color;
        body.querySelectorAll('.org-color').forEach(x => x.classList.toggle('is-sel', x === b));
      }));
      body.querySelector('#orgSaveBtn').addEventListener('click', () => {
        const name = body.querySelector('#orgName').value.trim();
        if (!name) { toast('Bitte Namen eingeben'); return; }
        if (f) { f.name = name; f.color = color; }
        else {
          const id = 'f-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (org.folders.some(x => x.id === id)) { toast('Ordner existiert schon'); return; }
          org.folders.push({ id, name, color, order: org.folders.length });
          state.cloudFolder = id;
        }
        closeCloudOrgSheet(); cloudOrgChanged();
      });
    });
  }

  /** Long-press on a folder chip: start folder, edit, delete. */
  function openFolderManageSheet(folderId) {
    const org = cloudOrg();
    const custom = org.folders.find(x => x.id === folderId);
    const isStart = org.startFolderId === folderId;
    openCloudOrgSheet(custom ? custom.name : (VIRTUAL_FOLDERS.find(v => v.id === folderId) || {}).name || 'Ordner', `
      <button class="org-list-row" data-act="start">${isStart ? '✓ ' : ''}Als Start-Ordner festlegen</button>
      ${custom ? '<button class="org-list-row" data-act="edit">Umbenennen / Farbe</button>' : ''}
      ${custom ? '<button class="org-list-row" data-act="delete" style="color:#f03e3e">Löschen (Services → Unsortiert)</button>' : ''}
    `, body => {
      body.querySelector('[data-act="start"]').addEventListener('click', () => {
        org.startFolderId = folderId; closeCloudOrgSheet(); cloudOrgChanged(); toast('Start-Ordner gesetzt');
      });
      const ed = body.querySelector('[data-act="edit"]');
      if (ed) ed.addEventListener('click', () => { closeCloudOrgSheet(); openFolderEditSheet(folderId); });
      const del = body.querySelector('[data-act="delete"]');
      if (del) del.addEventListener('click', () => {
        org.folders = org.folders.filter(x => x.id !== folderId);
        Object.keys(org.assignments).forEach(pid => { if (org.assignments[pid] === folderId) delete org.assignments[pid]; });
        if (org.startFolderId === folderId) org.startFolderId = 'all';
        if (state.cloudFolder === folderId) state.cloudFolder = 'all';
        closeCloudOrgSheet(); cloudOrgChanged();
      });
    });
  }

  /** Move all selected services into a folder (or Unsortiert). */
  function openMoveSheet() {
    const org = cloudOrg();
    openCloudOrgSheet('In Ordner verschieben', `
      ${[...org.folders].sort((a, b) => a.order - b.order).map(f =>
        `<button class="org-list-row" data-move="${f.id}"><span class="folder-chip__dot" style="background:${f.color}"></span>${escapeHtml(f.name)}</button>`).join('')}
      <button class="org-list-row" data-move="unsorted">Unsortiert</button>
      <button class="org-list-row" data-move="__new">＋ Neuer Ordner…</button>
    `, body => {
      body.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
        const target = b.dataset.move;
        if (target === '__new') { closeCloudOrgSheet(); openFolderEditSheet(null); return; }
        state.cloudSelect.ids.forEach(pid => {
          if (target === 'unsorted') delete org.assignments[pid];
          else org.assignments[pid] = target;
        });
        state.cloudSelect = null;
        closeCloudOrgSheet(); cloudOrgChanged(); toast('Verschoben');
      }));
    });
  }
```

Long-Press (Zeilen + Ordner-Chips, Pointer-Timer wie in der Bridge, 550ms):

```js
  let cloudHold = null, cloudHoldMoved = false, cloudHoldStart = null;
  document.getElementById('cloudGroups')?.addEventListener('pointerdown', () => {}); // Delegation unten auf [data-screen="cloud"]
  const cloudScreenEl = document.querySelector('[data-screen="cloud"]');
  cloudScreenEl.addEventListener('pointerdown', e => {
    const row = e.target.closest('.svc-row');
    const chip = e.target.closest('.folder-chip[data-folder]');
    if (!row && !chip) return;
    cloudHoldMoved = false;
    cloudHoldStart = { x: e.clientX, y: e.clientY };
    clearTimeout(cloudHold);
    cloudHold = setTimeout(() => {
      if (cloudHoldMoved) return;
      if (row) {
        if (!state.cloudSelect) state.cloudSelect = { ids: new Set() };
        state.cloudSelect.ids.add(row.dataset.project);
        renderCloudList();
      } else {
        openFolderManageSheet(chip.dataset.folder);
      }
      if (navigator.vibrate) navigator.vibrate(10);
    }, 550);
  });
  cloudScreenEl.addEventListener('pointermove', e => {
    if (!cloudHoldStart) return;
    if (Math.abs(e.clientX - cloudHoldStart.x) > 8 || Math.abs(e.clientY - cloudHoldStart.y) > 8) { cloudHoldMoved = true; clearTimeout(cloudHold); }
  });
  ['pointerup', 'pointercancel'].forEach(ev => cloudScreenEl.addEventListener(ev, () => { clearTimeout(cloudHold); cloudHoldStart = null; }));
```

Row-Click-Routing im bestehenden `cloudGroups`-Click-Handler (ersetzt den alten Ordner-Kopf/`cloud-row`-Teil):

```js
    document.getElementById('cloudGroups').addEventListener('click', e => {
      const favBtn = e.target.closest('[data-fav]');
      if (favBtn) {
        const org = cloudOrg();
        const pid = favBtn.dataset.fav;
        if (org.favorites[pid]) delete org.favorites[pid]; else org.favorites[pid] = true;
        cloudOrgChanged();
        return;
      }
      const row = e.target.closest('.svc-row');
      if (!row) return;
      if (state.cloudSelect) {
        const pid = row.dataset.project;
        if (state.cloudSelect.ids.has(pid)) state.cloudSelect.ids.delete(pid); else state.cloudSelect.ids.add(pid);
        if (!state.cloudSelect.ids.size) state.cloudSelect = null;
        renderCloudList();
        return;
      }
      openCloudDetail(row.dataset.project, 'env');
    });
```

Demo-Stub (bei den anderen Cloud-Demo-Stubs):

```js
  window.requestCloudOrgUpdate = function (org) { TMS_DATA.cloudOrg = org; /* demo: nur lokal */ };
```

- [ ] **Step 3: data.test.cjs-Lauf + Build-Patch-Check** (`node --test …` PASS; `npm run build:season2` ohne Patch-Fehler — der Build-Reset für cloudOrg kommt erst in Task 5, das Mockup muss ohne RN weiter funktionieren)
- [ ] **Step 4: Headless-Screenshots (380dp)** für den User: (1) Start = Favoriten-Ordner, (2) „Alle" mit dichten Zeilen + Problemen, (3) Auswahlmodus mit Aktionsleiste, (4) Verschieben-Sheet, (5) Neuer-Ordner-Sheet, (6) Ordner-Verwalten-Sheet. Keine Console-Errors.
- [ ] **Step 5:** Plumbing-Commit `feat(season2): Cloud-Ordner — Sheets, Mehrfachauswahl, Long-Press`
- [ ] **Step 6: USER-GATE** — Screenshots präsentieren, auf Ok warten. Änderungswünsche einarbeiten, dann erst Task 4.

---

### Task 4: RN — `cloudOrgStore` (tms-terminal-Worktree)

**Files:**
- Create: `~/Desktop/tms-terminal/mobile/src/store/cloudOrgStore.ts`

**Interfaces:**
- Produces: `useCloudOrgStore` mit `{ org: CloudOrg, setOrg(org: CloudOrg): void }`; Typ `CloudOrg` exakt wie der Seed (folders/assignments/favorites/startFolderId/defaultFilters). Task 5 konsumiert beides.

- [ ] **Step 1: Store schreiben**:

```ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface CloudOrgFolder { id: string; name: string; color: string; order: number }
export interface CloudOrg {
  folders: CloudOrgFolder[];
  assignments: Record<string, string>;
  favorites: Record<string, true>;
  startFolderId: string | null;
  defaultFilters: { provider: 'all' | 'vercel' | 'render'; status: 'all' | 'active' | 'attention' };
}

export const EMPTY_CLOUD_ORG: CloudOrg = {
  folders: [],
  assignments: {},
  favorites: {},
  startFolderId: null,
  defaultFilters: { provider: 'all', status: 'all' },
};

interface CloudOrgState { org: CloudOrg; setOrg: (org: CloudOrg) => void }

export const useCloudOrgStore = create<CloudOrgState>()(
  persist(
    (set) => ({
      org: EMPTY_CLOUD_ORG,
      setOrg: (org) => set({ org }),
    }),
    { name: 'tms-cloud-org', storage: createJSONStorage(() => AsyncStorage) },
  ),
);
```

- [ ] **Step 2:** `npx tsc --noEmit` → 0 Fehler
- [ ] **Step 3:** Commit `feat(cloud): cloudOrgStore — Ordner/Favoriten/Filter persistent (AsyncStorage)`

---

### Task 5: Bridge-Verkabelung + Favoriten-Migration (tms-terminal-Worktree)

**Files:**
- Modify: `bridge.js` (Cloud-Block + TMSBridge-Setter), `useSeasonTwoBackends.ts` (`useCloudBridge`), `SeasonTwoWebRoot.tsx` (Switch + nav:screen), `scripts/build-season2-html.js` (Boot-Reset)

**Interfaces:**
- Consumes: `useCloudOrgStore`/`EMPTY_CLOUD_ORG` (Task 4), Stub-Namen aus Task 3.
- Produces: Bridge-Nachricht `cloud:org:update {org}`; Page-Callback `TMSBridge.setCloudOrg(org)`; `useCloudBridge` gibt zusätzlich `pushOrg` zurück.

- [ ] **Step 1: bridge.js** — Stub ersetzen + Setter + Migration (im Cloud-Block):

```js
  window.requestCloudOrgUpdate = function (org) { post('cloud:org:update', { org: org }); };
  window.TMSBridge.setCloudOrg = function (org) {
    window.TMS_DATA.cloudOrg = org;
    // One-time migration: favorites the old versions kept in page-localStorage.
    try {
      var raw = localStorage.getItem('tms-liquid-deck-cloud-favorites');
      if (raw) {
        var legacy = JSON.parse(raw);
        Object.keys(legacy).forEach(function (pid) { if (legacy[pid]) org.favorites[pid] = true; });
        localStorage.removeItem('tms-liquid-deck-cloud-favorites');
        window.requestCloudOrgUpdate(org);
      }
    } catch (e) {}
    if (typeof window.renderCloudFolderBar === 'function') window.renderCloudFolderBar();
    if (typeof window.renderCloudGroups === 'function') window.renderCloudGroups();
  };
```

Im bestehenden `TMSBridge.setCloud`: die `window.loadFavorites()`-Zeilen entfernen (Favoriten kommen jetzt aus cloudOrg), stattdessen `if (typeof window.renderCloudFolderBar === 'function') window.renderCloudFolderBar();` vor dem `renderCloudGroups`-Aufruf ergänzen (Zähler in den Chips aktualisieren). Mockup: `renderCloudFolderBar` und `renderCloudList` müssen `window.`-Exporte haben (in Task 2 sicherstellen: `window.renderCloudFolderBar = renderCloudFolderBar;`).

- [ ] **Step 2: build-season2-html.js Boot-Reset** (neben `cloudAccounts`):

```js
window.TMS_DATA.cloudOrg = { folders: [], assignments: {}, favorites: {}, startFolderId: null, defaultFilters: { provider: 'all', status: 'all' } };
```

- [ ] **Step 3: useCloudBridge** — `pushOrg` ergänzen:

```ts
import { useCloudOrgStore } from '../../store/cloudOrgStore';
// …
  const pushOrg = useCallback(() => {
    call('setCloudOrg', useCloudOrgStore.getState().org);
  }, [call]);
// return um pushOrg erweitern
```

- [ ] **Step 4: SeasonTwoWebRoot** — Import `useCloudOrgStore`; Destrukturierung um `pushOrg: pushCloudOrg` erweitern; im Switch:

```ts
      case 'cloud:org:update':
        useCloudOrgStore.getState().setOrg(payload.org);
        break;
```

`nav:screen === 'cloud'`: `pushCloudOrg();` VOR `pushCloudAccounts(); loadCloud();`. Dependency-Array von `onMessage` um `pushCloudOrg` erweitern.

- [ ] **Step 5:** `npm run build:season2 && npx tsc --noEmit` → sauber; Headless-Smoke am gebauten HTML (initScript-Stub): `setCloudOrg` mit Ordnern → Leiste rendert; Verschieben postet `cloud:org:update`; localStorage-Migration postet einmalig.
- [ ] **Step 6:** Commit `feat(season2): Cloud-Ordner real — setCloudOrg/cloud:org:update + Favoriten-Migration`

---

### Task 6: Ship

- [ ] **Step 1:** Remote prüfen (`git fetch` + Tags `v1.107.*`/`v1.108.*` — parallele Jobs!), rebase falls nötig (liquidDeckHtml-Konflikt = neu generieren).
- [ ] **Step 2:** Version bumpen (nächste freie, vermutlich v1.108.0 — Minor, neues Feature), `npx tsc --noEmit`, committen, taggen, pushen.
- [ ] **Step 3:** CI-Run beobachten, Release-Asset prüfen, User-Testcheckliste: Start-Ordner greift beim Öffnen, Standardfilter greifen, Ordner erstellen/zuweisen/löschen, Favoriten + Migration, App-Neustart → alles noch da.
