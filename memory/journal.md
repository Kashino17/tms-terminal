# Session-Tagebuch

## 2026-04-26 — Voice Prompt Enhancer (v1.21.3)

### Was wurde gemacht
- Neue lokale Llama 3.2 3B Instruct (MLX) Sidecar-Pipeline, optional zwischen Whisper-Output und Mobile.
- Branch `feat/voice-prompt-enhancer` von master abgezweigt; 6 chirurgische Feature-Commits:
  1. `ffeacec` — Protocol-Flag `enhance?: boolean` in `AudioTranscribeMessage.payload`
  2. `b592b24` — `server/audio/prompt_rewriter_sidecar.py` (Llama 3.2 3B 4-bit MLX, JSON-Lines stdin/stdout)
  3. `fde1001` — TS-Wrapper `server/src/audio/prompt-rewriter-sidecar.ts` (mirrors whisper-sidecar) + 3 unit tests
  4. `512f6a1` — `shutdownRewriter()` in graceful-shutdown closure
  5. `408b21e` — `ws.handler.ts:audio:transcribe` Routing mit `enhance === true` strict check + soft-fall-back zu raw Whisper text
  6. `a984af9` — Settings-Store-Flag `voicePromptEnhanceEnabled` (persisted via Zustand+AsyncStorage, default false)
  7. `ffcf21e` — Neue "Sprache" Section in SettingsScreen mit "KI-Prompt-Modus" Switch
  8. `3de2be4` — `enhance: voicePromptEnhanceEnabled` in allen 3 Send-Sites (TerminalToolbar, OrbLayer, ManagerChatScreen)
- `superpowers:writing-plans` für die Spec, dann `superpowers:subagent-driven-development` für die Ausführung mit per-chunk Spec+Quality-Reviews. Final-Aggregat-Review = "Ready for manual E2E".
- Smoke-Test bestätigt: `"also ähm ich will halt das git status ausgeführt wird sozusagen weißt du"` → `"Ausführen des Git-Status"` (Filler-Words entfernt, Intent erhalten, Deutsch erhalten).

### Was lief gut
- Sidecar-Architektur gespiegelt 1:1 vom existierenden whisper-sidecar/tts-sidecar — keine neuen Patterns nötig, einfach zu maintainen.
- Soft-Fall-Back im Server (try/catch um `rewritePrompt`, fallback auf rohen Text) verhindert dass die Mobile-UI hängt wenn der Rewriter mal kaputt ist.
- Plan war so präskriptiv (jede Code-Zeile spezifiziert) dass der Implementer-Subagent sehr schnell war und Reviewer wenig zu beanstanden hatten.
- `payload.enhance === true` strict check — `false`/`undefined`/non-bool gehen alle in den Legacy-Path → null Risiko für bestehende User mit Toggle off.

### Was war schwierig
- Branch-Realität vs Plan-Annahmen: Plan referenzierte `shutdownTts` und `WhisperBusyError`, die auf parallelen unreleased Branches existieren aber nicht auf master. Implementer-Subagent hat sich korrekt angepasst (DONE_WITH_CONCERNS) und die Anpassungen explizit dokumentiert.
- Master ist deutlich hinter den verschiedenen Feature-Branches — `app.json` zeigte 1.18.7 obwohl GH-Release schon bei v1.21.2 war. Vor dem Release musste app.json + build.gradle auf 1.21.2 ge-syncht werden, damit der Patch-Bump auf v1.21.3 geht.
- Final-Code-Reviewer-Subagent crashte beim ersten Versuch mit `API Error: Unable to connect to API (ConnectionRefused)` nach 16 min Laufzeit — Anthropic-API-Blip. Retry war erfolgreich.

### Entscheidungen
- Modell: **Llama 3.2 3B Instruct (4-bit MLX)** — Sweet-Spot zwischen Speed (~80-300ms nach Warmup) und Qualität. Alternatives waren Qwen 2.5 1.5B (schneller, weniger schlau) oder das existierende Manager-Modell Qwen 3 Coder 30B (Overkill, blockiert das Manager-Modell).
- Toggle-Ort: Settings-Screen-Switch (nicht Toolbar-Pill) — User-Wahl. Greift gleichermaßen für Terminal-Mic, Floating-Orb-Mic und Manager-Chat-Mic (kein Trennen Terminal/Chat).
- Output-Path: rewritten Text landet ins Eingabefeld, User editiert + drückt Enter selbst — nicht direkt versendet. User-Wahl.
- Soft-Fall-Back im Server (nicht im Wrapper): bei `rewritePrompt`-Fehler wird der rohe Whisper-Text als `audio:transcription` rausgeschickt. Wrapper bleibt ehrlich über Fehler, Server schützt UX.
- Branch nicht zu master gemerged — andere unreleased Branches (fix/manager-memory-leaks etc.) müssen vom User später reconciled werden, sonst geht deren Server-Work verloren.

### Offene Fragen
- Wie soll das Multi-Branch-Geflecht (`feat/voice-prompt-enhancer`, `fix/manager-memory-leaks`, `feat/cloud-observer`, `feat/chrome-remote-control`) zusammengeführt werden? Aktuell zieht `tms-terminal update` nur einen Branch.
- Code-Review-Follow-ups (alle minor): 4. Test für `child.on('exit')` Path, Tighten busy-error Test, `SIGTERM` für graceful shutdown statt `SIGKILL`, optional unused `isBusy()` export entfernen.

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
