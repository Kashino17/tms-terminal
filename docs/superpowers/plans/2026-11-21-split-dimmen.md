# Split: Schein dezenter + Abdunkeln-Knopf — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Farbschein um Fokus-Karte und Eingabe stark zurücknehmen; im Split ein Mond-Knopf in der Eingabezeile, der die ganze App mit einem schwarzen Schleier abdunkelt.

**Architecture:** Alles in den zwei Fold-Dateien, die schon live gehen. `fold.css` trägt Optik (Schein, Knopf, Schleier), `fold.js` den Zustand (`fv.dim`, Knopf, Merken). Der Schleier ist ein eigenes `position: fixed`-Element am Ende von `<body>`, gesteuert über `body.fv-dim`.

**Tech Stack:** Vanilla JS/CSS im Mockup `mockups/season2/liquid-deck/`, eingebettet per `mobile/scripts/build-season2-html.js` nach `mobile/src/season2/web/liquidDeckHtml.ts`; Tests `node --test` + Playwright (`TMS_VIZ_PW`).

**Spec:** `docs/superpowers/specs/2026-11-21-split-dimmen-design.md`

## Global Constraints

- Arbeitsbaum: `~/Developer/tms-terminal`, Branch `feat/fernzugriff`. Nie `liquidDeckHtml.ts` von Hand ändern.
- Kein `filter` auf Seitenebene, keine `infinite`-Animation, kein neuer `backdrop-filter`.
- UI-Texte deutsch, Kommentare im Stil der Datei (deutsch).
- Schleier: schwarz, Deckkraft `--fv-dim-a: .65`, `pointer-events: none`, 260 ms Einblenden.
- Merken: `localStorage` Schlüssel `tms-fold-dim`, Wert `'1'` oder entfernt.
- Kein Push, kein Tag, kein Versions-Bump in diesem Plan — Freigabe des Nutzers kommt nach dem Ansehen.

## Review Focus

1. Abgedunkelt den Split verlassen (aufklappen auf Vollbild) → App sofort normal hell, Knopf weg; zurück in den Split → wieder dunkel.
2. Abgedunkelt tippen: der Schleier darf keinen Tipp schlucken (Knopf selbst, Karte, Menü).
3. App-Neustart im Split mit gemerktem „dunkel“ → startet dunkel, Knopf zeigt „an“.
4. Schmaler Split zugeklappt (380 px): der zusätzliche Knopf drückt die Eingabe nicht weg, Senden bleibt in der Zeile.
5. `localStorage` wirft (privater Modus) → Knopf schaltet trotzdem für die Sitzung.

---

### Task 1: Schein dezenter

**Files:**
- Modify: `mockups/season2/liquid-deck/fold.css:25-29` (Karte), `:45-58` (Eingabe + Puls)
- Test (neu): `mobile/scripts/webview-fold.test.mjs`

**Interfaces:**
- Produces: Testhelfer `boot(vp)` und `mode(page, m)` in `webview-fold.test.mjs` (lädt gebautes `liquidDeckHtml.ts` wie `webview-bund.test.mjs`, ruft `unlockApp(); goToTerminals(); setDockPage('term')`, dann `TMSFold.setForce(m)`), von Task 2 mitbenutzt.

- [ ] **Step 1: Test schreiben** — `Schein: Eingabe ohne Lichthof, Karte nur feine Linie` bei 750×560, `mode('split-open')`:
  - `getComputedStyle(#dock).boxShadow` ist gleich dem Wert im Modus `closed` (kein zusätzlicher Ring/Lichthof).
  - `getComputedStyle(.stack-card.fv-focus).boxShadow` enthält genau einen Schatten und der endet auf `0px 0px 0px 1px` (Ring 1 px, kein Blur).
  - Nach einem Fokuswechsel (`setActive(1)`) und 700 ms: `#dock` hat keine Klasse `fv-pulse`, `boxShadow` unverändert.
- [ ] **Step 2: Bauen + laufen lassen, muss scheitern** — `cd mobile && npm run build:season2 && TMS_VIZ_PW=<pfad> node --test scripts/webview-fold.test.mjs` → FAIL (Lichthof `26px` vorhanden).
- [ ] **Step 3: `fold.css` ändern** — Karte: `box-shadow: 0 0 0 1px color-mix(in srgb, var(--tag, var(--accent)) 26%, transparent)`. Eingabe: nur `border-color: color-mix(in srgb, var(--fv-tag, var(--accent)) 24%, var(--glass-border))`, kein `box-shadow`. `@keyframes fvDockPulse` animiert nur `border-color` (35 % → Mischung 55 %). `transition` der Eingabe ohne `box-shadow`.
- [ ] **Step 4: Bauen + Test grün.**
- [ ] **Step 5: Commit** — `fix(fold): Farbschein um Karte und Eingabe viel dezenter`

### Task 2: Abdunkeln-Knopf + Schleier

**Files:**
- Modify: `mockups/season2/liquid-deck/fold.js` (Zustand in `fv`, Knopf nach `kbBtn`, `apply()`), `mockups/season2/liquid-deck/fold.css` (Abschnitt „Abdunkeln“ ans Ende)
- Test: `mobile/scripts/webview-fold.test.mjs`

**Interfaces:**
- Produces: `fv.dim: boolean`; `window.TMSFold.setDim(on: boolean): void`; DOM `#fvDimBtn` (`button.term-input-btn`, `aria-pressed`, `aria-label` „Abdunkeln“ / „Wieder hell“), `#fvDim` (Schleier, direktes Kind von `body`); Klasse `body.fv-dim` = Split **und** `fv.dim`.

- [ ] **Step 1: Tests schreiben**
  - `Abdunkeln: Knopf nur im Split` — `#fvDimBtn` `display` ist `none` in `closed` und `open`, sichtbar in `split-open` und `split-closed`.
  - `Abdunkeln: Tipp dunkelt, zweiter Tipp hellt auf` — echter `page.click('#fvDimBtn')` → `body.fv-dim`, `aria-pressed="true"`, nach 400 ms `#fvDim` `opacity` = `0.65`, `pointerEvents` = `none`, `localStorage['tms-fold-dim'] === '1'`; zweiter echter Klick (geht nur, wenn der Schleier nichts schluckt) → alles zurück, Schlüssel entfernt.
  - `Abdunkeln: nur im Split, Wahl bleibt gemerkt` — an, dann `mode('open')` → kein `fv-dim`, Schleier `opacity` 0; `mode('split-closed')` → `fv-dim` wieder da.
  - `Abdunkeln: Neustart im Split startet dunkel` — `addInitScript` setzt `tms-fold-dim='1'` und `tms-fold-force='split-open'` → nach dem Laden `fv-dim`, `aria-pressed="true"`.
  - `Abdunkeln: Speicher wirft` — `addInitScript` ersetzt `Storage.prototype.setItem/removeItem` durch Werfer → Klick schaltet trotzdem, keine `pageerror`.
  - `Abdunkeln: schmale Zeile` — 380×420, `split-closed`: `#dockInput.clientWidth >= 120`, rechter Rand von `#dockSendBtn` ≤ rechter Rand von `#dock`.
- [ ] **Step 2: Bauen + laufen lassen, muss scheitern** (`#fvDimBtn` fehlt).
- [ ] **Step 3: `fold.js`** — `fv.dim` aus `load('tms-fold-dim') === '1'`; Knopf wie `kbBtn` bauen (Mond-SVG 20 px, `pointerdown` → `preventDefault`, damit die Eingabe den Fokus behält), vor `#dockMicBtn` einhängen; Schleier-`div#fvDim` an `body` hängen; `setDim(on)` schreibt/entfernt den Schlüssel in `try/catch` und ruft `apply()`; `apply()` setzt `body.fv-dim` und `aria-*`. Nach Ein-/Ausblenden des Knopfs `fitDockPlaceholder(input)` rufen (Zeile wird schmaler).
- [ ] **Step 4: `fold.css`** — `#fvDimBtn { display: none }`, `body.fv-split #dock #fvDimBtn { display: flex }`, gedrückt = Akzentfarbe wie `#fvKbBtn[aria-pressed="true"]`; `#fvDim { position: fixed; inset: 0; z-index: 2147483000; background: #000; opacity: 0; pointer-events: none; transition: opacity 260ms var(--ease-out) }`, `body.fv-dim #fvDim { opacity: var(--fv-dim-a, .65) }`.
- [ ] **Step 5: Bauen + alle Tests grün** — zusätzlich `npm run test:mockup` (Regressionsblick; bekannte Altfehler: `webview-bubble` ×3, `webview-remote-switch` „Holen“).
- [ ] **Step 6: Ansehen** — `python3 mockups/season2/fold-assemble.py`, Bildschirmfotos 750×560 (Split auf) und 380×420 (Split zu), hell/dunkel; Überlappungen selbst suchen.
- [ ] **Step 7: Commit** — `feat(fold): Abdunkeln-Knopf im Split` (inkl. `liquidDeckHtml.ts`, `fold.html`, Spec + Plan).
