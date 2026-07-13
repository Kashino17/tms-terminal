# File-Explorer-Overhaul (Season 2) — Design

**Datum:** 2026-07-13
**Status:** Vom Nutzer abgesegnet (Grundform, Video, Terminal-Aktion, Downloads, ZIP, Architektur, alle drei Design-Teile)

## Kontext & Ist-Zustand

Season 2 (Liquid Deck) ist seit v1.41.0 die App: das Mockup
`mockups/season2/liquid-deck/index.html` läuft in einer WebView,
`mobile/src/season2/web/bridge.js` tauscht die Demo-Datenschicht gegen echte
Server-Daten. Der Datei-Explorer ist dort nur ein kleines Bottom-Sheet
(navigieren, filtern, Favoriten, Ordner anlegen, Pfad einfügen, Text-Vorschau
≤ 2 MB, Einzel-Download via Share-Sheet, Einzel-Löschen).

Es fehlen: Pfad kopieren, „im Terminal öffnen“ (cd), Bild-/PDF-/Video-/
Markdown-Viewer, Bulk-Auswahl, echte Downloads in den Downloads-Ordner,
Ordner-Download. Der Server (`server/src/files/file.handler.ts`) kann
list/read/download/mkdir/move/trash, aber kein HTTP-Range (nötig für
Video-Seeking), kein ZIP, kein rename (der Rename-Knopf in der Bridge ist
heute tot — es gibt keinen Endpoint und keinen RN-Handler).

### Code-Orte (zwei Worktrees!)

| Was | Wo |
|---|---|
| Mockup (Quelle der UI) | `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` |
| Bridge + RN-Handler | `~/Desktop/tms-terminal/mobile/src/season2/web/` (`bridge.js`, `useSheetBridges.ts`) |
| Build Mockup→App | `~/Desktop/tms-terminal/mobile/scripts/build-season2-html.js` (liest MOCKUP_DIR aus dem „TMS Terminal“-Worktree) |
| Server | `~/Desktop/tms-terminal/server/src/files/` (deployed Branch: `feat/manager-chat-redesign`) |

## Ziele

1. Vollwertiger Vollbild-Explorer im Liquid-Deck-Look.
2. Dateien ansehen statt nur herunterladen: Bilder, Video (Streaming bis
   2 GB), Audio, PDF, Markdown (gerendert), Text/Code.
3. Echte Downloads in den Android-Downloads-Ordner, auch Ordner/Bulk als ZIP.
4. Bulk-Auswahl mit Löschen/Laden/Pfade-kopieren.
5. Pfad kopieren und „im Terminal öffnen“ (cd) als Alltagsaktionen.

## Nicht-Ziele

- Kein Umbau des alten RN-`FileBrowserPanel` (klassische UI bleibt unberührt).
- Kein Verschieben per Drag & Drop (Server-`move` bleibt ungenutzt bestehen).
- Kein endgültiges Löschen — immer Papierkorb.
- Keine nativen Player-Abhängigkeiten (expo-video, react-native-pdf).
- Kein Zugriff außerhalb des Home-Verzeichnisses; Sperrliste bleibt.

## Architektur (Ansatz A — im Mockup + Bridge)

Der Explorer wird als neuer Screen `data-screen="files"` im Mockup gebaut
(analog zum Browser-Screen), mit eigener Demo-Datenschicht, damit das Mockup
allein lauffähig bleibt. `bridge.js` überschreibt die Datenschicht und
verdrahtet echte Aktionen über `post(...)`-Nachrichten an React Native
(`useSheetBridges.ts`). Viewer laufen als HTML-Overlays in derselben WebView
und laden Inhalte direkt vom Server über Token-URLs.

### Einstiege

1. **Werkzeuge-Screen → Kachel „Dateien“** öffnet den Vollbild-Explorer.
2. **Terminal-Toolbar (Ordner-Symbol)** öffnet weiterhin das kompakte Sheet
   (Schnellzugriff „Pfad einfügen“). Das Sheet bekommt oben einen
   **„Vollbild“-Knopf**, der in den Explorer-Screen springt — im selben Ordner.

## UI/UX des Explorer-Screens

Aufbau (oben → unten):

1. **Kopfzeile:** Zurück (Ordner hoch) · antippbare Breadcrumbs
   (`~ / Desktop / projekt`, jeder Teil navigiert dorthin) · rechts: Suche,
   Sortierung (Name/Datum/Größe, auf-/absteigend), Auswahl-Modus, „+ Ordner“.
2. **Favoriten-Chips** über der Liste (bestehende Favoriten-Logik).
3. **Dateiliste:** Ordner zuerst, dann Dateien. Zeile = Typ-Icon in Typ-Farbe
   (Farb-/Icon-System aus dem alten `FileBrowserPanel` übernommen), Name,
   Größe, Datum. **Bilddateien zeigen ein lazy geladenes Mini-Thumbnail**
   (Server-Download-URL, `loading="lazy"`, gedeckelt auf die sichtbaren
   Zeilen).
4. **Gesten:** Tap Ordner = öffnen · Tap Datei = Viewer · Langdruck =
   Auswahl-Modus startet mit diesem Eintrag.
5. **Aktions-Menü pro Eintrag (⋯):** Öffnen · Pfad kopieren · Im Terminal
   öffnen · Einfügen · Herunterladen · Teilen · Umbenennen · Favorit ·
   Löschen. (Bei Ordnern entfallen Öffnen-im-Viewer/Einfügen-Varianten,
   Herunterladen = ZIP.)
6. **Auswahl-Modus:** Checkboxen links, Kopf zeigt „X ausgewählt“ +
   „Alle auswählen“. Unten **Bulk-Leiste**: Herunterladen (ZIP) ·
   Pfade kopieren (eine Zeile pro Pfad) · Löschen. Löschen fragt einmal:
   „N Einträge in den Papierkorb?“.

**Aktions-Semantik:**
- *Pfad kopieren* → Handy-Zwischenablage (`clipboard:write`), Toast.
- *Im Terminal öffnen* → sendet `cd <ordner>` + Enter an das aktive Terminal
  (bei Dateien: Ordner der Datei) und wechselt zur Terminal-Ansicht. Kein
  aktives Terminal → Toast „Kein Terminal offen“.
- *Einfügen* → wie bisher in die Dock-Eingabezeile.
- *Löschen* → immer Server-`/files/trash` (Papierkorb).

## Viewer

Vollbild-Overlay im Explorer; oben immer Dateiname + Herunterladen + Teilen +
Schließen (×, Wisch nach unten).

| Typ | Verhalten |
|---|---|
| Bild (png/jpg/jpeg/gif/webp/svg/ico/bmp) | `<img>` mit Pinch-Zoom/Doppeltipp; ◂ ▸ blättert durch alle Bilder des aktuellen Ordners. |
| Video (mp4/webm/mov, bis 2 GB) | HTML5 `<video controls>` gegen die Range-fähige Download-URL: sofortiger Start, Spulen, Vollbild/Querformat. Kein Download aufs Gerät. |
| Audio (mp3/wav/m4a/ogg) | HTML5 `<audio controls>`. |
| Markdown (.md/.mdx) | Clientseitig gerendert (Überschriften, Listen, Code-Blöcke, Links, Bilder) mit Umschalter „Quelltext“. Renderer: portierte `simpleMarkdownToHtml`-Logik aus dem alten Panel. |
| PDF | iframe auf den vom Server gehosteten pdf.js-Viewer: `GET /files/pdfjs/web/viewer.html?file=<download-url>`. |
| Text/Code | Wie bisher `/files/read`, Limit neu 5 MB, mit Zeilennummern. |
| Sonstiges (zip/dmg/bin…) | Info-Karte (Name, Größe, Datum) mit Herunterladen/Teilen. |

Spielt ein Video-Format nicht ab (`onerror` des `<video>`), fällt der Viewer
automatisch auf die Info-Karte zurück.

## Downloads

- **Ziel:** Android-Downloads-Ordner via Storage Access Framework (SAF).
  Einmalige Ordner-Freigabe beim ersten Download; die gewährte Directory-URI
  wird persistiert (Store), danach still. Freigabe verweigert → Fallback
  Share-Sheet.
- **Mechanik:** `expo-file-system` `downloadAsync`/`createDownloadResumable`
  (nativer Download, Fortschritts-Callback) in den App-Cache →
  `copyAsync` auf die SAF-URI → Cache-Datei löschen.
- **Fortschritt:** Events an die WebView; laufende Downloads als schmale
  Leiste unten im Explorer (Name, %, Abbrechen). Download läuft beim
  Weiternavigieren weiter. Fertig → Toast.
- **Ordner & Bulk:** `GET /files/zip?paths=…` streamt on-the-fly als
  `tms-<name>.zip` (Paket `archiver`). Serverseitiges Schutzlimit: Summe der
  Rohdaten > 4 GB → Abbruch mit HTTP 413 und klarer Meldung vor
  Stream-Beginn.
- **Teilen** bleibt eigene Aktion: Download in den Cache → Share-Sheet
  (bisheriges Verhalten).

## Server-Änderungen (`server/src/files/`)

1. **`GET /files/download`: HTTP-Range-Support.** `Accept-Ranges: bytes`;
   `Range`-Header → `206 Partial Content` mit `Content-Range`, korrekte
   Behandlung von offenen (`bytes=N-`), Suffix- (`bytes=-N`) und ungültigen
   Ranges (`416`). MIME-Map erweitert (mov, m4a, mkv, ogg, webm, avi …).
2. **Neu `GET /files/zip?paths=<json-array>`** — ZIP-Stream via `archiver`
   (neue Server-Dependency). Gleiche Pfad-Checks wie überall
   (Home-only + Sperrliste, pro Eintrag), Größen-Vorabprüfung (4-GB-Limit).
3. **Neu `GET /files/pdfjs/…`** — statisch gebündelter pdf.js-Viewer
   (Assets liegen im Server-Paket), mit Pfad-Traversal-Schutz.
4. **Neu `POST /files/rename`** `{ path, name }` — Umbenennen im selben
   Ordner, Konflikt → `409`, gleiche Sicherheits-Checks.
5. **`/files/read`:** Limit 2 MB → 5 MB.
6. **Unverändert:** Home-only-Regel, Sperrliste (`.ssh`, `.aws`,
   `.tms-terminal`, …), Trash-Semantik, Token-Auth (Token in Query für
   URL-basierte Loads wie bisher beim Download).

## Bridge & RN (`bridge.js`, `useSheetBridges.ts`)

Neue WebView→RN-Nachrichten:

| Nachricht | Payload | RN-Verhalten |
|---|---|---|
| `files:copyPath` | `{ paths: string[] }` | Zwischenablage (mehrere Pfade zeilenweise) |
| `files:cdTerminal` | `{ path }` | `cd <path>` + Enter an aktive Session, Screen-Wechsel zu Terminals |
| `files:downloadToFolder` | `{ paths: string[] }` | 1 Datei → Direkt-Download; sonst/Ordner → `/files/zip`; SAF-Ablage, Progress-Events |
| `files:share` | `{ path }` | Cache-Download + Share-Sheet |
| `files:rename` | `{ path, name }` | `POST /files/rename`, danach Liste neu laden |
| `files:trash` | `{ paths: string[] }` | bestehender Handler, erweitert auf Arrays |

RN→WebView: `TMSBridge.downloadProgress(id, name, pct, state)` und wie
bisher `setTool('files', …)`-Datenupdates. Viewer-URLs (Bild/Video/PDF) baut
die Bridge aus Server-Basis-URL + Token.

## Mockup-Änderungen

- Neuer `<section data-screen="files">` + Styles + Render-/Gesten-Logik +
  Demo-Dateibaum (Mockup bleibt allein lauffähig, Viewer zeigen Demo-Inhalte).
- Werkzeuge-Kachel „Dateien“ → öffnet den Screen statt des Sheets;
  Terminal-Toolbar behält das Sheet; Sheet-Kopf bekommt „Vollbild“-Knopf.
- `build-season2-html.js`: neue Patch-Anker prüfen (Script schlägt laut fehl,
  wenn Anker fehlen — Anker bewusst stabil benennen).

## Fehlerbehandlung

- Server nicht erreichbar / 403 / 404 → deutscher Toast mit Ursache, Liste
  behält letzten Stand (kein Leeren).
- Video nicht abspielbar → Info-Karte mit Herunterladen/Teilen.
- ZIP-Limit → Meldung „Zu groß (> 4 GB) — bitte einzeln laden“.
- Download abgebrochen/fehlgeschlagen → Teildatei im Cache löschen, Toast.
- SAF-Freigabe verweigert → Share-Sheet-Fallback.
- Thumbnails, die nicht laden, fallen still auf das Typ-Icon zurück.

## Tests

- **Server-Unit-Tests** (bestehendes `npm test`):
  - Range-Parsing: normal, offen, Suffix, mehrteilig (abgelehnt),
    out-of-range → 416, Range über Dateiende gekappt.
  - ZIP: Pfad-Checks (Traversal, Sperrliste), Limit-Abbruch, Konflikt-Namen.
  - rename: Erfolg, Konflikt 409, Sperrpfad 403, außerhalb Home 403.
  - read: 5-MB-Grenze.
- **UI:** Playwright-Screenshots am Mockup (etablierter Workflow) für
  Screen, Auswahl-Modus, Viewer-Overlays, Sheet-„Vollbild“-Knopf.
- **End-to-End manuell** auf dem Fold 7: 2-GB-Video spulen, ZIP-Download in
  den Downloads-Ordner, Bulk-Löschen in den Papierkorb.

## Risiken

- **iCloud-Worktree:** git-Operationen im „TMS Terminal“-Worktree nur per
  Plumbing; App-Release wie etabliert über CI (Tag-Push), nicht lokal.
- **pdf.js-Bundle-Größe** (~2 MB im Server-Paket) — bewusst serverseitig,
  damit die APK nicht wächst und Updates ohne App-Release möglich sind.
- **SAF-`copyAsync`-Verhalten** je Android-Version — beim ersten
  Implementierungsschritt auf dem Gerät verifizieren, Fallback Share-Sheet
  steht.
