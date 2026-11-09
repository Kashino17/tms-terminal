import os, sys
os.chdir(sys.argv[1])

# ---------- data.js ----------
p = 'shared/data.js'; s = open(p).read()
old_servers = s[s.index("    servers: ["):s.index("    sessions: [")]
s = s.replace(old_servers, """    servers: [
      { id: 'srv-mac', name: 'MacBook', host: '100.64.0.12', port: 8767, status: 'online', sessions: 3, os: 'macOS 26', latency: 12, active: true, primary: true, caps: ['Diktat', 'Fingerabdruck'] },
      { id: 'srv-win', name: 'Windows PC', host: '100.64.0.40', port: 8767, status: 'online', sessions: 2, os: 'Windows 11', latency: 15, active: true, caps: [] },
    ],
""")
for t in ['t1', 't2', 't3']:
    s = s.replace("{ id: '%s', name:" % t, "{ id: '%s', server: 'srv-mac', name:" % t, 1)
i = s.index("{ id: 't4', name: 'Scratchpad'")
j = s.index("    ],", i)
s = s[:i] + r"""{ id: 't4', server: 'srv-win', name: 'Terminal 7', description: 'PowerShell', colorTag: '#9c36b5', status: 'idle', live: false, cwd: 'C:\\Users\\ayysir',
        buffer: ['\x1b[36mPS C:\\Users\\ayysir>\x1b[0m '],
        notes: [], todos: [] },
      { id: 't5', server: 'srv-win', name: 'Game Build', description: 'Vite-Build auf Windows', colorTag: '#c2255c', status: 'running', live: false, cwd: 'D:\\Projects\\arena',
        buffer: ['\x1b[36mPS D:\\Projects\\arena>\x1b[0m npm run build', '\x1b[2mvite v6 building for production…\x1b[0m', '\x1b[32m✓ 812 modules transformed.\x1b[0m'],
        notes: [], todos: [] },
""" + s[j:]
open(p, 'w').write(s)

# ---------- index.html ----------
p = 'liquid-deck/index.html'; s = open(p).read()
def rep(a, b):
    global s
    assert a in s, a[:80]
    s = s.replace(a, b, 1)

rep("\n</head>", """
<style>
  /* ===== Bund (Mockup) ===== */
  .dock-btn[data-nav="manager"] { display: none !important; }
  .bund-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .bund-card__head { display: flex; align-items: center; gap: 10px; padding: 0 2px; }
  .bund-card__head svg { width: 20px; height: 20px; color: var(--accent); flex: none; }
  .bund-card__name { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; flex: 1; }
  .bund-card__count { font-size: 12px; font-weight: 600; color: var(--text-dim); }
  .bund-devs { display: grid; grid-template-columns: 1fr; gap: 10px; }
  .bund-dev { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: var(--radius-md);
    background: rgba(var(--overlay-rgb), .05); border: 1px solid rgba(var(--overlay-rgb), .10);
    transition: transform 300ms var(--spring), opacity 300ms ease; cursor: pointer; }
  .bund-dev:active { transform: scale(.98); }
  .bund-dev .server-orb { color: var(--dc); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dc) 45%, transparent), 0 0 26px 4px color-mix(in srgb, var(--dc) 28%, transparent); }
  .bund-dev.is-off { opacity: .5; }
  .bund-dev.is-off .server-orb { color: var(--text-dim); box-shadow: none; }
  .bund-dev .server-chip.cap { color: var(--text); }
  .bund-add { height: 46px; border-radius: var(--radius-md); border: 1.5px dashed rgba(var(--overlay-rgb), .22);
    color: var(--text-dim); font: 600 13px var(--font-ui); background: none; }
  .bund-demo { display: block; margin: 18px auto 0; padding: 8px 14px; border-radius: 999px; font: 600 11.5px var(--font-ui);
    color: var(--warn); border: 1px dashed rgba(var(--warn-rgb), .5); background: rgba(var(--warn-rgb), .08); }
  @media (min-width: 700px) { .bund-devs { grid-template-columns: 1fr 1fr; } .bund-dev { flex-direction: column; align-items: flex-start; } .bund-dev .server-actions { width: 100%; } .bund-dev .server-action { width: 100%; } }
  body.mac-off #dockMicBtn { display: none !important; }
  body.mac-off .ts-group[data-srv="srv-mac"] { opacity: .35; pointer-events: none; }
  .sheet-dev { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; vertical-align: 2px;
    padding: 3px 9px 3px 7px; border-radius: 999px; font: 600 11px var(--font-ui); color: var(--text-dim);
    background: rgba(var(--overlay-rgb), .07); white-space: nowrap; }
  .sheet-dev .card-dev { margin-right: 0; }
  .shot-target { margin: 10px 2px 0; font-size: 12.5px; color: var(--text-dim); line-height: 1.45; }
  .shot-target b { color: var(--text); font-weight: 600; }
  .fx-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .fx-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-size: 11.5px; color: var(--text-dim); }
  .fx-search { width: 100%; padding: 9px 11px; margin-bottom: 8px; border-radius: 10px; background: rgba(var(--well-rgb),var(--well-a)); border: 1px solid var(--glass-border); color: var(--text); font: 13px var(--font-ui); }
</style>
</head>""")

rep('''    <span>Server</span>
  </button>''', '''    <span>Bund</span>
  </button>''')
rep("const DOCK_SWIPE_ORDER = ['servers', 'terminals', 'manager', 'cloud', 'browser'];",
    "const DOCK_SWIPE_ORDER = ['servers', 'terminals', 'cloud', 'browser'];")

a = s.index("  function renderServers() {"); b = s.index("  // ============================================================\n  // Fernzugriff", a)
s = s[:a] + r"""  function renderServers() {
    const host = document.querySelector('[data-screen="servers"]');
    host.innerHTML = '';
    renderUpdateBanner(host);
    const titleRow = document.createElement('div');
    titleRow.className = 'screen-title-row';
    titleRow.innerHTML = `<h1 class="screen-title">Bund</h1><button class="icon-btn glass" id="settingsBtn" aria-label="Einstellungen öffnen">${icon('gear')}</button>`;
    host.appendChild(titleRow);
    titleRow.querySelector('#settingsBtn').addEventListener('click', () => show('settings'));
    const devs = TMS_DATA.servers;
    const on = devs.filter(d => d.status === 'online').length;
    const card = document.createElement('div');
    card.className = 'glass bund-card';
    card.innerHTML = `
      <div class="bund-card__head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
        <span class="bund-card__name">Mein Bund</span>
        <span class="bund-card__count">${on} von ${devs.length} online</span>
      </div>
      <div class="bund-devs">${devs.map(d => {
        const online = d.status === 'online';
        const n = TMS_DATA.sessions.filter(x => (x.server || devs[0].id) === d.id).length;
        const col = ['#9b8cff', '#3bc9db', '#f59f00'][devs.indexOf(d) % 3];
        const devIco = /win/i.test(d.os) ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>';
        return `<div class="bund-dev${online ? '' : ' is-off'}" data-dev="${d.id}" style="--dc:${col}">
          <div class="server-orb">${devIco}</div>
          <div class="server-info">
            <div class="server-name">${escapeHtml(d.name)}</div>
            <div class="server-meta">
              <span class="server-chip ${online ? 'ok' : ''}">${online ? '● ' + d.latency + ' ms' : '○ offline'}</span>
              <span class="server-chip">${n} Terminals</span>
              <span class="server-chip">${escapeHtml(d.os)}</span>
              ${(d.caps || []).map(c => `<span class="server-chip cap">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
          <div class="server-actions"><button class="server-action" data-remote="${d.id}" ${online ? '' : 'disabled'}>Fernzugriff</button></div>
        </div>`;
      }).join('')}</div>
      <button class="bund-add">+ Gerät zum Bund hinzufügen</button>`;
    host.appendChild(card);
    card.querySelectorAll('.bund-dev').forEach(row => row.addEventListener('click', (e) => {
      const d = devs.find(x => x.id === row.dataset.dev);
      if (d.status !== 'online') { toast(`${d.name} ist offline`); return; }
      if (e.target.closest('[data-remote]')) {
        e.stopPropagation();
        if (window.__openRemoteFor) { window.__openRemoteFor(d.id); return; }
        show('remote'); if (window.TMSRemote) window.TMSRemote.start('auto');
        return;
      }
      // Tipp aufs Gerät: zu seinem ersten Terminal
      const i = state.order.findIndex(id => { const s2 = TMS_DATA.sessions.find(x => x.id === id); return s2 && s2.server === d.id; });
      goToTerminals();
      if (i >= 0) setTimeout(() => { const b = document.querySelector(`.ts-seg[data-ts="${i}"]`); if (b) b.click(); }, 380);
    }));
    card.querySelector('.bund-add').addEventListener('click', () => toast('Mockup: Gerät hinzufügen'));
    const demo = document.createElement('button');
    demo.className = 'bund-demo';
    const mac = devs.find(x => x.id === 'srv-mac');
    demo.textContent = mac.status === 'online' ? 'Demo: MacBook ausschalten' : 'Demo: MacBook wieder einschalten';
    demo.addEventListener('click', () => {
      const off = mac.status === 'online';
      mac.status = off ? 'offline' : 'online'; mac.active = !off;
      document.body.classList.toggle('mac-off', off);
      toast(off ? 'MacBook offline — Diktat ausgeblendet' : 'MacBook wieder da — Diktat ist zurück');
      renderServers();
    });
    host.appendChild(demo);
  }

""" + s[b:]

rep("  function openToolSheet(id) {", r"""  // Bund: Werkzeuge, die zu einem Gerät gehören, folgen dem Terminal vorne.
  const DEVICE_TOOLS = ['files', 'screenshots', 'ports', 'processes', 'watchers', 'sql'];
  function activeSess() { const id = state.order[state.activeIndex]; return TMS_DATA.sessions.find(x => x.id === id); }
  function sheetDevChip(id) {
    if (!DEVICE_TOOLS.includes(id)) return id === 'notes' || id === 'clipboard' ? '<span class="sheet-dev">auf dem Handy</span>' : '';
    const s = activeSess(); const sid = (s && s.server) || 'srv-mac';
    const srv = TMS_DATA.servers.find(x => x.id === sid);
    const col = window.__devColor ? window.__devColor(sid) : 'var(--accent)';
    return `<span class="sheet-dev"><span class="card-dev" style="--dc:${col}"><i></i>${window.__devShort ? window.__devShort(srv) : 'MAC'}</span>${escapeHtml(s ? s.name : '')}</span>`;
  }
  window.__refreshOpenTool = function () {
    const wrap = document.getElementById('toolSheetWrap');
    if (!window.__openTool || !wrap || !wrap.classList.contains('is-open')) return;
    const builders = { files: buildFilesSheet, screenshots: buildScreenshotsSheet };
    const b = builders[window.__openTool]; if (!b) return;
    const { html, wire } = b();
    document.getElementById('toolSheetTitle').innerHTML = escapeHtml(TOOL_DEFS.find(t => t.id === window.__openTool).label) + sheetDevChip(window.__openTool);
    document.getElementById('toolSheetBody').innerHTML = html; if (wire) wire();
  };
  function openToolSheet(id) {""")
rep("""    document.getElementById('toolSheetTitle').textContent = def.label;""",
    """    document.getElementById('toolSheetTitle').innerHTML = escapeHtml(def.label) + sheetDevChip(id);
    window.__openTool = id;""")

a = s.index("  function buildFilesSheet() {"); b = s.index("  function buildSqlSheet() {")
s = s[:a] + r"""  const FILES_BY_DEV = {
    'srv-mac': { cwd: '/Users/ayysir/Desktop/TMS Terminal', list: ['.claude/', '.git/', '.github/', 'docs/', 'memory/', 'mobile/', 'mockups/', 'server/', 'shared/', 'CLAUDE.md|4 KB', 'package.json|1 KB'] },
    'srv-win': { cwd: 'C:\\Users\\ayysir', list: ['Desktop/', 'Documents/', 'Downloads/', 'Pictures/', '.ssh/', 'projects.txt|2 KB'] },
  };
  function buildFilesSheet() {
    const s = activeSess(); const f = FILES_BY_DEV[(s && s.server) || 'srv-mac'];
    const rows = f.list.map(x => { const [n, sz] = x.split('|'); const dir = n.endsWith('/');
      return `<div class="fx-row"><button class="tool-row is-tap"><span class="tool-row__icon">${dir ? '▸' : '·'}</span><span class="tool-row__name">${escapeHtml(n)}</span><span class="tool-row__meta">${dir ? 'öffnen' : sz}</span></button></div>`; }).join('');
    const html = `<style>#toolSheetBody .fx-row + .fx-row { margin-top: 6px; } #toolSheetBody .fx-row .tool-row { border-top: none; background: rgba(var(--overlay-rgb), .04); border-radius: 12px; padding: 11px 12px; width: 100%; }</style>
      <div class="fx-head">
        <button class="btn-chip">▴ Aufwärts</button>
        <span class="fx-path mono-text">${escapeHtml(f.cwd)}</span>
        <button class="btn-chip" data-fx="cdhere">cd hier</button>
        <button class="btn-chip">+ Ordner</button>
        <button class="btn-chip" data-fx-fullscreen>⛶</button>
      </div>
      <input class="term-input fx-search" placeholder="Filtern…">
      <div class="tool-list">${rows}</div>`;
    return { html, wire() {
      const btn = document.querySelector('#toolSheetBody [data-fx-fullscreen]');
      if (btn) btn.addEventListener('click', () => { closeSheet(document.getElementById('toolSheetWrap')); window.openFilesScreen(); });
      const cd = document.querySelector('#toolSheetBody [data-fx="cdhere"]');
      if (cd) cd.addEventListener('click', () => { closeSheet(document.getElementById('toolSheetWrap')); toast(`cd ${f.cwd} → ${s.name}`); });
    } };
  }

""" + s[b:]

rep("""      <button class="btn-chip" id="shotCaptureBtn" style="width:100%;">Aufnehmen</button>`;""",
    """      <button class="btn-chip" id="shotCaptureBtn" style="width:100%;">Aufnehmen</button>
      <div class="shot-target">${(() => { const s = activeSess(); const srv = TMS_DATA.servers.find(x => x.id === ((s && s.server) || 'srv-mac'));
        return `Bild landet auf <b>${escapeHtml(srv.name)}</b>, der Pfad kommt in <b>${escapeHtml(s ? s.name : '')}</b> — auch wenn du zwischendurch wechselst.`; })()}</div>`;""")
rep("""        toast('Screenshot aufgenommen');""",
    """        { const s = activeSess(); toast(`Bild → ${(s && s.server) === 'srv-win' ? 'WIN' : 'MAC'} · Pfad in „${s ? s.name : ''}“`); }""")

rep("""      if (typeof updateLatencyDisplay === 'function') updateLatencyDisplay();""",
    """      if (typeof updateLatencyDisplay === 'function') updateLatencyDisplay();
      if (typeof window.__refreshOpenTool === 'function') window.__refreshOpenTool();""")
open(p, 'w').write(s)
print('ok')
