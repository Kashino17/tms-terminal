# Session-Tagebuch

## 2026-04-22 — Transkription & Auto-Approve robuster gemacht (v1.15.1)

### Was wurde gemacht
- **Whisper-Transkription:** Nur noch `turbo` Model preloaded (kein Cold-Model-Swap-Hang mehr beim ersten langen Audio), Busy-Lock (strikt ein Request gleichzeitig, wie User gewünscht), Hard-Kill via SIGKILL bei Timeout (MPS ignoriert SIGTERM) damit keine Zombie-Requests entstehen
- **Mobile Mic-Watchdog:** 60s Safety-Timer in OrbLayer, TerminalToolbar, ManagerChatScreen — Mic-Button kann nie mehr forever auf "processing" hängen; Busy-Error wird silently ignored (anderer Screen arbeitet noch); normale Errors zeigen Toast/Alert
- **Auto-Approve Prompt-Detector komplett umgebaut:** Match läuft jetzt auf JEDEM Feed (50ms Debounce) statt nur bei Silence — das war der Hauptbug, weil Claude Code Spinner-Frames den Silence-Timer dauerhaft resetten
- **Weitere Auto-Approve-Fixes:** Startup-Grace 5s → 1.5s (erste Anfrage wird jetzt erkannt), Buffer 1200 → 3000 chars (lange Claude-Boxen passen), Scan-Tail 600 → 1200, Tail-Hash-Dedup verhindert doppeltes Enter, neue `noteApproved()` API leert Buffer nach Auto-Enter

### User-Entscheidungen (wichtig für zukünftige Arbeit)
- Transkription: nur `turbo` Modell, kein dynamisches Switching
- Bei Fehler: einfach melden, User klickt nochmal (kein Auto-Retry)
- Nur eine Transkription parallel, strikter Busy-Lock

## 2026-04-10 — Activity Indicator, Streaming, Native Tool Calling

### Was wurde gemacht
- **v1.14.0:** ThinkingBubble mit Phasen-Anzeige (analyzing → building → calling → streaming → executing), Live-Timer, Token-Streaming via WebSocket, Phase-Popup mit Dauer pro Phase
- **v1.14.0:** Claude CLI Provider komplett entfernt, GLM als Default, nur noch GLM + Kimi
- **v1.15.0:** Native Tool Calling für GLM-5-Turbo — `write_to_terminal` + `send_enter` als Function Tools statt Custom-Tags
- **v1.15.0:** Model ID `glm-4-plus` → `glm-5-turbo`
- **v1.15.0:** Stale Output Buffer Detection (>60s ohne neues Output → idle)
- Regex-basierten Command-Parser (`tryExecuteCommand`) komplett entfernt — war Hauptursache für falsche Tool-Ausführungen
- System-Prompt gekürzt: 26 Zeilen Tag-Doku → 6 Zeilen Tool-Referenz
- 2 GitHub Releases erstellt und deployed

### Was lief gut
- Streaming-Architektur (WebSocket-basiert) sauber implementiert
- GLM-5-Turbo Recherche hat gezeigt, dass natives Tool Calling die richtige Lösung ist (0.67% Fehlerrate)
- Subagent-Driven Development für 13+ Tasks effizient durchgeführt

### Was war schwierig
- 4+ Stunden Debugging weil `tryExecuteCommand` Regex-Parser Text wie "Agent" in normalen Sätzen abfing
- Stale-Build-Problem: Fix war im TypeScript-Source aber `dist/` nie neu gebaut
- Onboarding-Guard für Tools war zu restriktiv — GLM konnte nach Onboarding keine Tools nutzen
- Mehrere Iterationen nötig bis Tool Calling korrekt funktionierte

### Entscheidungen
- Regex-Command-Parser entfernt zugunsten von nativem Tool Calling
- Tools werden IMMER an GLM gesendet (kein Onboarding-Guard), GLM entscheidet autonom
- `tool_choice: 'auto'` immer gesetzt
- Memory-Tags bleiben als Text (Hybrid-Ansatz), nur Terminal-Actions als native Tools

### Offene Fragen
- Shell-Labels "Shell 1/2/3" vs echte Terminal-Namen — nächstes Feature

## 2026-04-08 — Manager Agent + Memory System

### Was wurde gemacht
- Manager Agent komplett implementiert (v1.12.0): AI Provider Abstraction, Manager Service, Chat Screen, WebSocket Protocol Extension, Zustand Store
- Personality System + intelligente Terminal-Analyse (v1.12.1): 5 Tone-Modi, dynamischer System-Prompt, Tool/Projekt/Status-Erkennung
- Wizard-Onboarding durch natürlichen Chat ersetzt (v1.12.2)
- Image Attachments im Manager Chat, API-Key Settings UI
- Memory-System aufgesetzt (5 Dateien in memory/)
- Keyboard-Unterdrückung bei offenen Tool-Panels (TerminalView panelOpen prop)

### Was lief gut
- Alle 7 Phasen des Manager Agents in einer Session implementiert
- TypeScript kompiliert bei jedem Schritt sauber
- Release-Workflow (commit → build → tag → push → gh release) funktioniert reibungslos
- git push Fix mit `GIT_TERMINAL_PROMPT=0` gefunden

### Was war schwierig
- git push hing anfangs (HTTPS Credential Helper wartete auf Input)
- Model-IDs für Kimi K2.5 und GLM 5.0 konnten nicht verifiziert werden (post Knowledge-Cutoff)

### Offene Fragen
- Wie verhält sich der conversational Onboarding-Flow in der Praxis? Findet die AI den richtigen Moment für den CONFIG-Block?
- Server-Update auf Produktiv-Server steht noch aus
