# Session-Tagebuch

## 2026-04-23 — Model-Load-Status + bessere leere-Antwort-Fallbacks (v1.19.0)

### Was wurde gemacht
- Neuer WS-Event `manager:model_status` (`shared/protocol.ts`): Server streamt `loading | ready | error` + `elapsedMs` + optional `message` (Progress-% oder Fehlertext)
- `LmStudioController.switchTo(modelId, onStatus?)` wartet jetzt wirklich auf `lms load`, emittiert Status alle 500ms über Intervall-Timer, parst `XX%` aus stdout/stderr
- `AiProviderRegistry.setOnModelStatus()` tagt Events mit `providerId` und reicht an `ManagerService.setOnModelStatus()` durch; `ws.handler.ts` broadcastet sie via `sendManager()` (nutzt bestehenden Buffer bei Disconnect)
- Mobile: `modelStatus` state im Store, Banner mit Timer über Input-Leiste (`Lade Rem… 0:12 · 45%`), Input disabled während `loading`, Online-Dot im Header pulsiert 2× (`Animated.sequence` auf scale 1↔1.8) bei `ready` und wird nach 2s gecleart
- Empty-Reply-Fallback (`manager.service.ts:2172`): wenn `cleanReply` leer aber `memUpdate` gesetzt → `📝 Notiert: <erster learnedFact/insight>`, sonst `🤔 Ich hab keine Antwort formuliert — frag mich nochmal.` (statt generischem "Verstanden")
- `max_tokens` in allen 3 LMStudioProvider-Callsites von 4096 → `LOCAL_MAX_OUTPUT_TOKENS = 16384`

### Root-Cause (aus Screenshot vom 23.4. 23:47)
1. **"Verstanden" Nachrichten**: Gemma 4 produziert bei "Hi" nur `[MEMORY_UPDATE]`-Block ohne Prose → nach `stripMemoryTags()` leer → Fallback-String
2. **60s Timeouts**: `setActive()` rief `lmStudio.switchTo(...).catch(() => {})` fire-and-forget auf, Client bekam sofort `manager:providers` mit `active: gemma-4` und glaubte Model sei bereit → erste Message lief in 60s Idle-Timeout weil Model noch lud

### User-Entscheidungen
- Lade-Anzeige: **(a)** ehrlicher Elapsed-Timer — kein Fake-Progressbar
- Ready-Feedback: **(z)** pulsierender grüner Online-Dot — kein Chat-System-Message, kein Toast

### Notes
- `echo y | ./release.sh minor` pipte stdin nicht durch `read -p` → Commit+Tag+Push+gh-release musste manuell nachgeholt werden
- GitHub Release v1.19.0 mit APK: https://github.com/Kashino17/tms-terminal/releases/tag/v1.19.0

## 2026-04-22 (noch später) — Qwen 3 Coder 30B + Qwen 3.6 35B mit Auto Load/Unload (v1.18.10)

### Was wurde gemacht
- Zwei neue lokale Provider registriert im `AiProviderRegistry`: `qwen-27b` → `qwen/qwen3-coder-30b`, `qwen-35b` → `qwen/qwen3.6-35b-a3b`
- Neuer `LmStudioController` (`server/src/manager/lmstudio.controller.ts`): spawnt `lms` CLI für load/unload, serialisiert Operationen via Promise-Queue, findet Binary an 4 Standardpfaden (`~/.lmstudio/bin/lms` primär)
- `setActive()` erweitert: bei Wechsel auf lokalen Provider → `lms unload --all` + `lms load <id>`; bei Cloud-Provider → `unload --all` (VRAM frei)
- Initial-Sync im Constructor: beim Server-Start wird der aktive Provider in LM Studio aktiviert
- `ProviderConfig.localModels` öffnet Override via `~/.tms-terminal/manager.json`
- Mobile: `QWEN_CAPS` Badges (Tools/Reasoning/Code) für neue Provider, Fuzzy-Fallback auf `id.includes('qwen')`
- `switch_model` Tool-Description aktualisiert mit neuen Provider-IDs

### User-Entscheidung
- User-eigene Benennung beibehalten: "Qwen 3.6 35B" (existiert wirklich als `qwen/qwen3.6-35b-a3b` auf Users LM Studio), "27B" als Label für die 30B MoE akzeptiert
- Promise-Queue-Serialisierung gewählt statt `lms ps`-Check (Overhead gespart, User klickt nicht manuell in LM Studio)

### Notes
- Build-Fehler beim ersten Release-Versuch: Gradle-Daemon kaputt → `./gradlew --stop` + Retry klappte
- GitHub Release v1.18.10 mit APK attached: https://github.com/Kashino17/tms-terminal/releases/tag/v1.18.10

## 2026-04-22 (später) — Manager-Agent Timeout-Fix (v1.18.9)

### Was wurde gemacht
- Root-Cause: `ai-provider.ts` hatte `LOCAL_TIMEOUT_MS = 180_000` als **absoluten** AbortSignal.timeout() auf LM-Studio-Streams → Gemma 4 31B wurde nach 3min abgebrochen obwohl aktiv generierend
- Neuer `createStreamTimeout()` Helper: kombiniert Idle-Timeout (60s zwischen Tokens) + Hard-Ceiling (30min absolut) + optional User-Cancel-Signal
- Applied auf `chatStream()` und `chatStreamWithTools()` im `LMStudioProvider` — `touch()` bei jedem Stream-Chunk
- Error-Messages deutsch und informativ: "Modell reagiert nicht mehr (60s kein Token)"

### Symptom (aus User-Screenshots)
- Manager "Rem" (Gemma 4 31B local) antwortete mit "⚠️ The operation was aborted due to timeout" bei Dauer 180-190s
- Fehler war undurchsichtig (native Undici-Error)

## 2026-04-22 — Transkription & Auto-Approve robuster gemacht (v1.18.8)

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
