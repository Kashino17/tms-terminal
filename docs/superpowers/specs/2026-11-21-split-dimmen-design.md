# Split: Schein dezenter + Abdunkeln-Knopf — Design

Datum: 2026-11-21 · Größe: kleine Änderung · vom Nutzer freigegeben („Ja, das passt.“)

## Absicht
Der Nutzer schaut im Split oben ein Video und arbeitet unten im Terminal. Die App
zieht zu viel Licht auf sich. Das Video soll im Fokus stehen.

## Ziele
1. Der farbige Schein um Fokus-Karte und Eingabezeile wird viel dezenter — in jeder
   aufgeklappten Ansicht (`body.fv-two`), nicht nur im Split.
2. Im Split (`body.fv-split`, zugeklappt und aufgeklappt) sitzt in der Eingabezeile
   ein Mond-Knopf. Er dunkelt die ganze App deutlich ab.

## Nicht-Ziele
- Keine Stärke-Einstellung, kein Eintrag in den Einstellungen.
- Kein Abdunkeln außerhalb des Splits.
- Der graue Streifen unter der App (58,58,60 — gleiche Farbe wie die Trennlinie
  über der App) gehört zu Samsungs Split-Rahmen, nicht zur App
  (`navigationBarColor` der App ist `#0F172A`). Er lässt sich aus der App nicht färben.

## Anti-Ziele
- Kein Wärme-Rückfall: kein `filter` auf der Seite, keine Dauer-Animation.
- Man darf nicht „im Dunkeln eingesperrt“ sein: der Knopf bleibt erkennbar, und
  außerhalb des Splits ist die App immer normal hell.

## Wege
- **A — schwarzer Schleier (gewählt):** eine feste, durchsichtige Ebene über allem,
  `pointer-events: none`. Dunkelt alles gleichmäßig (auch Terminaltext, Menüs),
  kostet den Grafikchip nur das Drüberlegen.
- B — dunklere Farbwerte: lässt farbigen Terminaltext hell, viel Pflege, weniger dunkel.
- C — `filter: brightness()` auf der Seite: gleiche Optik wie A, aber jede
  Terminalausgabe läuft durch den Filter → Wärme am Fold.

## Aufbau
- **Schein** (`fold.css`): Karte = 1 px Linie in Terminalfarbe ~26 %, kein Schatten.
  Eingabe = Rand ~24 %, kein Ring, kein Lichthof. Farbiger `$` bleibt. Beim
  Fokuswechsel hebt sich nur die Randfarbe kurz (~55 %), ohne Lichthof.
- **Knopf** `#fvDimBtn` (`fold.js`): Mond-Symbol, vor dem Mikro. Sichtbar nur mit
  `body.fv-split`. `aria-pressed`, Beschriftung „Abdunkeln“ / „Wieder hell“.
- **Schleier** `#fvDim`: `position: fixed; inset: 0`, schwarz, Deckkraft
  `--fv-dim-a` (Standard .65, meine Schätzung), blendet 260 ms ein. Aktiv nur mit
  `body.fv-dim` — das ist „Split **und** eingeschaltet“.
- **Merken:** `localStorage` `tms-fold-dim` (`1`/leer). Verlässt man den Split, geht
  der Schleier weg; kommt man zurück, gilt die gemerkte Wahl.
- **Knopf im Dunkeln:** liegt optisch unter dem Schleier, trägt eingeschaltet aber
  den vollen Akzent, damit er auffindbar bleibt.

## Dem Bauenden überlassen
Genaue Prozentwerte des Scheins, Symbol-Zeichnung, Testform (Mockup-Tests in
`mobile/scripts/*.test.mjs`).
