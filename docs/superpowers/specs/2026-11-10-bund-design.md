# Bund — alle Geräte gleichberechtigt, neue Werkzeuge, Desk-Ansicht

Stand 2026-11-10 · freigegebenes Mockup: `mockups/bund-v8/` (Tailscale :8480) · Patch-Quellen im Session-Scratchpad (apply_bund*.py, bund-v5.css/js)

## Warum

Beim Wechsel zwischen MacBook- und Windows-Terminal zeigten Dateien-Leiste und Bilder-Upload weiter den Mac. Ursache: Die App kennt einen **Hauptserver** (`servers[0]`). An ihm hängen Dateien-Sheet, Upload, Ports, Notizen, SQL, Watcher, Manager, Diktat, Zwischenablage, Browser-Brücke und das Anlegen neuer Terminals. Weitere Geräte laufen nur als „Peers“, die ausschließlich `terminal:*` verarbeiten. Der Fix aus v1.127.1 hat nur den Vollbild-Explorer am Hauptserver vorbeigeführt.

Der Nutzer arbeitet mit beiden Geräten wie mit einem: Er wechselt in der Leiste und im Fernzugriff mit zwei Klicks hin und her. **Es gibt keinen Hauptserver.** Die Geräte bilden einen **Bund**.

## Ziele

1. **Bund statt Hauptserver.** Alle gespeicherten Geräte sind gleichberechtigt und parallel verbunden. Ist ein Gerät offline, läuft der Rest normal weiter.
2. **Gerätebezogenes folgt dem Terminal, das vorne ist:** Dateien, Bilder-Upload, `cd hier`, Ports, Prozesse, Fingerabdruck-Entsperren, Browser-Brücke. Der Wechsel geht sofort: Ordner und letzte Liste werden pro Gerät gemerkt und sofort gezeigt, die frische Liste kommt still hinterher.
3. **Auf dem Handy statt auf einem Server:** Notizen, Zwischenablage-Verlauf, Snippets. Sie bleiben bei APK-Updates erhalten (durableStorage).
4. **Diktat nur über das Gerät, das es kann** (MacBook, mlx-whisper). Ist es offline, ist der Mikro-Knopf ausgeblendet. Der Text geht immer ins Terminal vorne, auch wenn das Windows ist.
5. **Raus:** Manager (App und Server, inkl. Cron, Agenda, Speicher, Modelle), SQL, Watcher.
6. **Ehrlicher Ping:** häufiger messen, Ausreißer nicht wegglätten.
7. **Neue Oberflächen** gemäß Mockup v8: Bund-Übersicht, schlichte Punkte-Leiste mit Gerätehinweis, breitere Shortcut-Tasten, Desk-Ansicht aufgeklappt, Datei-Explorer, Zwischenablage, Snippets.

## Nicht-Ziele / Anti-Ziele

- Keine neue Terminal-Breitenlogik: Die festen 50 Spalten bleiben (sonst entstehen wieder Dopplungen).
- Kein Redesign der Glas-Optik insgesamt. Flach werden nur Explorer, Zwischenablage, Snippets und die Desk-Seitenleiste.
- **Anti-Ziel:** Ein Gerät, das „oben“ steht. Jede Funktion, die stillschweigend am ersten Server hängt, ist ein Fehler.
- **Anti-Ziel:** Automatisches Ein- und Ausblenden der Desk-Seitenleiste.
- **Anti-Ziel:** Bestehende Funktionen fallen weg (Shortcut-Leiste, Upload-Ablauf mit Galerie).

## Verhalten im Detail

### Bund-Übersicht (Screen `servers`)
- Titel „Bund“. Eine Karte „Mein Bund · N von M online“.
- Je Gerät eine Zeile: Gerätefarbe und Symbol (Laptop oder Monitor), Name, Ping, Anzahl Terminals, OS. Dazu Fähigkeits-Chip „Diktat“ (nur wenn das Gerät es meldet) und ein Fernzugriff-Knopf.
- Tipp auf ein Gerät öffnet dessen erstes Terminal. Darunter „+ Gerät zum Bund hinzufügen“ (der bestehende Hinzufügen-Weg).
- **Keine** Terminalliste auf der Übersicht.
- Untere Leiste: Bund · Terminals · Cloud · Browser. Der Manager-Eintrag entfällt.

### Punkte-Leiste (zugeklappt)
- Die alten Buchstaben-Punkte bleiben unverändert.
- Geräte-Hinweis: ein 2-px-Strich in Gerätefarbe unter den Punkten jedes Geräts (Deckkraft .35, aktuelles Gerät .85) und 10 px Luft zwischen den Gruppen. Keine Schrift, keine Icons, keine Kapseln.
- Bei nur einem Gerät gibt es keinen Strich.

### Shortcut-Leiste
- Touch-ID-Knopf (🔓) raus, er gehört nur in den Fernzugriff.
- Knopf „Alle Werkzeuge“ raus. Stattdessen alle Werkzeuge direkt in Reihe 2: Bilder, Dateien, Notizen, Zwischenablage, Snippets, Ports, Prozesse.
- Tasten 46 px breit (statt 32), Höhe unverändert. Beide Reihen scrollen seitlich, mit weicher Kante rechts.
- Dasselbe gilt für die einreihige kompakte Variante.

### Desk-Ansicht (aufgeklappt, Breite ≥ 700 und Grundhöhe > 600)
- Die bisherige Karten- und Spaltenansicht entfällt.
- Links eine flache Seitenleiste mit Gruppen je Gerät: Kopf mit Name, Ping und „+“ (neues Terminal auf diesem Gerät). Zeilen mit Buchstabe, Name, Ordner und Status (LÄUFT / FRAGE / BEREIT / FERTIG). Das aktive Terminal ist mit einem Streifen in Gerätefarbe markiert. Unten der Diktat-Status.
- Rechts ein Terminal über die volle Höhe, mit Kopfzeile, Tastenreihe und Eingabe wie in der kompakten Ansicht.
- **Schalter** zum Einfahren: 296 px ↔ 68 px (nur Buchstaben, Strich je Gerät, Status-Punkt), animiert über `@property --desk-side-w` in 360 ms. Der Zustand wird gemerkt.
- **Nie automatisch:** Die Tastatur ändert nichts an der Leiste. „Grundhöhe“ ist die größte gesehene Fensterhöhe bei dieser Breite.
- Geteilter Bildschirm (Fenster schon beim Start niedrig) bleibt die bisherige kompakte Ansicht ohne Seitenleiste.

### Karten mit Griff (Explorer, Zwischenablage, Snippets)
- Öffnen von unten auf der zuletzt gewählten Höhe (Start 58 %). Suche und Knöpfe liegen so im Daumenbereich.
- Griff oben:
  - **Ziehen** setzt die Höhe frei.
  - **Über 86 %** wird die Karte Vollbild (ohne Radius, bis unter die Statusleiste).
  - **Unter 30 %** schließt sie.
  - **Tipp** wechselt zwischen halb und voll.
- Die abgedunkelte Fläche darüber schließt die Karte beim Antippen. Desk: Die Karte liegt rechts neben der Seitenleiste.

### Datei-Explorer (ersetzt Dateien-Sheet und Vollbild-Explorer)
- Gerät = Gerät des Terminals vorne, als Chip im Kopf.
- Startet in `~/Desktop` (Windows: Desktop des Nutzerprofils). Fehlt der Ordner, startet er in `~`. Ort und letzte Liste werden pro Gerät gemerkt. Ein Gerätewechsel bei offener Karte zeigt sofort das gemerkte Gerät, dann die frische Liste.
- Kopf: ✕, „Dateien“ + Geräte-Chip, Neuer Ordner, Auswählen.
- Pfadzeile: ↑ (Icon), antippbare Brotkrumen ab `~`, `cd hier`.
- Darunter Suche (filtert im Ordner) und Zählzeile mit Sortierung (Name → Datum → Größe).
- Zeilen: farbiges SVG-Typ-Icon (Ordner, Bild, Video, PDF, Markdown, Code, ZIP, Text), Name, „Größe · Alter“. Ordner zuerst.
- **Tipp auf Datei = Vorschau**, unabhängig von der Größe:
  - Bild: `<img>` über `/files/download`.
  - Video: `<video>` mit Range-Streaming (Server kann Range bereits).
  - PDF: vorhandener pdf.js-Viewer.
  - Markdown: gerendert. Code und Text: mit Zeilennummern, die ersten 512 KB per neuem `/files/read?max=`, ohne 5-MB-Ablehnung, mit Hinweis „gekürzt“.
  - Vorschau-Leiste: Pfad einfügen, Teilen, Laden.
- **Langes Drücken = Menü.**
  - Datei: Vorschau, Pfad einfügen, Pfad kopieren, Teilen, Herunterladen, Auswählen, Umbenennen, In den Papierkorb.
  - Ordner: Öffnen, cd in diesen Ordner, Pfad einfügen, Pfad kopieren, Auswählen, Umbenennen, In den Papierkorb.
- **Mehrfachauswahl:** Haken links. Untere Leiste: Pfade einfügen, Herunterladen (ab 2 Dateien als ZIP), Teilen, Papierkorb.
- **Papierkorb immer mit Bestätigungsdialog:** „N Elemente in den Papierkorb?“ mit Namensliste (bis 50, dann „… und X weitere“) und dem Hinweis auf den Papierkorb des Geräts.
- Entfällt: Fullscreen-Toggle, alter Vollbild-Explorer (`openFilesScreen` zeigt auf die Karte).

### Zwischenablage (auf dem Handy)
- Speicher: neuer RN-Store (durableStorage), max. 200 Einträge. Angeheftete Einträge zählen nicht und werden nie automatisch gelöscht.
- Eintrag: `{ id, text, src: 'phone'|<serverId>, at, pinned }`.
- Quellen:
  - Handy-Kopien, wie bisher beim Öffnen der App gelesen.
  - Jedes verbundene Gerät, über den vorhandenen `clipboard:*`-Strom.
  - Doppelte Texte: der vorhandene Eintrag wandert nach oben.
- Oberfläche:
  - Karte mit Suche und Filter-Chips: Alle, Angeheftet, Heute, Gestern, 7 Tage, 30 Tage, vom Handy, je Gerät.
  - Sortierung umkehrbar. Abschnitte Angeheftet, Heute, Gestern, Letzte 7 Tage, Letzte 30 Tage, Älter.
  - Quelle als Icon in Gerätefarbe. Befehle und Pfade in Monospace.
- ↵ fügt ins Terminal vorne ein.
- Langes Drücken: Ins Terminal einfügen, Aufs Gerät kopieren (Gerät vorne), Anheften/Lösen, Als Snippet speichern, Löschen.
- Fuß: Anzahl, „Verlauf leeren“ (Angeheftete bleiben).
- Server-Verlauf (`~/.tms-terminal/clipboard.json`) wird nicht mehr als Wahrheit genutzt. Beim ersten Start wird er einmal vom bisherigen Hauptserver übernommen.

### Snippets (auf dem Handy)
- Neuer RN-Store (durableStorage) `{ id, name, cmd }`. Startet leer, die Demo-Snippets entfallen.
- Karte:
  - Leerzustand mit „Erstes Snippet anlegen“.
  - Formular mit Name und Befehl.
  - Liste mit ↵ (ins Terminal vorne).
  - Langes Drücken: Bearbeiten, Löschen.
  - Fußzeile: „bleibt bei App-Updates erhalten“.

### Notizen (auf dem Handy)
- `useNotesStore` nicht mehr pro `server.id`, sondern unter festem Schlüssel `bund`.
- Bestehende Notizen aller Server werden beim ersten Start zusammengeführt (nach Zeit, ohne doppelte Texte). Die Oberfläche bleibt.

### Bilder (Upload)
- Ablauf wie bisher: Die Galerie öffnet sich direkt, Mehrfachauswahl, Upload, Pfade ins Terminal.
- Neu: Ziel-Gerät **und** Ziel-Karte werden beim Antippen festgehalten. Der Upload geht an dieses Gerät, die Pfade in genau diese Karte, auch wenn zwischendurch gewechselt wird.
- Oben eine Fortschrittspille „N Bilder → Gerätename“. Das alte Screenshots-Sheet mit Kacheln entfällt.

### Diktat
- Server meldet Fähigkeiten in `/health` und bei Verbindungsaufbau: `caps: ['dictation']`, wenn der Whisper-Sidecar nutzbar ist (macOS mit .venv-mlx).
- Die App diktiert über das erste **online** Gerät mit `dictation`. Gibt es keins, ist der Mikro-Knopf ausgeblendet (Klasse `no-dictation`). Das Ergebnis geht ins Terminal vorne.

### Ping
- Ping alle 3 s, solange die App sichtbar ist (bisher 12 s).
- Anzeige = **Median der letzten 5 Rohwerte** statt EMA α 0,3.
- Der Wert gilt für das Gerät des Terminals vorne (Insel, Seitenleiste, Bund-Karte).

## Technische Leitplanken

- **Verbindungen:** Jedes gespeicherte Gerät mit Token bekommt `getConnection(id)` und wird parallel verbunden. Neu online kommende Geräte werden sofort aufgenommen, nicht erst im 20-s-Takt.
  - `S2ConnStore.server` ist nur noch ein technischer Anker für Altcode.
  - Keine Funktion darf ihn für Gerätebezogenes nutzen.
  - Die Seiten-Nachrichten dürfen nicht an `if (!wsService || !server) return` hängen.
- **`deviceFor(sessionId)` / `activeDevice()`** sind die einzigen Wege zu Server und Token:
  - `useSheetBridges` und `useFileExplorer` bekommen das aktive Gerät.
  - Ports und Prozesse gehen an das aktive Gerät.
  - `browserbridge:toggle` geht an alle Geräte.
  - `mac:unlock` bleibt pro Gerät.
- **Seite (Mockup):** Bund-CSS und Bund-JS kommen als eigene Dateien in `mockups/season2/liquid-deck/` (`bund.css`, `bund.js`). Das Build-Skript bündelt sie wie `compact-terminal.*` ein. Echte Daten kommen über die Bridge statt der Demo-Daten.
- **Server:** Manager-Ordner, Cron, Autopilot und Watcher-Dienst samt Protokoll-Typen entfernen. Prüfen, ob Autopilot nur vom Manager genutzt wird. Auto-Approve bleibt.
- Nach jedem Teil: `npm run build:season2`, `npm run test:mockup`, Server `npm test` + `tsc`, App `tsc`. Release über Tag-Push (CI).

## Reihenfolge

1. Server: caps in `/health`, Manager/Watcher raus, `/files/read?max=`.
2. App-Kern: Bund-Verbindungen, Routing über aktives Gerät, Ping, Diktat-Fähigkeit, Stores für Zwischenablage, Snippets und Notizen.
3. Seite: Bund-Übersicht, Leisten, Desk, Karten mit Griff, Explorer, Zwischenablage, Snippets, Upload-Pille. Bridge-Anbindung.
4. Release + Server-Neustart (Mac; Windows über `tms-terminal update`).

## Bewusste Entscheidungen (ohne Rückfrage)

- Gerätefarben: Lila `#9b8cff` (1. Gerät), Türkis `#3bc9db` (2.), Orange `#f59f00` (3.). Die Farbe hängt an der Position in der gespeicherten Liste.
- Ping-Median über 5 Werte. Die Karten-Starthöhe 58 % und Schwellen 30 % / 86 % stammen aus dem Mockup.
- Die Zwischenablage hält max. 200 Einträge plus beliebig viele angeheftete.
- Text-Vorschau zeigt höchstens 512 KB, gekennzeichnet.
