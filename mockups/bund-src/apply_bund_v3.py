import os, sys
os.chdir(sys.argv[1])

p = 'shared/data.js'; s = open(p).read()
a = s.index("    snippets: [")
# find matching closing "    ]," after it
b = s.index("\n    ],", a) + len("\n    ],")
s = s[:a] + "    snippets: [],  // startet leer — eigene Snippets liegen auf dem Handy" + s[b:]
s = s.replace("caps: ['Diktat', 'Fingerabdruck']", "caps: ['Diktat']")
open(p, 'w').write(s)

p = 'liquid-deck/index.html'; s = open(p).read()
def rep(a, b):
    global s
    assert a in s, a[:90]
    s = s.replace(a, b, 1)

# --- Shortcut-Leiste: Touch ID + "Alle Werkzeuge" raus, alles direkt in der (scrollbaren) Leiste
rep("""            <button class="tt-key tt-key--icon" data-tt-key="touchid" aria-label="Passwort per Fingerabdruck" title="Passwort per Fingerabdruck (sudo)">🔓</button>
""", "")
rep("""            <button class="tt-key tt-key--icon" data-tt-key="werkzeuge" aria-label="Alle Werkzeuge" title="Alle Werkzeuge">${icon('tools', 17)}</button>""",
    """            <button class="tt-key tt-key--icon" data-tt-tool="snippets" aria-label="Snippets" title="Snippets">${icon('snippet', 17)}</button>
            <button class="tt-key tt-key--icon" data-tt-tool="ports" aria-label="Ports" title="Ports">${icon('ports', 17)}</button>
            <button class="tt-key tt-key--icon" data-tt-tool="processes" aria-label="Prozesse" title="Prozesse">${icon('processes', 17)}</button>""")

# --- SQL + Watcher weg
rep("    { id: 'sql', code: 'DB', icon: 'db', label: 'SQL' },\n", "")
rep("    { id: 'watchers', code: 'WA', icon: 'eye', label: 'Watchers' },\n", "")

# --- Punkte-Leiste: jedes Gerät als eigene Kapsel in seiner Farbe
rep("""      return `<div class="ts-group${g.sid === curSrv ? ' is-current' : ''}" data-srv="${escapeHtml(g.sid || '')}">${label}${g.items.join('')}</div>`;""",
    """      return `<div class="ts-group${g.sid === curSrv ? ' is-current' : ''}${showDev ? ' has-dev' : ''}" data-srv="${escapeHtml(g.sid || '')}" style="--dc:${col}">${g.items.join('')}</div>`;""")

rep("\n</head>", """
<style>
  /* ===== Bund v3 ===== */
  /* Breitere Tasten (Höhe bleibt): weniger Vertipper */
  .keys-panel .tt-key { min-width: 46px; padding: 0 13px; }
  .keys-panel .tt-key--icon { width: 46px; padding: 0; }
  .keys-panel__arrows button { width: 46px; }
  .keys-panel__arrows { gap: 6px; }
  .keys-panel__row--tools { gap: 6px; }
  .keys-panel .tt-key--enter { flex: 0 0 auto; min-width: 64px; }
  .keys-panel__keys { overflow-x: auto; scrollbar-width: none; }
  /* weiche Kante rechts = hier geht es weiter */
  .keys-panel__keys, .keys-panel__row--tools { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); padding-right: 22px; }

  /* Punkte-Leiste wie früher — Gerät nur als leiser Hinweis:
     ein feiner Strich in Gerätefarbe unter den Punkten, etwas Luft zwischen den Gruppen. */
  .ts-sep { display: none !important; }
  .term-switcher__track { height: 32px; }
  .ts-group.has-dev { position: relative; margin: 0 5px; padding-bottom: 5px; box-sizing: border-box; }
  .ts-group.has-dev::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: 0; height: 2px; border-radius: 2px;
    background: var(--dc); opacity: .35; transition: opacity 200ms ease-out; pointer-events: none; }
  .ts-group.has-dev.is-current::after { opacity: .85; }
</style>
</head>""")
open(p, 'w').write(s)
print('ok v3')
