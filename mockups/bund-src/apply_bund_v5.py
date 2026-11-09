import os, sys, shutil
os.chdir(sys.argv[1])
S = os.path.dirname(os.path.abspath(__file__))
shutil.copy(os.path.join(S, 'bund-v5.css'), 'liquid-deck/bund-v5.css')
shutil.copy(os.path.join(S, 'bund-v5.js'), 'liquid-deck/bund-v5.js')
p = 'liquid-deck/index.html'; s = open(p).read()
def rep(a, b):
    global s
    assert a in s, a[:90]
    s = s.replace(a, b, 1)
rep('<link rel="stylesheet" href="compact-terminal.css">', '<link rel="stylesheet" href="compact-terminal.css">\n<link rel="stylesheet" href="bund-v5.css">')
rep('<script src="compact-terminal.js"></script>', '<script src="compact-terminal.js"></script>\n<script src="bund-v5.js"></script>')
rep("  function openToolSheet(id) {\n", "  function openToolSheet(id) {\n    if (window.__bundTool && window.__bundTool(id)) return;\n")
open(p, 'w').write(s)
p = 'liquid-deck/compact-terminal.js'; s = open(p).read()
rep("const enabled = currentScreen === 'terminals' && height <= 480 && !body.classList.contains('is-locked');",
    "const enabled = currentScreen === 'terminals' && (height <= 480 || window.innerWidth >= 700) && !body.classList.contains('is-locked');")
open(p, 'w').write(s)
print('ok v5')
