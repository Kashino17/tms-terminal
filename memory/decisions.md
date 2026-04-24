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

## Memory System

- **2026-04-08 · Git-basiertes Memory statt Datenbank** — 5 Markdown-Dateien in `memory/`, Git-getrackt. Einfach, portabel, keine extra Infrastruktur. CLAUDE.md enthält Anweisungen zum Lesen/Schreiben.

- **2026-04-08 · journal.md als Append-Only Log** — Chronologisches Protokoll, max 100 Einträge, danach Archivierung. Alle anderen Dateien werden überschrieben/aktualisiert.

## Push-Benachrichtigungen

- **2026-04-24 · PUSH_INSTANT_MODE Feature-Flag** — Bypasst `ManagerPushDecider` (v1.20.0) komplett: kein Screen-State-Check, kein 3s-Debounce, kein 15s-Stale-Window. Jede Manager-LLM-Response + jede Tool-Completion (manager-side UND terminal-side AI-Tools via prompt.detector) feuert sofort FCM. User-Entscheidung: „Einfach sofort pushen, ohne Debounce." Flag gesetzt via `~/.tms-terminal/manager.json` → `pushInstantMode: true` oder env `PUSH_INSTANT_MODE=1`. Decider-Klasse + Tests bleiben erhalten — flag-bypass statt delete, damit Rollback ein One-Liner ist. Payload-Design: Titel = `{✓|✗} {toolName}`, Body = letzte 300 chars Output, data.type = `tool_completion`. Failure-Detection für Terminal-Output ist heuristisch (regex auf error/failed/fatal/command not found/permission denied) — kein echter Exit-Code auf PTY-Ebene verfügbar.
