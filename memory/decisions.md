# Entscheidungslog

## Architektur

- **2026-04 · Kein TLS auf dem Server** — Tailscale VPN übernimmt die Verschlüsselung. Server nutzt `http.createServer()`, kein HTTPS. Begründung: Tailscale ist immer aktiv, doppelte Verschlüsselung unnötig.

- **2026-04 · xterm.js mit Canvas Renderer** — Performance-kritisch auf dem Fold 7. WebGL war zu instabil, DOM Renderer zu langsam. Canvas ist der Sweet Spot.

- **2026-04 · Zustand statt Redux** — Leichtgewichtiger, weniger Boilerplate. Passt besser zu der Größe des Projekts. Alle Stores nutzen `persist` + AsyncStorage.

- **2026-04 · WebView-basiertes Terminal statt native xterm** — React Native hat keine native Terminal-Komponente. WebView + xterm.js + Shadow Input ist der Standard-Ansatz. Keyboard-Steuerung über Shadow Input im WebView.

- **2026-04 · release.sh + GitHub Releases für Auto-Update** — Kein App Store nötig. App prüft GitHub API auf neue Releases, zeigt Update-Banner, User tappt → APK Download → Android Installer.

## Manager Agent

- **2026-04-08 · Claude CLI statt API für Claude Provider** — Spawnt `claude -p` als Subprocess. Nutzt lokale Auth, kein API Key nötig. Gleicher Ansatz wie im Autopilot-Service.

- **2026-04-08 · Conversational statt Wizard Onboarding** — User wollte natürliches Kennenlernen statt Formular. AI erkennt selbst wann genug Info da ist, extrahiert Personality-Config über `[PERSONALITY_CONFIG]` Block.

- **2026-04-08 · Terminal Context Analysis server-seitig** — Output wird vor dem Senden an die AI analysiert: Tool-Erkennung (Claude, npm, Docker, etc.), Projekt-Typ, Status (idle/active/error). AI bekommt strukturierten Kontext statt rohem Output.

- **2026-04-10 · Claude CLI Provider entfernt** — Nur noch GLM-5-Turbo (Default) und Kimi Code. Claude CLI war unzuverlässig für Tool-Ausführung und hatte keinen Streaming-Support.

- **2026-04-10 · Native Tool Calling statt Custom-Tags** — GLM-5-Turbo bekommt `write_to_terminal` und `send_enter` als OpenAI-kompatible Function Definitions via `tools` API-Parameter. 0.67% Fehlerrate vs >50% mit Custom-Tags im Prompt. Memory-Tags bleiben als Text (Hybrid).

- **2026-04-10 · Regex Command-Parser entfernt** — `tryExecuteCommand()` fing normalen Text ab (z.B. Wort "Agent" in Anführungszeichen → als Befehl interpretiert). Komplett gelöscht. Alle Befehle laufen jetzt über GLM's native Tool Calling.

- **2026-04-10 · Tools immer an GLM senden** — Kein Onboarding-Guard. GLM bekommt `tools` + `tool_choice: 'auto'` bei jeder Nachricht und entscheidet selbst wann es Tools nutzt. ONBOARDING_PROMPT erwähnt keine Tool-Namen → kein Halluzinations-Risiko.

- **2026-04-26 · Manager Chat Redesign — finales Konzept (v8)** — Nach 8 Iterationen mit je 3 Varianten in HTML-Mockups (siehe `prototype/manager-chat-redesign/`). Final ist `v8-tools-direct.html`. Architektur:
  - **Header (~42px)**: Avatar 36×36 mit Status-Eck-Dot, Name + Modell-Pille + Tasks-Mini alles in einer Zeile. ⋮-Menü enthält: Voice Mode (gefeatured), Suche, Manager-Toggle, Memory, Settings, Chat-löschen.
  - **Group-Tabs-Bar** (~32px): Speichert Pane-Konfigurationen als benannte Gruppen (Default/Debug/Deploy etc.) mit Farb-Dots. Inline-Save via "+", Delete via Hover-×.
  - **Tool-Sidebar** (44px collapsed / 144px expanded): Ersetzt die früheren Stage-Manager-Rail-Konzepte. 6 Tools: 🔧 Werkzeuge, ⚡ Quick Actions, 📋 Snippets, 🗂 Files, 🔍 Search, 🤖 AI. Klick öffnet Flyout-Panel mit Tool-Inhalt. Stage-Manager wurde redundant da die untere Term-Chip-Bar bereits alle Terminals zeigt.
  - **Multi-Spotlight** mit 1/2/4 Toggle (Multi-Konzept aus R3). Pane-Click setzt activePane für Tool-Context und Direct-Mode-Target.
  - **Term-Chip-Bar** unten (Original-Design): "Alle" + S1·..·Sn Chips, klickbar zum Pane-Wechsel.
  - **Direct-Terminal-Mode im Input**: Mode-Toggle 💬↔▶ links neben Bild-Icon. Im Terminal-Mode wechselt Input zu mono-Font + grünem Send-Button + Prefix `@<active-pane> ▶`. Befehl + Enter → wird direkt ins aktive Pane gepusht (Flash-Animation).
  - **Voice Mode** (Live-Conversation, eigenes Icon): aus ⋮-Menü, transformiert Header (Avatar pinkt, Status-Zeile mit Live-Timer, Hangup-Pille) + Vollbild Orb-Overlay.
  - **Transkription** (Speech-to-Text): Bottom-Mic, Banner über Input mit Confidence-Bar, Sprache, drei Buttons (Cancel / In Input / Direkt).
  - **Theme**: 1:1 Original `theme.ts` Tokens (Slate-900 BG, Surface-Stack, Slate-Border-Hairlines, Mono-Font Menlo). Pro Terminal eindeutige Farbe (10 Farben pre-defined).
  - **Iterations-Begründung**: User-Präferenz für Multi-Spotlight + Native-Look + minimal Top + Tools-Sidebar + Direct-Eingabe.
  Wichtig für Implementation: Group-Tabs sind ein NEUES Feature ohne Backend-Equivalent — braucht neue store-keys (gespeicherte Gruppen mit terminals[]). Tool-Sidebar ist UI-only, Tools selbst wären eigene Components mit jeweiligem Flyout-Inhalt.

## Memory System

- **2026-04-08 · Git-basiertes Memory statt Datenbank** — 5 Markdown-Dateien in `memory/`, Git-getrackt. Einfach, portabel, keine extra Infrastruktur. CLAUDE.md enthält Anweisungen zum Lesen/Schreiben.

- **2026-04-08 · journal.md als Append-Only Log** — Chronologisches Protokoll, max 100 Einträge, danach Archivierung. Alle anderen Dateien werden überschrieben/aktualisiert.
