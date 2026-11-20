#!/usr/bin/env python3
"""Baut liquid-deck/fold.html = echte index.html (enthält fold.css/fold.js) +
Demo-Umschalter + Demo-Simulator. Nach Änderungen an index.html neu laufen lassen."""
import pathlib
d = pathlib.Path(__file__).parent / 'liquid-deck'
s = (d / 'index.html').read_text()
b = '<script src="fold.js"></script>'
assert s.count(b) == 1
s = s.replace(b, b + '\n<script src="fold-demo.js"></script>')
s = s.replace('<script src="../shared/sim.js" charset="utf-8"></script>', '<script src="fold-sim.js" charset="utf-8"></script>')  # Demo-Simulator (aus 7d6ef75)
s = s.replace('<title>', '<title>Fold · ', 1)
(d / 'fold.html').write_text(s)
print('fold.html geschrieben')
