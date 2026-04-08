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

## Memory System

- **2026-04-08 · Git-basiertes Memory statt Datenbank** — 5 Markdown-Dateien in `memory/`, Git-getrackt. Einfach, portabel, keine extra Infrastruktur. CLAUDE.md enthält Anweisungen zum Lesen/Schreiben.

- **2026-04-08 · journal.md als Append-Only Log** — Chronologisches Protokoll, max 100 Einträge, danach Archivierung. Alle anderen Dateien werden überschrieben/aktualisiert.
