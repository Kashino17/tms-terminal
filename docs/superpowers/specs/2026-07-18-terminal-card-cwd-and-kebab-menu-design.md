# Terminal-Karte: Ordner-Zeile + Kebab-Menü

**Datum:** 2026-07-18
**Scope:**
- Mockup (Anzeige): `mockups/season2/liquid-deck/index.html` (dieser master-Worktree)
- Page-Bridge: `mobile/src/season2/web/bridge.js` (Worktree `~/Desktop/tms-terminal`, Branch `feat/manager-chat-redesign`)
- RN/WS-Host: `mobile/src/season2/SeasonTwoWebRoot.tsx` (gleicher Worktree)
- Server: `server/src/websocket/ws.handler.ts` (+ ggf. `server/src/terminal/terminal.manager.ts`)

> Build-Kette: Der `build:season2`-Schritt liest das Mockup aus **diesem** master-Worktree und
> generiert `mobile/src/season2/web/liquidDeckHtml.ts` (nie direkt editieren). Server läuft live aus
> `~/Desktop/tms-terminal` (Branch `feat/manager-chat-redesign`).

## Ziel
Zwei Änderungen am Terminal-Karten-Header (`cardHeaderHtml`, Mockup Z. 2965 — geteilt von Stack +
Liste):

1. **Ordner-Zeile:** Direkt unter dem editierbaren Titel eine winzige, graue Auto-Info-Zeile, die
   **nur den letzten Ordnernamen** des aktuellen Arbeitsverzeichnisses zeigt. Nutzt den schon
   vorhandenen vertikalen Platz im Header — macht die Karte nicht höher.
2. **Kebab-Menü:** Der grüne ⚡-`.auto-toggle` wird durch einen ⋮-Button (drei vertikale Punkte)
   ersetzt. Tippen öffnet ein Dropdown mit (a) Auto-Approve-Schalter und (b) „Terminal schließen"
   (mit Rückfrage).

---

## 1. Ordner-Zeile (Anzeige)

### Markup / CSS (Mockup)
- In `cardHeaderHtml` innerhalb `.card-name-wrap` **unter** dem `.card-name`-Input:
  `<span class="card-cwd" data-card-cwd></span>`.
- **Kein** editierbares Feld (im Unterschied zu Titel/Beschreibung, die per Dreifach-Tipp editierbar
  werden) — reines `<span>`, reine Auto-Info.
- Styling analog `.card-desc` (Z. 730): `display:block`, `overflow:hidden`, `text-overflow:ellipsis`,
  `white-space:nowrap`, `font-size:var(--fs-caption)`, `color:var(--text-dim)`, `margin-top:1px`.
  Eigene Klasse `.card-cwd`, damit die Editier-States von `.card-desc` nicht greifen.

### Wert-Ableitung (Mockup-Helper)
- `folderLabel(cwd)` → letzter Pfad-Bestandteil:
  - leer/`undefined`/`null` → `''` (Zeile bleibt leer, kein Platzverbrauch)
  - Home-Verzeichnis → `~`
  - Root `/` → `/`
  - sonst `basename` (letztes Segment nach `/`, trailing Slash ignoriert)
- Home-Erkennung: Der Server schickt den absoluten Pfad; das Mockup kennt die Home nicht direkt.
  → Der **Server** normalisiert Home zu `~`/`~/…` vor dem Senden (siehe §2), das Mockup nimmt den
  letzten Bestandteil und übersetzt reines `~` zu `~`.

### Live-Update (kein Voll-Rerender)
- Neuer Hook `window.__tmsSetSessionCwd(cardId, cwd)`:
  - speichert `cwd` am Session-Objekt (`TMS_DATA.sessions[i].cwd`) **und** an `cardState[id]` (damit
    Rerenders wie View-Wechsel/Neuaufbau den Wert behalten — vgl. Heat-Fix DOM-Patching),
  - patcht die `.card-cwd`-Textzeile **in-place** in allen sichtbaren Karten dieser Id (Stack +
    Liste), ohne `renderCardLines` o.ä. auszulösen.
- `cardHeaderHtml` rendert den Anfangswert aus `cardState[id].cwd` (bzw. leer).

### Demo (Standalone-Mockup)
- Die Demo-Sessions bekommen realistische `cwd`-Werte (z.B. `~/Desktop/TMS Terminal`,
  `~/projects/api`), damit der Look ohne Server stimmt.

---

## 2. Ordner live erkennen (Server)

**Event-getrieben, kein Dauer-Poll.** Der reale cwd wird gelesen, nicht Text geparst — fängt jeden
Wechsel ab (`cd`, `pushd`/`popd`, `cd` in Skript/Alias, Symlink-Auflösung).

### Trigger: Output-Settle-Debounce
- Bei jedem Output-Chunk einer **attachten** Session wird ein kurzer Debounce-Timer (~500 ms) neu
  gestartet (dort, wo heute schon `idleDetector.activity(sessionId)` bei Output läuft).
- Feuert der Timer (Output zur Ruhe gekommen = Befehl fertig, neuer Prompt):
  1. `readProcessCwd(pid)` (vorhanden in `server/src/terminal/cwd.utils.ts`, procfs/lsof).
  2. Home → `~`/`~/…` normalisieren.
  3. Wenn `!= session.cwd`: `session.cwd` setzen **und** an den Client pushen:
     `{ type: 'terminal:cwd', sessionId, payload: { cwd } }`.
  4. Kein Change → kein Push (idempotent).
- Läuft nur bei aktivem Client (wir haben dann `ws`). Der Detach-Snapshot (Z. 153
  `terminal.manager.ts`) bleibt als Fallback.

### Initialwert
- Direkt nach dem Attach/Watch einer Session einmal `readProcessCwd(pid)` lesen und (normalisiert)
  als `terminal:cwd` pushen — **derselbe** Weg wie beim Live-Update, ein Code-Pfad. So stimmt die
  Zeile sofort (auch bei frischen Sessions), statt erst nach dem ersten Befehl. Das vorhandene `cwd`
  in `terminal:reattached` (Z. 504) bleibt als zusätzlicher Sofortwert erhalten.

### Kosten / Grenzen
- 1× `readProcessCwd` pro Output-Settle (nicht pro Chunk); lsof auf macOS ~50–150 ms, unkritisch.
- `readProcessCwd` liest den cwd des **PTY-Root** (Shell). Läuft ein Vordergrund-Tool (z.B. Claude
  Code), bleibt der Shell-cwd = Startverzeichnis — deckt sich mit dem sichtbaren Prompt. Interne
  Verzeichniswechsel eines Tools werden bewusst **nicht** verfolgt (das erwartet der Nutzer auch so).

---

## 3. Kebab-Menü (ersetzt ⚡)

### Button (Mockup)
- `.auto-toggle` (⚡, Z. 2974) → `.card-menu-btn` mit `icon('dots', …)` (neuer Icon-Pfad: drei
  vertikale Punkte). `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Terminal-Menü"`.
- Klick-Wiring (heute `data-act="auto"`) → `data-act="menu"` → öffnet Dropdown für diese Karte.

### Dropdown
- Kleines Popover im Deck-Glass-Look, an den ⋮-Button angedockt (absolute Positionierung; in Stack +
  Liste). Immer nur **eines** offen; schließt bei Auswahl, Außen-Tipp oder `Esc`.
- **Zeile 1 — Auto-Approve:** Label links, kleiner Schalter rechts (spiegelt `cardState[id].autoApprove`).
  Toggle ruft das **bestehende** `toggleCardAutoApprove(id)` — das die Bridge bereits zu
  `post('autoapprove:set', …)` überschreibt (`bridge.js` Z. 938). Schalter-Zustand nach Toggle
  aktualisieren; Dropdown darf offen bleiben (direkt sichtbares Feedback) oder schließen — Default:
  **offen bleiben**, damit man den Umschalt-Effekt sieht.
- **Zeile 2 — Terminal schließen (Danger, rot):** Zwei-Stufen-Bestätigung **inline** (kein extra
  Modal): Tipp verwandelt die Zeile in „Wirklich schließen? · Ja / Abbrechen". „Ja" nutzt den
  **bestehenden** Close-Weg (Mockup entfernt Karte; Bridge postet `terminal:close`,
  `bridge.js` Z. 2246). „Abbrechen" bzw. Außen-Tipp setzt zurück.

### Bestehende Verdrahtung (Wiederverwendung, nichts Neues serverseitig)
- Auto-Approve: `toggleCardAutoApprove` → `autoapprove:set` → `client:set_auto_approve` (Server führt
  Auto-Approve aus).
- Close: `terminal:close` → `wsService.send({ type:'terminal:close', sessionId })`.

---

## 4. cwd-Datenfluss (End-to-End)

```
Shell cd → PTY-Output → Server Output-Settle-Debounce → readProcessCwd(pid)
  → geändert? → session.cwd + send 'terminal:cwd'
    → SeasonTwoWebRoot: onMessage 'terminal:cwd' → call('setSessionCwd', cardId, cwd)
      → bridge.js: window.TMSBridge.setSessionCwd = (cardId,cwd) => window.__tmsSetSessionCwd(cardId,cwd)
        → Mockup: __tmsSetSessionCwd patcht .card-cwd in-place (folderLabel)
```

- **SeasonTwoWebRoot.tsx:** neuer Message-Case `terminal:cwd` → `call('setSessionCwd', cardId, cwd)`;
  Karten-Id-Zuordnung wie bei `setSessionStatus` (per `sessionId → cardId`). cwd zusätzlich in die
  initiale Session-Übergabe (Z. ~565–581) aufnehmen, falls beim Attach schon bekannt.
- **bridge.js:** `window.TMSBridge.setSessionCwd` ergänzen (analog `setAutoApprove`, Z. 2217), ruft
  `window.__tmsSetSessionCwd`.

---

## 5. Betroffene Dateien (Zusammenfassung)

| Datei | Worktree/Branch | Änderung |
|---|---|---|
| `mockups/season2/liquid-deck/index.html` | master (dieser) | `.card-cwd`-Zeile + CSS, `folderLabel`, `__tmsSetSessionCwd`, ⋮-Icon + Dropdown (Auto-Approve-Schalter, Close mit Rückfrage), Demo-cwds |
| `mobile/src/season2/web/bridge.js` | tms-terminal / feat | `TMSBridge.setSessionCwd` |
| `mobile/src/season2/SeasonTwoWebRoot.tsx` | tms-terminal / feat | Message-Case `terminal:cwd`; cwd in Session-Übergabe |
| `server/src/websocket/ws.handler.ts` | tms-terminal / feat | Output-Settle-Debounce → `readProcessCwd` → `terminal:cwd`-Push; Initial-Push beim Attach |
| `server/src/terminal/terminal.manager.ts` | tms-terminal / feat | ggf. Home-Normalisierung/Helfer (falls nicht in ws.handler) |
| `mobile/src/season2/web/liquidDeckHtml.ts` | tms-terminal / feat | **generiert** via `build:season2` (nicht von Hand) |

---

## 6. Edge Cases / Entscheidungen

- **cwd unbekannt** → Ordnerzeile bleibt **leer** (kein Platzhalter), Header bleibt ruhig.
- **Auto-Approve im Dropdown** = Schalter (nicht Text „An/Aus").
- **Home** → `~` (Server normalisiert), sonst reiner Ordnername.
- **Header-Höhe:** Titel + winzige cwd-Zeile passen in den schon vorhandenen Platz (⋮-Button/Status-
  Chip sind höher als eine Textzeile). Muss headless bei 412×915 geprüft werden.
- **Beide Ansichten:** Stack + Liste teilen `cardHeaderHtml` → beide bekommen Ordnerzeile + Kebab.
- **Nur ein Dropdown** gleichzeitig offen; schließt bei Auswahl/Außen-Tipp/`Esc`.
- **Kein neuer Server-Weg** für Close/Auto-Approve — nur cwd ist neu.

## 7. Verifikation

- Mockup-Demo headless (412×915): Ordnerzeile grau/klein unter Titel; Header nicht höher als vorher;
  ⋮-Button an Stelle des ⚡; Dropdown öffnet, Auto-Approve-Schalter schaltet, „Terminal schließen"
  → Rückfrage → Ja/Abbrechen. Beides in Stack **und** Liste.
- Server-Unit/manuell: nach `cd` im PTY kommt genau **ein** `terminal:cwd` mit dem neuen letzten
  Ordner; ohne Verzeichniswechsel **kein** Push.
- End-to-End in der App: `cd` im Terminal → Ordnerzeile aktualisiert sich **live** ohne App-Neustart.
