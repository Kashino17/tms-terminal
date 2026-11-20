import os, sys
os.chdir(sys.argv[1])
p = 'liquid-deck/index.html'; s = open(p).read()
def rep(a, b):
    global s
    assert a in s, a[:90]
    s = s.replace(a, b, 1)

# Rechte Spalte (aufgeklappt): nach Gerät gruppiert, jede Gruppe mit Kopf in Gerätefarbe
rep("""    rail.innerHTML = '';
    state.order.forEach((id, i) => {
      const session = TMS_DATA.sessions.find(s => s.id === id);""",
"""    rail.innerHTML = '';
    const DEVC = (sid) => ['#9b8cff', '#3bc9db', '#f59f00'][Math.max(0, TMS_DATA.servers.findIndex(x => x.id === sid)) % 3];
    let lastDev = null;
    state.order.forEach((id, i) => {
      const session = TMS_DATA.sessions.find(s => s.id === id);
      const sid = session.server || (TMS_DATA.servers[0] && TMS_DATA.servers[0].id);
      if (sid !== lastDev) {
        lastDev = sid;
        const srv = TMS_DATA.servers.find(x => x.id === sid) || {};
        const curSid = (TMS_DATA.sessions.find(x => x.id === state.order[state.activeIndex]) || {}).server;
        const n = state.order.filter(x => (TMS_DATA.sessions.find(y => y.id === x) || {}).server === sid).length;
        const ico = /win/i.test(srv.os || '') ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>';
        const head = document.createElement('div');
        head.className = 'rail-dev' + (sid === curSid ? ' is-current' : '') + (srv.status === 'online' ? '' : ' is-off');
        head.style.setProperty('--dc', DEVC(sid));
        head.innerHTML = `${ico}<span class="rail-dev__name">${escapeHtml(srv.name || '')}</span><span class="rail-dev__meta">${srv.status === 'online' ? (srv.latency != null ? srv.latency + ' ms' : '') : 'offline'}</span><span class="rail-dev__n">${n}</span>`;
        rail.appendChild(head);
      }""")
rep("""      item.className = 'rail-item glass' + (isActive ? ' is-active' : '');
      item.dataset.id = id; item.dataset.index = i;""",
"""      item.className = 'rail-item glass' + (isActive ? ' is-active' : '');
      item.style.setProperty('--dc', DEVC(sid));
      item.dataset.id = id; item.dataset.index = i;""")

rep("\n</head>", """
<style>
  /* ===== Bund v4: aufgeklappt ===== */
  @media (min-width: 700px) {
    /* Die rechte Spalte IST die Navigation — die Punkte-Leiste darunter entfällt
       (sie lag bisher über der Spalte). */
    body:not(.compact-terminal) #termSwitcher { display: none !important; }
    .rail { padding-top: 2px; }
    .rail-dev { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; margin: 4px 0 8px;
      border-radius: 999px; color: var(--dc); font: 800 11px var(--font-ui); letter-spacing: .06em;
      background: color-mix(in srgb, var(--dc) 9%, rgba(var(--overlay-rgb), .03));
      border: 1px solid color-mix(in srgb, var(--dc) 22%, transparent); }
    .rail-dev + .rail-item { margin-top: 0; }
    .rail-item + .rail-dev { margin-top: 18px; }
    .rail-dev svg { width: 15px; height: 15px; flex: none; }
    .rail-dev__name { flex: 1; text-transform: uppercase; }
    .rail-dev__meta { font: 600 11px var(--font-mono); color: var(--text-dim); letter-spacing: 0; }
    .rail-dev__n { min-width: 20px; height: 20px; border-radius: 999px; display: grid; place-items: center;
      font: 700 10.5px var(--font-ui); color: var(--text); background: rgba(var(--overlay-rgb), .10); }
    .rail-dev.is-current { background: color-mix(in srgb, var(--dc) 17%, rgba(var(--overlay-rgb), .04)); border-color: color-mix(in srgb, var(--dc) 48%, transparent); }
    .rail-dev.is-off { opacity: .45; }
    .rail-item { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--dc) 70%, transparent); }
    .rail-item.is-active { border-color: color-mix(in srgb, var(--dc) 55%, transparent); background: color-mix(in srgb, var(--dc) 9%, transparent); }
  }
</style>
</head>""")
open(p, 'w').write(s)
print('ok v4')

# Kompakte Kopfzeile (geteilter Bildschirm / Tastatur offen): Gerät vorne dran
p = 'liquid-deck/compact-terminal.js'; s = open(p).read()
dev = "(window.__devShort ? window.__devShort((TMS_DATA.servers || []).find(x => x.id === session.server)) : '')"
a = "header.querySelector('small').textContent = session ? [folderLabel(session.cwd || ''),"
assert a in s
s = s.replace(a, "header.querySelector('small').textContent = session ? [" + dev + ", folderLabel(session.cwd || ''),", 1)
a = "status.textContent = [folderLabel(session.cwd || ''),"
assert a in s
s = s.replace(a, "status.textContent = [" + dev + ", folderLabel(session.cwd || ''),", 1)
open(p, 'w').write(s)
print('ok compact')
