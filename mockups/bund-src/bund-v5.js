/* Bund v5 — Desk-Ansicht, Datei-Explorer, Zwischenablage, Snippets, Bilder.
   Läuft nach dem Hauptskript; nutzt dessen globale Helfer (state, TMS_DATA,
   toast, escapeHtml, setActive). */
(function () {
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const say = (m) => (typeof toast === 'function' ? toast(m) : console.log(m));
  const $ = (s, r = document) => r.querySelector(s);
  /** In der App läuft die Seite in einem ReactNativeWebView — dann echte Daten. */
  const LIVE = () => !!window.ReactNativeWebView;
  const post = (type, payload) => { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload: payload || {} })); } catch (_) {} };

  // ── Icons ────────────────────────────────────────────────────────────
  const P = {
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    select: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m8 12 3 3 5-6"/>',
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
    terminal: '<path d="m5 8 4 4-4 4M12 16h7"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
    insert: '<path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/>',
    share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4M12 2v13"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    pin: '<path d="M12 17v5M5 17h14l-2-5V5H7v7z"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
    mac: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    win: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    remote: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    grid: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    snippet: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
    sideCollapse: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M16 10l-2 2 2 2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
    // Dateitypen
    fFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" fill-opacity=".22"/>',
    fImg: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    fVid: '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
    fPdf: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><path d="M9 14h6M9 17h4"/>',
    fMd: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 15V9l3 3 3-3v6M16 9v6M14 13l2 2 2-2"/>',
    fCode: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/>',
    fZip: '<path d="M6 2h12v20H6z"/><path d="M12 2v2M12 6v2M12 10v2M10 14h4v4h-4z"/>',
    fTxt: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5M9 12h6M9 15h6M9 18h4"/>',
  };
  const ic = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[n] || ''}</svg>`;

  // ── Geräte ───────────────────────────────────────────────────────────
  const servers = () => (window.TMS_DATA && TMS_DATA.servers) || [];
  const devColor = (sid) => ['#9b8cff', '#3bc9db', '#f59f00'][Math.max(0, servers().findIndex((s) => s.id === sid)) % 3];
  const devIcon = (srv) => (srv && /win/i.test(srv.os || srv.name || '') ? 'win' : 'mac');
  const devShort = (srv) => (srv ? (/win/i.test(srv.os || '') ? 'WIN' : 'MAC') : '');
  const activeSess = () => (typeof state !== 'undefined' ? TMS_DATA.sessions.find((x) => x.id === state.order[state.activeIndex]) : null);
  // Gerät vorne: das des Terminals vorne, sonst das, was die App meldet
  // (TMSBridge.setActiveDevice — z. B. erstes Gerät online), zuletzt das erste.
  const activeSrv = () => { const s = activeSess(); return servers().find((x) => x.id === (s && s.server)) || servers().find((x) => x.id === window.__bundActiveDev) || servers()[0]; };
  const hasDictation = (srv) => (srv.caps || []).some((c) => c === 'dictation' || c === 'Diktat');
  const devChip = (srv) => srv ? `<span class="fp-chip" style="--dc:${devColor(srv.id)}">${ic(devIcon(srv), 2)}${devShort(srv)}</span>` : '';
  const STATUS = { running: 'LÄUFT', waiting: 'FRAGE', idle: 'BEREIT', done: 'FERTIG' };

  function insertText(text) {
    if (LIVE() && typeof window.__tmsInsert === 'function') { window.__tmsInsert(text, 'Eingefügt'); return; }
    const inp = document.getElementById('dockInput');
    if (inp) { inp.value = (inp.value ? inp.value + ' ' : '') + text; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    const s = activeSess();
    say(`In „${s ? s.name : 'Terminal'}“ eingefügt`);
  }

  // ════════════════════════════════════════════════════════════════════
  // 1) DESK — aufgeklappt: Seitenleiste nach Gerät + ein Terminal
  // ════════════════════════════════════════════════════════════════════
  const side = document.createElement('aside');
  side.id = 'deskSide';
  document.body.appendChild(side);

  function renderDesk() {
    if (!document.body.classList.contains('desk')) return;
    const act = activeSess();
    let html = `<div class="ds-top"><span class="ds-top__title ds-label">Terminals</span>
      <button class="ds-btn" data-ds="remote" title="Fernzugriff">${ic('remote')}</button>
      <button class="ds-btn" data-ds="bund" title="Bund">${ic('grid')}</button>
      <button class="ds-btn ds-toggle" data-ds="toggle" title="Leiste ein-/ausfahren">${ic('sideCollapse')}</button></div><div class="ds-scroll">`;
    servers().forEach((srv) => {
      const online = srv.status === 'online';
      const list = state.order.map((id, i) => ({ s: TMS_DATA.sessions.find((x) => x.id === id), i })).filter((o) => o.s && o.s.server === srv.id);
      html += `<div class="ds-dev${online ? '' : ' is-off'}" style="--dc:${devColor(srv.id)}">${ic(devIcon(srv), 2)}<span class="ds-dev__name">${esc(srv.name)}</span>
        <span class="ds-dev__ms">${online ? (srv.latency != null ? srv.latency + ' ms' : '') : 'offline'}</span>
        <button class="ds-dev__add" data-add="${srv.id}" title="Neues Terminal auf ${esc(srv.name)}">${ic('plus', 2.2)}</button></div>`;
      list.forEach(({ s, i }) => {
        const letter = esc((s.name.trim()[0] || '?').toUpperCase());
        html += `<button class="ds-row${act && act.id === s.id ? ' is-active' : ''}${online ? '' : ' is-off'}" data-i="${i}" style="--dc:${devColor(srv.id)}">
          <span class="ds-tag" data-st="${s.status}" style="background:${s.colorTag}" title="${esc(s.name)}">${letter}</span>
          <span class="ds-row__mid ds-label"><span class="ds-row__name">${esc(s.name)}</span><span class="ds-row__cwd">${esc(s.cwd || '')}</span></span>
          <span class="ds-st ${s.status}">${STATUS[s.status] || ''}</span></button>`;
      });
    });
    const mac = servers().find(hasDictation);
    const dictOn = mac && mac.status === 'online';
    html += `</div><div class="ds-foot${dictOn ? '' : ' is-off'}" title="${dictOn ? 'Diktat bereit' : 'Diktat aus'}"><i></i><span class="ds-label">${dictOn ? 'Diktat bereit · ' + esc(mac.name) : 'Diktat aus · MacBook offline'}</span></div>`;
    side.innerHTML = html;
  }
  side.addEventListener('click', (e) => {
    const row = e.target.closest('.ds-row');
    if (row) { const i = +row.dataset.i; if (typeof setActive === 'function') setActive(i); setTimeout(renderDesk, 30); return; }
    const add = e.target.closest('[data-add]');
    if (add) {
      if (typeof window.addTerminal === 'function') {
        window.__newTermServer = add.dataset.add;
        try { window.addTerminal(); } finally { window.__newTermServer = null; }
        setTimeout(renderDesk, 60);
      } else say(`Neues Terminal auf ${esc((servers().find((x) => x.id === add.dataset.add) || {}).name || '')}`);
      return;
    }
    const b = e.target.closest('[data-ds]');
    if (!b) return;
    if (b.dataset.ds === 'toggle') {
      const mini = !document.body.classList.contains('side-mini');
      document.body.classList.toggle('side-mini', mini);
      try { localStorage.setItem('tms-bund-side-mini', mini ? '1' : '0'); } catch (_) {}
      return;
    }
    if (b.dataset.ds === 'bund' && typeof show === 'function') show('servers');
    if (b.dataset.ds === 'remote' && document.getElementById('remoteIslandBtn')) document.getElementById('remoteIslandBtn').click();
  });
  // Desk-Status folgt der kompakten Ansicht (siehe compact-terminal.js) — und jedem Wechsel.
  /** Desk (Seitenleiste + ein Terminal) nur aufgeklappt: breit UND die volle
   *  Fensterhöhe (Grundhöhe je Breite) ist hoch. Die Tastatur ändert nur die
   *  aktuelle Höhe — die Leiste bleibt; geteilter Bildschirm ist von Anfang an
   *  niedrig — dort gibt es keine Leiste. */
  function deskWanted(width, baseHeight) { return width >= 700 && baseHeight > 600; }
  window.__bundDeskWanted = deskWanted;
  try { if (localStorage.getItem('tms-bund-side-mini') === '1') document.body.classList.add('side-mini'); } catch (_) {}
  const baseH = {};
  const mo = new MutationObserver(() => {
    const w = window.innerWidth;
    baseH[w] = Math.max(baseH[w] || 0, window.innerHeight);
    const wide = deskWanted(w, baseH[w]);
    const on = document.body.classList.contains('compact-terminal') && wide;
    if (document.body.classList.contains('desk') !== on) { document.body.classList.toggle('desk', on); }
    if (on) renderDesk();
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => { document.body.classList.toggle('desk-probe'); });
  const prevSync = window.multiSync;
  window.multiSync = function () { if (prevSync) prevSync.apply(this, arguments); renderDesk(); if (fx.open) fxDeviceCheck(); };
  let deskT = 0;
  window.__deskRender = function () {
    if (deskT || !document.body.classList.contains('desk')) return;
    deskT = setTimeout(() => { deskT = 0; renderDesk(); }, 200);
  };

  // ── Karten mit Griff ────────────────────────────────────────────────
  // Öffnen auf der zuletzt gewählten Höhe (Start: gut die Hälfte) — Suche und
  // Knöpfe liegen so im Daumenbereich. Griff ziehen = Größe, ganz hoch =
  // Vollbild, weit runter = schließen, Tipp = halb ↔ voll.
  let sheetR = 0.58;
  try { const v = parseFloat(localStorage.getItem('tms-bund-sheet-h')); if (v > 0.3 && v < 0.9) sheetR = v; } catch (_) {}
  const flatScrim = document.createElement('div'); flatScrim.className = 'flat-scrim'; document.body.appendChild(flatScrim);
  const sheets = [];
  function setSheetH(panel, r) { panel.classList.toggle('is-full', r >= 1); panel.style.height = r >= 1 ? '100%' : Math.round(r * window.innerHeight) + 'px'; }
  function sheetify(panel, close) {
    const g = document.createElement('div'); g.className = 'fp-grab'; g.innerHTML = '<i></i>'; panel.prepend(g);
    let d = null;
    g.addEventListener('pointerdown', (e) => { g.setPointerCapture(e.pointerId); d = { y: e.clientY, h: panel.getBoundingClientRect().height }; panel.classList.add('is-dragging'); });
    g.addEventListener('pointermove', (e) => {
      if (!d) return; const vh = window.innerHeight;
      const h = Math.max(90, Math.min(vh, d.h + (d.y - e.clientY)));
      panel.style.height = h + 'px'; panel.classList.toggle('is-full', h >= vh - 4);
    });
    const end = (e) => {
      if (!d) return; const moved = Math.abs(e.clientY - d.y); d = null; panel.classList.remove('is-dragging');
      const r = panel.getBoundingClientRect().height / window.innerHeight;
      if (moved < 6) return setSheetH(panel, panel.classList.contains('is-full') ? sheetR : 1);
      if (r < 0.3) return close();
      if (r > 0.86) return setSheetH(panel, 1);
      sheetR = r; try { localStorage.setItem('tms-bund-sheet-h', String(r)); } catch (_) {}
      setSheetH(panel, r);
    };
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    sheets.push({ panel, close });
  }
  function showSheet(panel) {
    setSheetH(panel, sheetR); panel.hidden = false; flatScrim.classList.add('is-on');
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('is-open')));
  }
  function hideSheet(panel) {
    panel.classList.remove('is-open');
    if (!sheets.some((x) => x.panel !== panel && x.panel.classList.contains('is-open'))) flatScrim.classList.remove('is-on');
    setTimeout(() => { if (!panel.classList.contains('is-open')) panel.hidden = true; }, 400);
  }
  flatScrim.addEventListener('click', () => sheets.forEach((x) => { if (x.panel.classList.contains('is-open')) x.close(); }));

  // ════════════════════════════════════════════════════════════════════
  // 2) DATEI-EXPLORER
  // ════════════════════════════════════════════════════════════════════
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  const TREE = {
    'srv-mac': { home: '/Users/ayysir', start: '/Users/ayysir/Desktop', sep: '/', dirs: {
      '/Users/ayysir': [['Desktop', 'd'], ['Documents', 'd'], ['Downloads', 'd'], ['Developer', 'd'], ['Pictures', 'd']],
      '/Users/ayysir/Desktop': [['TMS Terminal', 'd'], ['Kunden', 'd'], ['Screenshots', 'd'], ['Rechnung-Oktober.pdf', 'f', 312 * KB, 2], ['Moodboard.png', 'f', 4.2 * MB, 1],
        ['demo-call.mp4', 'f', 1.2 * GB, 0], ['README.md', 'f', 6 * KB, 0], ['export-kunden.zip', 'f', 88 * MB, 6], ['server.ts', 'f', 14 * KB, 3], ['notizen.txt', 'f', 2 * KB, 9]],
      '/Users/ayysir/Desktop/TMS Terminal': [['.claude', 'd'], ['docs', 'd'], ['memory', 'd'], ['mobile', 'd'], ['server', 'd'], ['shared', 'd'], ['CLAUDE.md', 'f', 4 * KB, 0], ['package.json', 'f', 1 * KB, 1]],
    } },
    'srv-win': { home: 'C:\\Users\\ayysir', start: 'C:\\Users\\ayysir\\Desktop', sep: '\\', dirs: {
      'C:\\Users\\ayysir': [['Desktop', 'd'], ['Documents', 'd'], ['Downloads', 'd'], ['Pictures', 'd']],
      'C:\\Users\\ayysir\\Desktop': [['Projects', 'd'], ['Spiele', 'd'], ['arena-trailer.mp4', 'f', 640 * MB, 1], ['Steuer-2025.pdf', 'f', 1.4 * MB, 12], ['Logo.svg', 'f', 18 * KB, 4], ['TODO.md', 'f', 3 * KB, 0]],
    } },
  };
  const KIND = (n) => {
    const e = (n.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(e)) return ['fImg', '#ec4899', 'img'];
    if (['mp4', 'mov', 'webm', 'mkv'].includes(e)) return ['fVid', '#a855f7', 'vid'];
    if (e === 'pdf') return ['fPdf', '#ef4444', 'pdf'];
    if (['md', 'mdx'].includes(e)) return ['fMd', '#8b5cf6', 'md'];
    if (['ts', 'tsx', 'js', 'json', 'py', 'sh', 'css', 'html'].includes(e)) return ['fCode', '#3b82f6', 'code'];
    if (['zip', 'gz', 'tar'].includes(e)) return ['fZip', '#f59e0b', 'zip'];
    return ['fTxt', '#94a3b8', 'txt'];
  };
  const fmtSize = (b) => b >= GB ? (b / GB).toFixed(1) + ' GB' : b >= MB ? (b / MB).toFixed(1) + ' MB' : Math.max(1, Math.round(b / KB)) + ' KB';
  const fmtAge = (d) => d === 0 ? 'Heute' : d === 1 ? 'Gestern' : `vor ${d} Tagen`;

  const fx = { open: false, dev: null, cwd: {}, q: '', sort: 'name', selecting: false, sel: new Set(), pressT: 0 };
  const panel = document.createElement('div');
  panel.className = 'flat-panel fx2'; panel.hidden = true;
  panel.innerHTML = `
    <div class="fp-head">
      <button class="fp-icon" data-fx="close" aria-label="Schließen">${ic('x', 2)}</button>
      <div class="fp-title"><span class="fx2-title">Dateien</span><span class="fx2-dev"></span></div>
      <button class="fp-icon" data-fx="mkdir" aria-label="Neuer Ordner">${ic('folderPlus')}</button>
      <button class="fp-icon" data-fx="select" aria-label="Auswählen">${ic('select')}</button>
    </div>
    <div class="fx2-path">
      <button class="fp-icon" data-fx="up" aria-label="Aufwärts">${ic('up', 2)}</button>
      <div class="fx2-crumbs"></div>
      <button class="fx2-cd" data-fx="cd">${ic('terminal', 2)}cd hier</button>
    </div>
    <label class="fx2-search">${ic('search')}<input type="search" placeholder="In diesem Ordner suchen…"></label>
    <div class="fx2-meta"><span class="fx2-count"></span><button class="fx2-sort" data-fx="sort">${ic('sort', 2)}<span>Name</span></button></div>
    <div class="fx2-list"></div>
    <div class="fx2-bulk">
      <button data-bulk="insert">${ic('insert')}Pfade einfügen</button>
      <button data-bulk="download">${ic('download')}Herunterladen</button>
      <button data-bulk="share">${ic('share')}Teilen</button>
      <button data-bulk="trash" class="danger">${ic('trash')}Papierkorb</button>
    </div>`;
  document.body.appendChild(panel);
  sheetify(panel, () => fxClose());
  const scrim = document.createElement('div'); scrim.className = 'fx2-scrim'; document.body.appendChild(scrim);
  const menu = document.createElement('div'); menu.className = 'fx2-menu'; document.body.appendChild(menu);
  const confirmEl = document.createElement('div'); confirmEl.className = 'fx2-confirm'; document.body.appendChild(confirmEl);
  const pv = document.createElement('div'); pv.className = 'pv'; document.body.appendChild(pv);

  const tree = () => TREE[fx.dev] || TREE['srv-mac'];
  const sepOf = (p) => (/^[A-Za-z]:/.test(p) || (p.includes('\\') && !p.includes('/')) ? '\\' : '/');
  const join = (a, b) => a.replace(/[\\/]+$/, '') + sepOf(a) + b;
  const parent = (p) => {
    const sp = sepOf(p), t = p.replace(/[\\/]+$/, ''), i = t.lastIndexOf(sp);
    if (i < 0) return p;
    if (i === 0) return sp;
    const head = t.slice(0, i);
    return /^[A-Za-z]:$/.test(head) ? head + sp : head;
  };
  const cacheKey = (dev, path) => dev + '\n' + path;
  /** Echte Ordnerliste anfordern (Antwort kommt über window.fsSetDir). */
  function fxLoad(path) {
    fx.loading = true;
    if (typeof window.fsListDir === 'function') window.fsListDir(path); else post('files:listRaw', { path });
  }
  function goDir(path) {
    fx.cwd[fx.dev] = path; fx.q = ''; panel.querySelector('.fx2-search input').value = '';
    if (LIVE()) fxLoad(path);
    fxRender(); list.scrollTop = 0;
  }
  function entries(path) {
    if (LIVE()) return fx.cache[cacheKey(fx.dev, path)] || null;
    const t = tree();
    if (t.dirs[path]) return t.dirs[path];
    // Unbekannter Ordner: plausible Füllung, damit man überall hinein kann
    const base = path.split(t.sep).pop();
    return [['src', 'd'], ['assets', 'd'], [`${base.toLowerCase().replace(/\s+/g, '-')}-notes.md`, 'f', 5 * KB, 2], ['cover.png', 'f', 2.1 * MB, 4], ['index.ts', 'f', 9 * KB, 1]];
  }
  function fxOpen() {
    fx.pinDev = null;
    fx.dev = activeSrv().id;
    // startet auf dem Schreibtisch, merkt sich den Ort pro Gerät
    if (!fx.cwd[fx.dev]) fx.cwd[fx.dev] = LIVE() ? '~/Desktop' : tree().start;
    if (LIVE()) fxLoad(fx.cwd[fx.dev]);
    fx.q = ''; panel.querySelector('.fx2-search input').value = '';
    fxSelect(false);
    showSheet(panel);
    fx.open = true; fxRender();
  }
  function fxClose() { fx.open = false; fx.pinDev = null; hideSheet(panel); }
  /** Fernzugriff → „Vom Gerät holen“: Explorer auf DIESEM Gerät an DIESEM Ordner.
   *  Die App stellt das Gerät um und listet selbst (files:openOn). */
  window.__bundOpenFilesOn = function (id, path) {
    fx.pinDev = id; fx.dev = id; fx.cwd[id] = path || '~'; fx.loading = true;
    fx.q = ''; panel.querySelector('.fx2-search input').value = '';
    fxSelect(false); showSheet(panel); fx.open = true; fxRender();
  };
  function fxDeviceCheck() {
    if (fx.pinDev) return; // aus dem Fernzugriff: bleibt auf genau diesem Gerät
    const d = activeSrv().id;
    if (d === fx.dev) return;
    // Gerätewechsel: gemerkten Ordner + letzte Liste SOFORT zeigen, frisch nachladen.
    fx.dev = d;
    if (!fx.cwd[d]) fx.cwd[d] = LIVE() ? '~/Desktop' : tree().start;
    fxSelect(false); fxRender();
    if (LIVE()) fxLoad(fx.cwd[d]);
  }
  fx.cache = {}; fx.retry = 0;
  /** Antwort der App: Liste eines Ordners (srvId = Gerät, das sie geliefert hat). */
  window.fsSetDir = function (path, entriesIn, srvId) {
    if (srvId && fx.dev && srvId !== fx.dev) {
      // Noch die Liste des vorigen Geräts — kurz warten, neu anfragen.
      if (++fx.retry <= 3) setTimeout(() => fxLoad(fx.cwd[fx.dev]), 200);
      return;
    }
    fx.retry = 0;
    const now = Date.now();
    fx.cache[cacheKey(fx.dev, path)] = (entriesIn || []).map((e) => [e.name, e.isDir ? 'd' : 'f', e.size || 0,
      e.modified ? Math.max(0, Math.floor((now - e.modified) / 864e5)) : 0]);
    fx.cwd[fx.dev] = path; fx.loading = false;
    if (fx.open) fxRender();
  };
  window.fsResetDir = function () { if (fx.open && LIVE()) fxLoad(fx.cwd[fx.dev]); };
  function fxSelect(on) { fx.selecting = on; fx.sel.clear(); panel.classList.toggle('is-selecting', on); panel.querySelector('[data-fx="select"]').classList.toggle('is-on', on); }

  function fxRender() {
    const srv = servers().find((x) => x.id === fx.dev);
    const s = activeSess();
    panel.querySelector('.fx2-dev').innerHTML = devChip(srv);
    panel.querySelector('.fx2-title').textContent = fx.selecting ? (fx.sel.size ? `${fx.sel.size} ausgewählt` : 'Auswählen') : 'Dateien';
    const cwd = fx.cwd[fx.dev];
    // Brotkrumen: jeder Teil des Pfads antippbar (Mac / und Windows C:\)
    const sp = sepOf(cwd), segs = cwd.split(/[\\/]+/).filter(Boolean);
    let acc = '', crumbs = '', shown = 0;
    // iCloud Drive (…/Library/Mobile Documents/com~apple~CloudDocs) als EIN Krümel.
    const cloudAt = segs.indexOf('com~apple~CloudDocs');
    const cloud = cloudAt >= 2 && segs[cloudAt - 1] === 'Mobile Documents' && segs[cloudAt - 2] === 'Library';
    segs.forEach((seg, i) => {
      acc = i === 0 ? (cwd.startsWith('/') ? '/' + seg : (seg === '~' ? '~' : seg + sp)) : acc.replace(/[\\/]+$/, '') + sp + seg;
      if (cloud && i < cloudAt) return;
      const label = cloud && i === cloudAt ? '☁ iCloud Drive' : seg;
      crumbs += `${shown++ ? '<span class="fx2-sep">›</span>' : ''}<button class="fx2-crumb" data-path="${esc(acc)}">${esc(label)}</button>`;
    });
    const cr = panel.querySelector('.fx2-crumbs'); cr.innerHTML = crumbs; cr.scrollLeft = 99999;
    panel.querySelector('.fx2-cd').title = `cd in „${s ? s.name : ''}“`;
    const raw = entries(cwd);
    let list = (raw || []).slice();
    if (fx.q) list = list.filter((e) => e[0].toLowerCase().includes(fx.q.toLowerCase()));
    const dirs = list.filter((e) => e[1] === 'd'), files = list.filter((e) => e[1] === 'f');
    const by = { name: (a, b) => a[0].localeCompare(b[0], 'de'), size: (a, b) => (b[2] || 0) - (a[2] || 0), date: (a, b) => (a[3] || 0) - (b[3] || 0) }[fx.sort];
    dirs.sort(by === by ? (a, b) => a[0].localeCompare(b[0], 'de') : by); files.sort(by);
    const all = dirs.concat(files);
    panel.querySelector('.fx2-count').textContent = `${dirs.length} Ordner · ${files.length} Dateien`;
    panel.querySelector('.fx2-sort span').textContent = { name: 'Name', size: 'Größe', date: 'Datum' }[fx.sort];
    panel.querySelector('.fx2-list').innerHTML = all.length ? all.map((e) => {
      const p = join(cwd, e[0]);
      const isDir = e[1] === 'd';
      const k = isDir ? ['fFolder', 'var(--accent)'] : KIND(e[0]);
      const meta = isDir ? 'Ordner' : `${fmtSize(e[2])} · ${fmtAge(e[3])}`;
      return `<div class="fx2-row${fx.sel.has(p) ? ' is-sel' : ''}" data-p="${esc(p)}" data-dir="${isDir ? 1 : 0}" data-n="${esc(e[0])}" data-meta="${esc(meta)}">
        <span class="fx2-check"></span>
        <span class="ft" style="--c:${k[1]}">${ic(k[0])}</span>
        <span class="fx2-name"><b>${esc(e[0])}</b><small>${meta}</small></span>
        ${isDir && !fx.selecting ? `<svg class="fx2-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${P.chev}</svg>` : ''}</div>`;
    }).join('') : `<div class="fx2-empty">${raw === null ? 'Lädt …' : fx.q ? 'Nichts gefunden.' : 'Dieser Ordner ist leer.'}</div>`;
    panel.querySelectorAll('.fx2-bulk button').forEach((b) => { b.disabled = !fx.sel.size; });
  }

  // Tippen / langes Drücken
  const list = panel.querySelector('.fx2-list');
  let press = null;
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.fx2-row'); if (!row) return;
    row.classList.add('is-pressed');
    press = { row, x: e.clientX, y: e.clientY, long: false, t: setTimeout(() => { press.long = true; row.classList.remove('is-pressed'); if (navigator.vibrate) navigator.vibrate(12); fxMenu(row); }, 450) };
  });
  const endPress = () => { if (press) { clearTimeout(press.t); press.row.classList.remove('is-pressed'); } };
  list.addEventListener('pointermove', (e) => { if (press && (Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8)) { endPress(); press = null; } });
  list.addEventListener('pointercancel', () => { endPress(); press = null; });
  list.addEventListener('pointerup', () => {
    if (!press) return; endPress(); const { row, long } = press; press = null; if (long) return;
    const p = row.dataset.p;
    if (fx.selecting) { fx.sel.has(p) ? fx.sel.delete(p) : fx.sel.add(p); fxRender(); return; }
    if (row.dataset.dir === '1') goDir(p);
    else preview(row.dataset.n, p, row.dataset.meta);
  });
  panel.querySelector('.fx2-search input').addEventListener('input', (e) => { fx.q = e.target.value; fxRender(); });
  panel.addEventListener('click', (e) => {
    const c = e.target.closest('.fx2-crumb'); if (c) { goDir(c.dataset.path); return; }
    const b = e.target.closest('[data-fx]'); if (b) {
      const a = b.dataset.fx;
      if (a === 'close') fxClose();
      if (a === 'up') goDir(parent(fx.cwd[fx.dev]));
      if (a === 'cd') { const s = activeSess(); fxClose(); act('cd', { path: fx.cwd[fx.dev] }, `cd ${fx.cwd[fx.dev]} → ${s ? s.name : ''}`); }
      if (a === 'select') { fxSelect(!fx.selecting); fxRender(); }
      if (a === 'sort') { fx.sort = { name: 'date', date: 'size', size: 'name' }[fx.sort]; fxRender(); }
      if (a === 'mkdir') askName('Neuer Ordner', '', (name) => act('mkdir', { path: join(fx.cwd[fx.dev], name) }, 'Ordner angelegt'));
      return;
    }
    const bk = e.target.closest('[data-bulk]'); if (bk && !bk.disabled) {
      const paths = [...fx.sel];
      if (bk.dataset.bulk === 'trash') return askTrash(paths);
      if (bk.dataset.bulk === 'insert') { insertText(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')); fxSelect(false); fxClose(); }
      if (bk.dataset.bulk === 'download') { act('download', { paths, zip: paths.length > 1 }, paths.length > 1 ? `${paths.length} Dateien als ZIP → Downloads` : 'Download gestartet'); fxSelect(false); fxRender(); }
      if (bk.dataset.bulk === 'share') act('share', { path: paths[0] }, 'Teilen-Menü öffnet sich');
    }
  });

  /** Datei-Aktion: in der App echt (fsAction der Bridge), im Mockup nur Hinweis. */
  function act(name, payload, demoMsg) {
    if (LIVE() && typeof window.fsAction === 'function') { window.fsAction(name, payload); return; }
    if (demoMsg) say(demoMsg);
  }
  /** Kleiner Eingabe-Dialog (neuer Ordner, Umbenennen) — ohne window.prompt. */
  function askName(title, initial, done) {
    confirmEl.innerHTML = `<h3>${esc(title)}</h3><input class="fx2-name-in" value="${esc(initial)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="btns" style="margin-top:14px"><button data-c="no">Abbrechen</button><button class="ok" data-c="yes">OK</button></div>`;
    const inp = confirmEl.querySelector('input');
    confirmEl.onclick = (e) => {
      const b = e.target.closest('[data-c]'); if (!b) return;
      const v = inp.value.trim(); closeOverlays();
      if (b.dataset.c === 'yes' && v && v !== initial) done(v);
    };
    menu.classList.remove('is-on'); scrim.classList.add('is-on'); confirmEl.classList.add('is-on');
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  }
  function closeOverlays() { scrim.classList.remove('is-on'); menu.classList.remove('is-on'); confirmEl.classList.remove('is-on'); }
  scrim.addEventListener('click', closeOverlays);
  function fxMenu(row) {
    const isDir = row.dataset.dir === '1', p = row.dataset.p, n = row.dataset.n;
    const k = isDir ? ['fFolder', 'var(--accent)'] : KIND(n);
    const items = isDir
      ? [['open', 'chev', 'Öffnen'], ['cdto', 'terminal', 'cd in diesen Ordner'], ['insert', 'insert', 'Pfad einfügen'], ['copy', 'copy', 'Pfad kopieren'], ['select', 'select', 'Auswählen'], ['rename', 'rename', 'Umbenennen'], ['trash', 'trash', 'In den Papierkorb', 1]]
      : [['preview', 'eye', 'Vorschau'], ['insert', 'insert', 'Pfad einfügen'], ['copy', 'copy', 'Pfad kopieren'], ['share', 'share', 'Teilen'], ['download', 'download', 'Herunterladen'], ['select', 'select', 'Auswählen'], ['rename', 'rename', 'Umbenennen'], ['trash', 'trash', 'In den Papierkorb', 1]];
    menu.innerHTML = `<div class="fx2-menu__head"><span class="ft" style="--c:${k[1]}">${ic(k[0])}</span><div><b>${esc(n)}</b><small>${esc(row.dataset.meta)}</small></div></div>` +
      items.map(([a, i, l, d]) => `<button class="mi${d ? ' danger' : ''}" data-mi="${a}">${ic(i)}${l}</button>`).join('');
    menu.onclick = (e) => {
      const b = e.target.closest('[data-mi]'); if (!b) return; closeOverlays();
      const a = b.dataset.mi;
      if (a === 'open') goDir(p);
      if (a === 'cdto') { const s = activeSess(); fxClose(); act('cd', { path: p }, `cd ${p} → ${s ? s.name : ''}`); }
      if (a === 'preview') preview(n, p, row.dataset.meta);
      if (a === 'insert') { insertText(/\s/.test(p) ? `"${p}"` : p); fxClose(); }
      if (a === 'copy') act('copyPath', { paths: [p] }, 'Pfad kopiert');
      if (a === 'share') act('share', { path: p }, 'Teilen-Menü öffnet sich');
      if (a === 'download') act('download', { paths: [p], zip: false }, `${n} → Downloads`);
      if (a === 'select') { fxSelect(true); fx.sel.add(p); fxRender(); }
      if (a === 'rename') askName('Umbenennen', n, (name) => act('rename', { path: p, name }, 'Umbenannt'));
      if (a === 'trash') askTrash([p]);
    };
    scrim.classList.add('is-on'); menu.classList.add('is-on');
  }
  function askTrash(paths) {
    const n = paths.length, srv = servers().find((x) => x.id === fx.dev);
    const name = (p) => p.split(/[\\/]/).pop();
    confirmEl.innerHTML = `<div class="ic-wrap">${ic('trash')}</div>
      <h3>${n === 1 ? `„${esc(name(paths[0]))}“ in den Papierkorb?` : `${n} Elemente in den Papierkorb?`}</h3>
      <p>Sie landen im Papierkorb von ${esc(srv ? srv.name : 'diesem Gerät')} und lassen sich dort wiederherstellen.</p>
      ${n > 1 ? `<div class="list">${paths.slice(0, 50).map((p) => esc(name(p))).join('<br>')}${n > 50 ? `<br>… und ${n - 50} weitere` : ''}</div>` : ''}
      <div class="btns"><button data-c="no">Abbrechen</button><button class="danger" data-c="yes">In den Papierkorb</button></div>`;
    confirmEl.onclick = (e) => {
      const b = e.target.closest('[data-c]'); if (!b) return; closeOverlays();
      if (b.dataset.c === 'yes' && LIVE()) { act('trash', { paths }); fxSelect(false); fxRender(); return; }
      if (b.dataset.c === 'yes') {
        const t = tree(); const dir = t.dirs[fx.cwd[fx.dev]];
        if (dir) t.dirs[fx.cwd[fx.dev]] = dir.filter((e2) => !paths.includes(join(fx.cwd[fx.dev], e2[0])));
        say(n === 1 ? 'In den Papierkorb gelegt' : `${n} Elemente in den Papierkorb gelegt`);
        fxSelect(false); fxRender();
      }
    };
    menu.classList.remove('is-on'); scrim.classList.add('is-on'); confirmEl.classList.add('is-on');
  }

  /** Bild/Video/PDF: Inhalt holt die App (die Seite darf nicht ins Tailnet laden).
   *  Bilder erscheinen hier, Video/PDF öffnen im Android-Betrachter. */
  function previewViaApp(n, p, kind) {
    pv.dataset.want = p;
    const box = () => (pv.dataset.want === p && pv.classList.contains('is-on') ? pv.querySelector('.pv-body') : null);
    const status = (t, again) => {
      const b = box(); if (!b) return;
      b.innerHTML = `<div class="fx2-empty">${esc(t)}${again ? '<br><br><button class="pv-again" data-pv-again>Nochmal öffnen</button>' : ''}</div>`;
      const btn = b.querySelector('[data-pv-again]');
      if (btn) btn.addEventListener('click', () => { status('Lädt …'); previewViaApp(n, p, kind); });
    };
    window.fsLoadPreview(p, kind, (d) => {
      if (d.progress) return status(`Lädt … ${d.pct} %`);
      if (d.error) return status(d.error, true);
      if (d.opened) return status(kind === 'pdf' ? 'PDF im Betrachter geöffnet.' : kind === 'vid' ? 'Video im Player geöffnet.' : 'Im Betrachter geöffnet.', true);
      const b = box(); if (!b) return;
      b.innerHTML = `<img class="pv-real" src="${esc(d.src || '')}" alt="">`;
      b.querySelector('img').addEventListener('error', () => status(/\.heic$/i.test(n) ? 'HEIC kann die Vorschau nicht zeigen — laden oder teilen.' : 'Bild lässt sich nicht anzeigen.'));
    });
    return '<div class="fx2-empty">Lädt …</div>';
  }
  function previewLive(n, p, meta, kind) {
    if ((kind === 'img' || kind === 'vid' || kind === 'pdf') && typeof window.fsLoadPreview === 'function') return previewViaApp(n, p, kind);
    const url = typeof window.fsFileUrl === 'function' ? window.fsFileUrl(p) : '';
    let body = '';
    if (kind === 'img') body = `<img class="pv-real" src="${esc(url)}" alt="">`;
    else if (kind === 'vid') body = `<video class="pv-real" src="${esc(url)}" controls playsinline preload="metadata"></video>`;
    else if (kind === 'pdf') body = `<iframe class="pv-frame" src="${esc(typeof window.fsPdfUrl === 'function' ? window.fsPdfUrl(p) : url)}"></iframe>`;
    else if (kind === 'zip') body = '<div class="fx2-empty">Keine Vorschau für Archive — laden oder teilen.</div>';
    else { body = '<div class="fx2-empty">Lädt …</div>'; pv.dataset.want = p; if (typeof window.fsReadFile === 'function') window.fsReadFile(p); }
    return body;
  }
  /** Antwort der App auf fsReadFile: Text/Markdown/Code anzeigen. */
  window.fsSetFileContent = function (path, content, error, truncated) {
    if (pv.dataset.want !== path || !pv.classList.contains('is-on')) return;
    const box = pv.querySelector('.pv-body');
    if (error) { box.innerHTML = `<div class="fx2-empty">${esc(error)}</div>`; return; }
    const kind = KIND(path.split(/[\\/]/).pop())[2];
    const note = truncated ? '<div class="pv-pages">Gekürzt — nur der Anfang (512 KB)</div>' : '';
    if (kind === 'md') box.innerHTML = `<div class="pv-doc"><div class="pv-md">${mdToHtml(content)}</div>${note}</div>`;
    else box.innerHTML = `<div class="pv-doc"><div class="pv-code">${String(content).split('\n').slice(0, 5000).map((l, i) => `<div><span class="n">${i + 1}</span>${esc(l)}</div>`).join('')}</div>${note}</div>`;
  };
  /** Kleines Markdown (Überschriften, Code, Listen, fett, inline-Code). */
  function mdToHtml(md) {
    const out = []; let code = null;
    for (const line of String(md).split('\n')) {
      if (/^```/.test(line)) { if (code) { out.push(`<pre>${esc(code.join('\n'))}</pre>`); code = null; } else code = []; continue; }
      if (code) { code.push(line); continue; }
      const inl = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      const h = line.match(/^(#{1,3})\s+(.*)/);
      if (h) out.push(`<h${h[1].length === 1 ? 1 : 2}>${inl(h[2])}</h${h[1].length === 1 ? 1 : 2}>`);
      else if (/^\s*[-*]\s+/.test(line)) out.push(`<ul><li>${inl(line.replace(/^\s*[-*]\s+/, ''))}</li></ul>`);
      else if (line.trim()) out.push(`<p>${inl(line)}</p>`);
    }
    if (code) out.push(`<pre>${esc(code.join('\n'))}</pre>`);
    return out.join('');
  }
  function preview(n, p, meta) {
    const kind = KIND(n)[2];
    let body = '';
    if (LIVE()) body = previewLive(n, p, meta, kind);
    else if (kind === 'img') body = '<div class="pv-img"></div>';
    else if (kind === 'vid') body = `<div class="pv-video"><span class="play">${ic('play')}</span><div class="scrub">4:12<i></i>13:05</div></div>`;
    else if (kind === 'pdf') body = `<div class="pv-doc">${[1, 2].map((i) => `<div class="pv-page"><h4>${i === 1 ? esc(n.replace(/\.pdf$/, '')) : 'Seite 2'}</h4>${'<div class="ln"></div>'.repeat(14)}</div>`).join('')}<div class="pv-pages">Seite 1 von 3</div></div>`;
    else if (kind === 'md') body = `<div class="pv-doc"><div class="pv-md"><h1>${esc(n.replace(/\.md$/, ''))}</h1><p>Projekt-Notizen für den <b>Bund</b> aus MacBook und Windows.</p><h2>Start</h2><pre>npm install\nnpm run dev</pre><h2>Offen</h2><ul><li>Ping ehrlich messen</li><li>Explorer startet auf dem <code>Desktop</code></li></ul></div></div>`;
    else body = `<div class="pv-doc"><div class="pv-code">${['import { createServer } from "http";', '', 'const port = Number(process.env.PORT ?? 8767);', '', 'createServer((req, res) => {', '  res.writeHead(200, { "content-type": "text/plain" });', '  res.end("ok");', '}).listen(port);'].map((l, i) => `<div><span class="n">${i + 1}</span>${esc(l)}</div>`).join('')}</div></div>`;
    pv.innerHTML = `<div class="pv-head"><button class="fp-icon" data-pv="close">${ic('x', 2)}</button><div class="pv-title"><b>${esc(n)}</b><small>${esc(meta || '')}</small></div>
      <button class="fp-icon" data-pv="more">${ic('more')}</button></div>
      <div class="pv-body">${body}</div>
      <div class="pv-bar"><button data-pv="insert">${ic('insert')}Pfad einfügen</button><button data-pv="share">${ic('share')}Teilen</button><button data-pv="download">${ic('download')}Laden</button></div>`;
    pv.onclick = (e) => {
      const b = e.target.closest('[data-pv]'); if (!b) return;
      const a = b.dataset.pv;
      if (a === 'close') { pv.classList.remove('is-on'); pv.querySelectorAll('video').forEach((v) => v.pause()); }
      if (a === 'insert') { pv.classList.remove('is-on'); insertText(/\s/.test(p) ? `"${p}"` : p); fxClose(); }
      if (a === 'share') act('share', { path: p }, 'Teilen-Menü öffnet sich');
      if (a === 'download') act('download', { paths: [p], zip: false }, `${n} → Downloads`);
      if (a === 'more') { pv.classList.remove('is-on'); const row = list.querySelector(`[data-p="${CSS.escape(p)}"]`); if (row) fxMenu(row); }
    };
    pv.classList.add('is-on');
  }

  // ════════════════════════════════════════════════════════════════════
  // 3) ZWISCHENABLAGE — auf dem Handy, nach Zeit geordnet
  // ════════════════════════════════════════════════════════════════════
  const now = Date.now(), H = 3600e3, D = 24 * H;
  const CLIP = [
    { t: 'npm run build && tms-terminal restart', src: 'srv-mac', at: now - 6 * 60e3, pin: true },
    { t: 'C:\\Users\\ayysir\\Desktop\\Projects\\arena', src: 'srv-win', at: now - 22 * 60e3 },
    { t: 'Kannst du den Ping in der Insel nochmal gegen echte Tailscale-Werte prüfen?', src: 'phone', at: now - 2 * H },
    { t: 'https://vercel.com/kashino17/pinterest-scraper/deployments', src: 'srv-mac', at: now - 5 * H },
    { t: 'git log --oneline -15', src: 'srv-mac', at: now - 26 * H },
    { t: 'Rechnungsnummer RE-2026-1104', src: 'phone', at: now - 30 * H, pin: true },
    { t: 'Get-Process | Sort-Object CPU -Descending | Select -First 10', src: 'srv-win', at: now - 3 * D },
    { t: 'postgres://tms@db.internal:5432/scraper', src: 'srv-mac', at: now - 5 * D },
    { t: 'Treffen mit Kunde Do 14 Uhr — Moodboard mitbringen', src: 'phone', at: now - 12 * D },
    { t: 'ssh root@100.64.0.31', src: 'srv-mac', at: now - 24 * D },
  ];
  if (LIVE()) CLIP.length = 0; // in der App: nur echte Einträge
  /** Liste vom Handy-Speicher (RN → TMSBridge.setClips). */
  window.__bundSetClips = function (l) {
    CLIP.length = 0;
    (l || []).forEach((c) => CLIP.push({ id: c.id, t: c.text, src: c.src, at: c.at, pin: !!c.pinned }));
    if (cb.open) cbRender();
  };
  const cb = { open: false, f: 'all', q: '', newest: true };
  const cbP = document.createElement('div');
  cbP.className = 'flat-panel cb2'; cbP.hidden = true;
  cbP.innerHTML = `
    <div class="fp-head">
      <button class="fp-icon" data-cb="close">${ic('x', 2)}</button>
      <div class="fp-title">Zwischenablage<span class="fp-chip plain">${ic('phone', 2)}auf dem Handy</span></div>
      <button class="fp-icon" data-cb="sort" title="Sortierung">${ic('sort')}</button>
    </div>
    <label class="fx2-search">${ic('search')}<input type="search" placeholder="Verlauf durchsuchen…"></label>
    <div class="cb2-filters"></div>
    <div class="cb2-list"></div>
    <div class="cb2-foot"><span class="cb2-n"></span><button data-cb="clear">Verlauf leeren</button></div>`;
  document.body.appendChild(cbP);
  sheetify(cbP, () => cbClose());
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const bucket = (at) => { const now = Date.now(); const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); return at >= +dayStart ? 'Heute' : at >= +dayStart - D ? 'Gestern' : at >= now - 7 * D ? 'Letzte 7 Tage' : at >= now - 30 * D ? 'Letzte 30 Tage' : 'Älter'; };
  const ago = (at) => { const m = Math.max(0, Math.round((Date.now() - at) / 60e3)); return m < 60 ? `vor ${m} Min` : m < 24 * 60 ? `vor ${Math.round(m / 60)} Std` : new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' }); };
  const srcInfo = (src) => src === 'phone' ? ['phone', 'Handy', '#94a3b8'] : [devIcon(servers().find((x) => x.id === src)), devShort(servers().find((x) => x.id === src)), devColor(src)];
  function cbFilters() {
    const fs = [['all', 'Alle'], ['pin', 'Angeheftet'], ['today', 'Heute'], ['yday', 'Gestern'], ['7', 'Letzte 7 Tage'], ['30', 'Letzte 30 Tage'], ['phone', 'Vom Handy']]
      .concat(servers().map((x) => [x.id, 'Vom ' + x.name]));
    if (!fs.some(([k]) => k === cb.f)) cb.f = 'all';
    cbP.querySelector('.cb2-filters').innerHTML = fs.map(([k, l]) => `<button class="cb2-f${k === cb.f ? ' is-on' : ''}" data-f="${esc(k)}">${esc(l)}</button>`).join('');
  }
  function cbRender() {
    cbFilters();
    let items = CLIP.slice();
    const f = cb.f;
    if (f === 'pin') items = items.filter((c) => c.pin);
    if (f === 'today') items = items.filter((c) => bucket(c.at) === 'Heute');
    if (f === 'yday') items = items.filter((c) => bucket(c.at) === 'Gestern');
    if (f === '7') items = items.filter((c) => c.at >= Date.now() - 7 * D);
    if (f === '30') items = items.filter((c) => c.at >= Date.now() - 30 * D);
    if (f === 'phone' || servers().some((x) => x.id === f)) items = items.filter((c) => c.src === f);
    if (cb.q) items = items.filter((c) => c.t.toLowerCase().includes(cb.q.toLowerCase()));
    items.sort((a, b) => cb.newest ? b.at - a.at : a.at - b.at);
    const pins = f === 'all' && !cb.q ? items.filter((c) => c.pin) : [];
    const rest = items.filter((c) => !pins.includes(c));
    const groups = [];
    if (pins.length) groups.push(['Angeheftet', pins]);
    rest.forEach((c) => { const b = bucket(c.at); const g = groups.find((x) => x[0] === b); g ? g[1].push(c) : groups.push([b, [c]]); });
    const isCmd = (t) => /^(npm|npx|git|ssh|cd|ls|tms-|Get-|postgres:|https?:|[A-Z]:\\|~\/|\/)/.test(t);
    cbP.querySelector('.cb2-list').innerHTML = groups.length ? groups.map(([g, arr]) => `<div class="cb2-sec"><span>${g}</span><span>${arr.length}</span></div>` + arr.map((c) => {
      const [i, l, col] = srcInfo(c.src);
      return `<div class="cb2-item" data-i="${CLIP.indexOf(c)}"><span class="cb2-src" style="--dc:${col}">${ic(i, 2)}</span>
        <div class="cb2-body"><div class="cb2-text${isCmd(c.t) ? ' mono' : ''}">${esc(c.t)}</div><div class="cb2-meta">${c.pin ? `<span class="pin">${ic('pin', 2).replace('<svg', '<svg width="11" height="11"')}</span>` : ''}${l} · ${ago(c.at)}</div></div>
        <button class="cb2-ins" data-ins="${CLIP.indexOf(c)}" title="Ins Terminal einfügen">${ic('insert', 2)}</button></div>`;
    }).join('')).join('') : '<div class="fx2-empty">Nichts gefunden.</div>';
    cbP.querySelector('.cb2-n').textContent = `${CLIP.length} Einträge · max. 200`;
  }
  cbP.addEventListener('click', (e) => {
    const fb = e.target.closest('[data-f]');
    if (fb) { cb.f = fb.dataset.f; cbRender(); return; }
    const ins = e.target.closest('[data-ins]');
    if (ins) { insertText(CLIP[+ins.dataset.ins].t); cbClose(); return; }
    const b = e.target.closest('[data-cb]'); if (!b) return;
    if (b.dataset.cb === 'close') cbClose();
    if (b.dataset.cb === 'sort') { cb.newest = !cb.newest; say(cb.newest ? 'Neueste zuerst' : 'Älteste zuerst'); cbRender(); }
    if (b.dataset.cb === 'clear') cbConfirmClear();
  });
  function cbConfirmClear() {
    const n = CLIP.filter((c) => !c.pin).length;
    if (!n) { say('Nur Angeheftete im Verlauf'); return; }
    confirmEl.innerHTML = `<div class="ic-wrap">${ic('trash')}</div>
      <h3>Verlauf leeren?</h3>
      <p>${n === 1 ? '1 Eintrag wird' : `${n} Einträge werden`} gelöscht. Angeheftete bleiben.</p>
      <div class="btns"><button data-c="no">Abbrechen</button><button class="danger" data-c="yes">Leeren</button></div>`;
    confirmEl.onclick = (e) => {
      const b = e.target.closest('[data-c]'); if (!b) return; closeOverlays();
      if (b.dataset.c !== 'yes') return;
      if (LIVE()) post('clipboard:clear');
      else { for (let i = CLIP.length - 1; i >= 0; i--) if (!CLIP[i].pin) CLIP.splice(i, 1); cbRender(); say('Verlauf geleert'); }
    };
    menu.classList.remove('is-on'); scrim.classList.add('is-on'); confirmEl.classList.add('is-on');
  }
  cbP.querySelector('input').addEventListener('input', (e) => { cb.q = e.target.value; cbRender(); });
  // Langes Drücken auf einen Eintrag: Menü
  let cbPress = null;
  cbP.addEventListener('pointerdown', (e) => {
    const it = e.target.closest('.cb2-item'); if (!it || e.target.closest('.cb2-ins')) return;
    cbPress = setTimeout(() => {
      const c = CLIP[+it.dataset.i];
      menu.innerHTML = `<div class="fx2-menu__head"><div><b style="font-weight:500">${esc(c.t.slice(0, 120))}</b><small>${srcInfo(c.src)[1]} · ${ago(c.at)}</small></div></div>
        <button class="mi" data-m="ins">${ic('insert')}Ins Terminal einfügen</button><button class="mi" data-m="copy">${ic('copy')}Aufs Gerät kopieren</button>
        <button class="mi" data-m="pin">${ic('pin')}${c.pin ? 'Lösen' : 'Anheften'}</button><button class="mi" data-m="snip">${ic('snippet')}Als Snippet speichern</button>
        <button class="mi danger" data-m="del">${ic('trash')}Löschen</button>`;
      menu.onclick = (ev) => {
        const m = ev.target.closest('[data-m]'); if (!m) return; closeOverlays();
        if (m.dataset.m === 'ins') { insertText(c.t); cbClose(); }
        if (m.dataset.m === 'copy') { if (LIVE()) post('clipboard:use', { id: c.id, text: c.t }); say(`Aufs Handy + ${devShort(activeSrv())} kopiert`); }
        if (m.dataset.m === 'pin') { if (LIVE()) post('clipboard:pin', { id: c.id }); else { c.pin = !c.pin; cbRender(); } }
        if (m.dataset.m === 'snip') { snAdd(c.t.slice(0, 24), c.t); say('Als Snippet gespeichert'); }
        if (m.dataset.m === 'del') { if (LIVE()) post('clipboard:delete', { id: c.id }); else { CLIP.splice(CLIP.indexOf(c), 1); cbRender(); } }
      };
      scrim.classList.add('is-on'); menu.classList.add('is-on');
    }, 450);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => cbP.addEventListener(t, () => clearTimeout(cbPress)));
  function cbOpen() { showSheet(cbP); cb.open = true; cbRender(); if (LIVE()) post('clipboard:open'); }
  function cbClose() { cb.open = false; hideSheet(cbP); }

  // ════════════════════════════════════════════════════════════════════
  // 4) SNIPPETS — leer, auf dem Handy, bleiben bei Updates
  // ════════════════════════════════════════════════════════════════════
  let SN = [];
  if (!LIVE()) { try { SN = JSON.parse(localStorage.getItem('tms-bund-snippets') || '[]'); } catch (_) { SN = []; } }
  const snSave = () => { if (LIVE()) return; try { localStorage.setItem('tms-bund-snippets', JSON.stringify(SN)); } catch (_) {} };
  /** In der App liegen Snippets im durableStorage — RN schickt sie per setTool. */
  window.__bundOnTool = function (key, data) {
    if (key !== 'snippets' || !Array.isArray(data)) return;
    SN = data.map((x) => ({ id: x.id, name: x.label || x.name || '', cmd: x.cmd || '' }));
    if (!snP.hidden) snRender();
  };
  function snAdd(name, cmd) {
    if (LIVE()) post('snippet:add', { name, cmd });
    else { SN.push({ name, cmd }); snSave(); }
  }
  const snP = document.createElement('div');
  snP.className = 'flat-panel sn2'; snP.hidden = true;
  document.body.appendChild(snP);
  sheetify(snP, () => snClose());
  const snBody = document.createElement('div'); snBody.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;'; snP.appendChild(snBody);
  let snForm = false, snEdit = null;
  function snRender() {
    const form = snForm ? `<div class="sn2-form"><label>Name<input id="snName" placeholder="z. B. Server neu starten"></label>
      <label>Befehl<textarea id="snCmd" placeholder="tms-terminal restart"></textarea></label>
      <div class="row"><button data-sn="cancel">Abbrechen</button><button class="ok" data-sn="save">Speichern</button></div></div>` : '';
    const body = SN.length
      ? `<div class="sn2-list">${SN.map((s, i) => `<div class="sn2-item"><div><b>${esc(s.name)}</b><code>${esc(s.cmd)}</code></div>
          <button class="cb2-ins" data-run="${i}" title="Einfügen">${ic('insert', 2)}</button></div>`).join('')}</div>`
      : (snForm ? '<div style="flex:1"></div>' : `<div class="sn2-empty"><span class="big">${ic('snippet')}</span><h3>Noch keine Snippets</h3>
          <p>Speichere Befehle, die du oft brauchst. Ein Tipp fügt sie ins Terminal ein, das gerade vorne ist.</p>
          <button class="sn2-primary" data-sn="new">${ic('plus', 2.2)}Erstes Snippet anlegen</button></div>`);
    snBody.innerHTML = `<div class="fp-head"><button class="fp-icon" data-sn="close">${ic('x', 2)}</button>
      <div class="fp-title">Snippets<span class="fp-chip plain">${ic('phone', 2)}auf dem Handy</span></div>
      <button class="fp-icon" data-sn="new" title="Neues Snippet">${ic('plus', 2)}</button></div>
      ${form}${body}<div class="sn2-note">${ic('lock', 2)}Gespeichert auf dem Handy — bleibt bei App-Updates erhalten.</div>`;
    if (snForm) setTimeout(() => { const n = document.getElementById('snName'); if (n) n.focus(); }, 50);
  }
  snP.addEventListener('click', (e) => {
    const run = e.target.closest('[data-run]'); if (run) { insertText(SN[+run.dataset.run].cmd); snClose(); return; }
    const b = e.target.closest('[data-sn]'); if (!b) return;
    const a = b.dataset.sn;
    if (a === 'close') snClose();
    if (a === 'new') { snForm = true; snRender(); }
    if (a === 'cancel') { snForm = false; snRender(); }
    if (a === 'save') {
      const n = document.getElementById('snName').value.trim(), c = document.getElementById('snCmd').value.trim();
      if (!c) return say('Befehl fehlt');
      if (snEdit && LIVE()) post('snippet:edit', { id: snEdit, name: n || c.slice(0, 24), cmd: c });
      else if (snEdit) { const it = SN.find((x) => x.id === snEdit); if (it) { it.name = n || c.slice(0, 24); it.cmd = c; } snSave(); }
      else snAdd(n || c.slice(0, 24), c);
      snEdit = null; snForm = false; snRender(); say('Snippet gespeichert');
    }
  });
  function snOpen() { snForm = false; snEdit = null; snRender(); showSheet(snP); if (LIVE()) post('tool:open', { tool: 'snippets' }); }
  // Langes Drücken auf ein Snippet: Bearbeiten / Löschen
  let snPress = null;
  snP.addEventListener('pointerdown', (e) => {
    const it = e.target.closest('.sn2-item'); if (!it || e.target.closest('[data-run]')) return;
    const i = +it.querySelector('[data-run]').dataset.run, sn = SN[i];
    snPress = setTimeout(() => {
      menu.innerHTML = `<div class="fx2-menu__head"><div><b>${esc(sn.name)}</b><small>${esc(sn.cmd.slice(0, 80))}</small></div></div>
        <button class="mi" data-m="edit">${ic('rename')}Bearbeiten</button><button class="mi danger" data-m="del">${ic('trash')}Löschen</button>`;
      menu.onclick = (ev) => {
        const m = ev.target.closest('[data-m]'); if (!m) return; closeOverlays();
        if (m.dataset.m === 'edit') {
          snEdit = sn.id || null; snForm = true; snRender();
          setTimeout(() => { document.getElementById('snName').value = sn.name; document.getElementById('snCmd').value = sn.cmd; }, 60);
        }
        if (m.dataset.m === 'del') { if (LIVE()) post('snippet:delete', { id: sn.id }); else { SN.splice(i, 1); snSave(); snRender(); } }
      };
      scrim.classList.add('is-on'); menu.classList.add('is-on');
    }, 450);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => snP.addEventListener(t, () => clearTimeout(snPress)));
  function snClose() { hideSheet(snP); }

  // ════════════════════════════════════════════════════════════════════
  // 5) BILDER — wie bisher: Galerie öffnet sich direkt, dann Upload
  // ════════════════════════════════════════════════════════════════════
  const up = document.createElement('div'); up.className = 'up2'; document.body.appendChild(up);
  /** Upload-Fortschritt von der App (RN → TMSBridge.uploadProgress). */
  window.__bundUpload = function (done, total, srvId) {
    const srv = servers().find((x) => x.id === srvId) || activeSrv();
    if (done >= total) { up.classList.remove('is-on'); return; }
    up.innerHTML = `${devChip(srv)}<span>${done}/${total} → ${esc(srv ? srv.name : '')}</span><i></i>`;
    up.querySelector('i').style.setProperty('--p', Math.round((done / Math.max(1, total)) * 100) + '%');
    up.classList.add('is-on');
  };
  function shots() {
    if (LIVE()) {
      // Wie bisher: Galerie öffnet sich direkt. Gerät + Karte stehen jetzt fest.
      post('shot:capture', { source: 'library', cardId: typeof window.__tmsActiveCardId === 'function' ? window.__tmsActiveCardId() : null });
      return;
    }
    const srv = activeSrv(), s = activeSess();
    say('Galerie öffnet sich …');
    setTimeout(() => {
      let p = 0;
      up.innerHTML = `${devChip(srv)}<span>2 Bilder → ${esc(srv.name)}</span><i></i>`;
      up.classList.add('is-on');
      const t = setInterval(() => {
        p += 20; up.querySelector('i').style.setProperty('--p', p + '%');
        if (p >= 100) { clearInterval(t); setTimeout(() => { up.classList.remove('is-on'); insertText(srv.id === 'srv-win' ? 'C:\\Users\\ayysir\\.tms\\shots\\IMG_2041.jpg C:\\Users\\ayysir\\.tms\\shots\\IMG_2042.jpg' : '~/.tms-terminal/shots/IMG_2041.jpg ~/.tms-terminal/shots/IMG_2042.jpg'); }, 300); }
      }, 160);
    }, 700);
  }

  // ── Einhängen: Werkzeug-Knöpfe gehen hierhin ─────────────────────────
  window.__bundTool = function (id) {
    if (id === 'files') { fxOpen(); return true; }
    if (id === 'clipboard') { cbOpen(); return true; }
    if (id === 'snippets') { snOpen(); return true; }
    // Bilder: bewusst die alte Karte (Kamera + Galerie, Fortschritt darin).
    return false;
  };
  window.openFilesScreen = function () { fxOpen(); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pv.classList.contains('is-on')) return pv.classList.remove('is-on');
    if (scrim.classList.contains('is-on')) return closeOverlays();
    if (fx.open) return fxClose();
    if (cb.open) return cbClose();
  });

  // ════════════════════════════════════════════════════════════════════
  // 7) OHNE INSEL — Neues Terminal + Fernzugriff stecken oben im ⋮-Menü
  //    jeder Karte, mit einem Knopf je Gerät (Nutzerwahl: Variante „Menü“).
  // ════════════════════════════════════════════════════════════════════
  document.body.classList.add('no-island');
  function closeCardMenuNow() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('.card-menu').forEach((m) => m.remove());
    document.querySelectorAll('.card-menu-btn[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  }
  /** Zweite Stufe: die Geräte untereinander (Name, Ping/offline, läuft). */
  function bmList(kind) {
    const alive = typeof window.__remoteAliveIds === 'function' ? window.__remoteAliveIds() : [];
    return servers().map((d) => {
      const on = d.status === 'online';
      const live = kind === 'remote' && alive.indexOf(d.id) >= 0;
      const meta = !on ? 'offline' : live ? '<i></i>läuft' : (d.latency != null ? d.latency + ' ms' : '');
      const row = `<button class="bm-dev${live ? ' is-alive' : ''}" data-bm="${kind}" data-srv="${esc(d.id)}" style="--dc:${devColor(d.id)}" ${on ? '' : 'disabled'}>
        <span class="bm-dev__ic">${ic(devIcon(d), 1.8)}</span><span class="bm-dev__name">${esc(d.name)}</span><small>${meta}</small></button>`;
      // Laufende Sitzung: daneben ✕ zum Beenden (mit Rückfrage), ohne hineinzugehen
      return live ? `<div class="bm-devwrap" data-bm-wrap="${esc(d.id)}">${row}<button class="bm-stop" data-bm-stop="${esc(d.id)}" aria-label="Fernzugriff auf ${esc(d.name)} beenden" title="Beenden">${ic('x', 2.2)}</button></div>` : row;
    }).join('') || '<div class="bm-empty">Kein Gerät verbunden</div>';
  }
  function bmAugment(menu) {
    if (menu.querySelector('.bm-sec')) return;
    // Läuft irgendwo ein Fernzugriff? Dann schimmert die Zeile (aufgeklappt: das Gerät).
    const live = typeof window.__remoteAliveIds === 'function' && window.__remoteAliveIds().length > 0;
    menu.insertAdjacentHTML('afterbegin', `<div class="bm-sec">
      <button class="bm-row" data-bm-open="term" aria-expanded="false"><i class="bm-ic">${ic('plus', 2)}</i><span>Neues Terminal</span>${ic('chev', 2)}</button>
      <div class="bm-list" data-bm-list="term" hidden>${bmList('term')}</div>
      <button class="bm-row${live ? ' is-live' : ''}" data-bm-open="remote" aria-expanded="false"><i class="bm-ic">${ic('remote', 1.8)}</i><span>Fernzugriff</span>${ic('chev', 2)}</button>
      <div class="bm-list" data-bm-list="remote" hidden>${bmList('remote')}</div></div>`);
    // Breiter geworden → wieder rechtsbündig am ⋮-Knopf ausrichten
    const btn = document.querySelector('.card-menu-btn[aria-expanded="true"]');
    if (btn) {
      const r = btn.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    }
  }
  // Erste Stufe: „Neues Terminal“ / „Fernzugriff“ klappt die Geräte darunter auf.
  document.addEventListener('click', (e) => {
    const o = e.target.closest && e.target.closest('.card-menu [data-bm-open]');
    if (!o) return;
    e.stopPropagation();
    const menu = o.closest('.card-menu');
    const k = o.dataset.bmOpen;
    const list = menu.querySelector(`[data-bm-list="${k}"]`);
    const open = list.hidden;
    menu.querySelectorAll('[data-bm-list]').forEach((l) => { l.hidden = true; });
    menu.querySelectorAll('[data-bm-open]').forEach((r) => r.setAttribute('aria-expanded', 'false'));
    if (open) { list.innerHTML = bmList(k); list.hidden = false; o.setAttribute('aria-expanded', 'true'); }
    // Unten kein Platz → Menü nach oben schieben
    const r = menu.getBoundingClientRect();
    const over = r.bottom - (window.innerHeight - 8);
    if (over > 0) menu.style.top = Math.max(8, r.top - over) + 'px';
  }, true);
  new MutationObserver((list) => {
    list.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.classList.contains('card-menu')) bmAugment(n); }));
  }).observe(document.body, { childList: true });
  // Laufenden Fernzugriff beenden: ✕ → Rückfrage → Beenden / Abbrechen
  document.addEventListener('click', (e) => {
    const stop = e.target.closest && e.target.closest('.card-menu [data-bm-stop]');
    const conf = e.target.closest && e.target.closest('.card-menu [data-bm-confirm]');
    if (!stop && !conf) return;
    e.stopPropagation();
    const menu = (stop || conf).closest('.card-menu');
    const list = menu.querySelector('[data-bm-list="remote"]');
    if (stop) {
      const id = stop.dataset.bmStop, d = servers().find((x) => x.id === id);
      list.innerHTML = `<div class="bm-confirm"><b>Fernzugriff auf ${esc(d ? d.name : 'dem Gerät')} beenden?</b>
        <small>Die Sitzung auf dem Rechner wird geschlossen.</small>
        <div class="bm-confirm__btns"><button data-bm-confirm="no">Abbrechen</button><button class="danger" data-bm-confirm="yes" data-srv="${esc(id)}">Beenden</button></div></div>`;
      return;
    }
    if (conf.dataset.bmConfirm === 'no') { list.innerHTML = bmList('remote'); return; }
    const id = conf.dataset.srv, d = servers().find((x) => x.id === id);
    closeCardMenuNow();
    if (typeof window.__closeRemoteDevice === 'function') window.__closeRemoteDevice(id);
    say(`Fernzugriff auf ${d ? d.name : 'dem Gerät'} beendet`);
  }, true);

  // Vom Fernzugriff zurück: der grüne Ring um ⋮ pulsiert EINMAL, danach Ruhe.
  let wasRemote = document.body.classList.contains('remote-focus'), pulseT = 0;
  new MutationObserver(() => {
    const now = document.body.classList.contains('remote-focus');
    if (wasRemote && !now && document.body.classList.contains('remote-alive')) {
      document.body.classList.remove('remote-pulse');
      void document.body.offsetWidth; // Animation neu starten
      document.body.classList.add('remote-pulse');
      clearTimeout(pulseT);
      pulseT = setTimeout(() => document.body.classList.remove('remote-pulse'), 2600);
    }
    wasRemote = now;
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.card-menu [data-bm]');
    if (!b) return;
    e.stopPropagation();
    const id = b.dataset.srv;
    closeCardMenuNow();
    if (b.dataset.bm === 'term') {
      window.__newTermServer = id;
      try { if (typeof window.addTerminal === 'function') window.addTerminal(); } finally { window.__newTermServer = null; }
    } else if (typeof window.__openRemoteFor === 'function') window.__openRemoteFor(id);
  }, true);

  // ════════════════════════════════════════════════════════════════════
  // 8) UPDATE — schlicht, in der App laden + installieren, ohne Neustart.
  //    Die App prüft regelmäßig und meldet den Stand (setUpdateState):
  //    none | available | downloading | ready | error.
  // ════════════════════════════════════════════════════════════════════
  const UP = { status: 'none', current: '', latest: '', notes: '', size: 0, received: 0, error: '' };
  const upBar = document.createElement('div'); upBar.id = 'updBar'; upBar.className = 'upd upd--bar'; upBar.hidden = true;
  document.body.appendChild(upBar);
  let upNotesOpen = false;
  const mb = (b) => { const v = b / 1048576; return (v >= 10 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + ' MB'; };
  const upDismissed = () => { try { return localStorage.getItem('tms-upd-dismissed') === UP.latest; } catch (_) { return false; } };
  function upHtml(withClose) {
    const pct = UP.size ? Math.min(100, Math.round((UP.received / UP.size) * 100)) : 0;
    const sub = UP.status === 'downloading' ? `Lädt … ${UP.size ? `${mb(UP.received)} von ${mb(UP.size)}` : ''}`
      : UP.status === 'ready' ? 'Geladen'
      : UP.status === 'error' ? esc(UP.error || 'Laden fehlgeschlagen')
      : `Neue Version${UP.size ? ' · ' + mb(UP.size) : ''}`;
    const act = UP.status === 'downloading' ? `<span class="upd-pct">${pct} %</span>`
      : UP.status === 'ready' ? '<button class="upd-btn" data-up="install">Installieren</button>'
      : UP.status === 'error' ? '<button class="upd-btn" data-up="download">Nochmal</button>'
      : '<button class="upd-btn" data-up="download">Laden</button>';
    const notes = (UP.notes || '').trim();
    return `<div class="upd-main">
        <span class="upd-ic">${ic('download', 2)}</span>
        <button class="upd-txt" data-up="notes" aria-expanded="${upNotesOpen}"><b>Update ${esc(UP.latest.replace(/^v/, ''))}</b><small>${sub}</small></button>
        ${act}${withClose ? `<button class="upd-x" data-up="dismiss" aria-label="Ausblenden">${ic('x', 2)}</button>` : ''}
      </div>
      ${UP.status === 'downloading' ? `<i class="upd-prog" style="--p:${pct}%"></i>` : ''}
      ${upNotesOpen && notes ? `<div class="upd-notes"><small>Was ist neu · aktuell ${esc(UP.current)}</small>${esc(notes)}</div>` : ''}`;
  }
  function upRender() {
    const has = UP.status !== 'none' && UP.latest;
    // Die schwebende Leiste: bis man sie wegtippt (Laden/Installieren zeigt sie wieder)
    const busy = UP.status === 'downloading' || UP.status === 'ready';
    upBar.hidden = !has || (upDismissed() && !busy);
    if (!upBar.hidden) upBar.innerHTML = upHtml(true);
    document.querySelectorAll('.upd--card').forEach((c) => { if (has) c.innerHTML = upHtml(false); else c.remove(); });
  }
  /** Bund-Seite: dieselbe Anzeige als ruhige Karte (statt der Glas-Pille). */
  window.__bundUpdateCard = function (host) {
    if (UP.status === 'none' || !UP.latest) return;
    const c = document.createElement('div'); c.className = 'upd upd--card'; c.innerHTML = upHtml(false);
    host.appendChild(c);
  };
  window.__bundUpdateState = function (st) {
    const prevLatest = UP.latest;
    Object.assign(UP, st || {});
    if (UP.latest !== prevLatest) upNotesOpen = false;
    upRender();
  };
  // Mockup: Demo-Update aus den Beispieldaten zeigen
  if (!LIVE() && window.TMS_DATA && TMS_DATA.update && TMS_DATA.update.latest && TMS_DATA.update.latest !== TMS_DATA.update.current) {
    const u = TMS_DATA.update;
    setTimeout(() => { window.__bundUpdateState({ status: 'available', current: u.current, latest: u.latest, notes: u.notes, size: 31 * 1048576 });
      if (typeof window.renderServers === 'function') window.renderServers(); }, 0);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.upd [data-up]');
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.up;
    if (a === 'notes') { upNotesOpen = !upNotesOpen; upRender(); return; }
    if (a === 'dismiss') { try { localStorage.setItem('tms-upd-dismissed', UP.latest); } catch (_) {} upRender(); return; }
    if (a === 'download') { Object.assign(UP, { status: 'downloading', received: 0, error: '' }); upRender(); }
    if (LIVE()) post('update:' + a);
    else if (a === 'download') {
      // Mockup: Download simulieren
      UP.size = UP.size || 31 * 1048576;
      const t = setInterval(() => { UP.received += UP.size / 12; if (UP.received >= UP.size) { clearInterval(t); UP.status = 'ready'; } upRender(); }, 250);
    } else if (a === 'install') say('Mockup: Android-Installer öffnet sich');
  }, true);
})();
