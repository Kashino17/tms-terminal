# Session-Tagebuch

## 2026-04-23 — Voice Mode UX Polish (v1.20.2)

### Was wurde gemacht
User-Feedback nach dem v1.20.0-Voice-Chat: "total buggy — fehlen Animationen für Pause/Play, Text-Overlay geht über das ganze Display, unklar wann KI denkt vs zuhört, nicht intuitiv, fühle mich überfordert". Zusätzlich: **Self-Interruption auf Lautsprecher** — Rem hört ihre eigene Stimme über den Speaker, VAD triggert, Server transkribiert Rem als User-Input → Endlos-Loop.

Komplette Brainstorming-Runde mit visuellem Companion über Tailscale (Mockups direkt auf dem Fold gezeigt), dann Spec + 13-Task-Plan + Subagent-Driven-Execution.

**14 Commits auf feat/chrome-remote-control** (Base `0a29bf2` → Head `461771d`):

**Echo-Mitigation (4 Layer):**
- `bec0e67` Server: 800ms-Guard discards Transcripts nach letztem TTS-Chunk
- `3712b29` Server: 3-in-60s Warning "Kopfhörer empfohlen" (auch fixed: `logger.debug` existiert nicht im Projekt-Logger → `logger.info`, hätte sonst silent gethrownt)
- `d1be837` Mobile: Android `audioSource: 7` (VOICE_COMMUNICATION → HW AEC/NS/AGC) + VAD `-40dB → -32dB` + 150ms-Sustain-Check
- `239c68a` Mobile: 600ms Cooldown bei `speaking → listening` via `listeningWarmup` Store-Flag
- `b99cdfd` Mobile Fix: nach `endTurn` lokal `setPhase('transcribing')` — sonst blieb Recorder tot bei Server-Echo-Suppression (zustand notifiziert keine Subscriber bei same-value set)

**UI-Polish:**
- `af8cdf2` + `a367f65` Neue `PhaseHint`-Komponente: 7 Phasen mit Fraunces-Italic Primary + Bricolage-Uppercase Secondary, Cross-Fade mit Y-Offset, Race-safe via `animRef.stop()`
- `5feb53c` PhaseHint zwischen CharacterWebView und SubtitleOverlay eingehängt
- `287ec85` Subtitle-Scrim: 3 gestapelte Views mit Alpha 0.28/0.35/0.45 (Pseudo-Gradient, keine neuen Deps — RN hat kein natives `radial-gradient`)
- `19f0c88` 3-Zeilen Teleprompter-Scroll: `onLayout` auf aktivem Wort + `Animated.timing` translateY
- `b82d066` User-Chip nur in `listening`/`transcribing` (nicht mehr in `thinking`), container-gap 6→2
- `396c202` + `abc98a7` Primary-Button: Icon-Crossfade + Rotate + Ripple + `impactLight`-Haptic; Mic-Button = Force-Turn-End (nur in `speaking`/`thinking` aktiv, "unterbrechen"-Label, `impactMedium`)
- `461771d` Close-Button 2-Tap-Confirmation mit Pill "Nochmal tippen zum Beenden"

### Ergebnisse
- 7/7 Server-Tests grün (5 bestehend + 2 neu: 3-in-60s Emission, 1-pro-Window)
- `tsc --noEmit` auf mobile sauber
- Full-Branch Code-Review: **Ship it** — keine Critical oder Important Issues
- Subagent-Driven-Development-Skill genutzt: pro Task Implementer + Spec-Reviewer + Code-Quality-Reviewer

### Learnings für Memory
- Projekt-Logger hat nur `info/success/warn/error` (kein `debug`) — wichtig für zukünftige Server-Tasks
- Zustand mit Primitive-Werten: `set({ x: same })` notifiziert KEINE Subscriber → wenn Effects auf Phase-Events reagieren müssen, lokal vorher ändern oder Server muss echten Phase-Wechsel emittieren
- React Native hat kein natives `radial-gradient` → stacked-alpha-Views sind der Workaround ohne neue Deps
- `react-native-reanimated` ist NICHT im Projekt — `Animated` aus `react-native` reicht für UI-Polish
- Visual Companion läuft über Tailscale-IP + `--host 0.0.0.0 --url-host <tailscale-ip>` → Mockups direkt am Fold sichtbar

## 2026-04-23 — Expandable Push Notifications Polish (I-2, I-3, M-1, M-2, M-5, M-7)

### Was wurde gemacht
Nach dem finalen Code-Review wurden die verbliebenen Polish-Issues adressiert:

- **I-3**: `ManagerService` bekommt einen public `get agentName(): string` Getter. `ws.handler.ts` nutzt jetzt `managerService.agentName` statt `(managerService as any).personality?.agentName` — Typ-Loch geschlossen.
- **M-1**: Doppelte Imports aus `fcm.service` in `ws.handler.ts` gemerged zu einer Zeile (`fcmService, stripMarkdownForPush`).
- **M-2**: `PUSH_BODY_CHAR_LIMIT = 800` als Konstante exportiert aus `fcm.service.ts` (Server) und definiert in `managerNotifications.service.ts` (Mobile, eigene Runtime). Alle `800`-Literals durch die Konstante ersetzt.
- **M-5**: Kommentar an `useEffect([])` in ManagerChatScreen — erklärt warum empty-deps trotz `wsService`-Closure korrekt sind (stable via `route.params`). Und Caveat-Kommentar zu `_chatScreenActive` Single-Mount-Annahme.
- **I-2** (Spec-Klärung): Szenario #6 und #9 im Test-Plan waren widersprüchlich (globaler Debounce vs per-Session). Entscheidung: globaler 3s-Debounce bleibt — Spec + Plan Szenario #6 umformuliert zu "Max 1 Push pro 3s; 2 Pushes nur wenn Replies ≥3s auseinander".
- **M-7**: Plan-Pfad `mobile/src/stores/` → `mobile/src/store/` (singular) korrigiert.
- `tsc --noEmit` server + mobile grün. 33/33 Tests pass. Commits: `b8d3e43` (code polish), `abb8fb7` (docs).

## 2026-04-23 — Code-Review-Fixes: C-1, I-1, M-6 (Push Notifications)

### Was wurde gemacht
- **C-1 (Critical):** Cold-start crash bei Manager-Push-Tap behoben — `navigate('ManagerChat' as never)` durch pending-flag-Pattern ersetzt. `setPendingManagerChatOpen` / `consumePendingManagerChatOpen` zu `notifications.service.ts` hinzugefügt. `App.tsx` setzt nur noch das Flag. `TerminalScreen` konsumiert das Flag sobald `connState === 'connected'` und navigiert mit vollständigen Route-Params.
- **I-1 (Important):** Foreground-Handler fall-through auf non-Android behoben — iOS/fallback `scheduleNotificationAsync` + `return` in `manager_reply`-Branch eingefügt, sodass kein Fall-through zur generischen Notification passiert.
- **M-6 (Defense-in-depth):** `isChatScreenActive()` aus `managerNotifications.service.ts` exportiert und am Anfang des Foreground-`manager_reply`-Handlers als Guard eingesetzt (gegen Race-Condition wenn FCM bei offenem Chat-Screen ankommt).
- `tsc --noEmit`: exit 0 (keine Fehler)
- Commit: `64b6088`

## 2026-04-23 — T5+T6: ManagerPushDecider (Expandable Push Notifications)

### Was wurde gemacht
- `server/test/notify-manager-reply.test.ts` erstellt: 11 Tests für `ManagerPushDecider` (shouldPush, debounce, generateMessageId) — TDD: erst FAIL committed (`563987b`)
- `server/src/notifications/manager-push.ts` erstellt: `ManagerPushDecider`-Klasse mit injizierbarer Clock, Screen-State-Staleness (15s), Per-Session-Debounce (3s), `generateMessageId()` (`mr_<ts>_<6-char-random>`)
- Alle 11 Tests grün; Commit `2dc2975`
- Regex `/^mr_\d+_[a-z0-9]{6}$/` — kein Problem mit `Math.random().toString(36).slice(2,8)` aufgetreten, alle Tests bestanden

## 2026-04-23 — Voice Chat Feature (v1.20.0 ready for release)

### Was wurde gemacht
20-Task-Plan erfolgreich via subagent-driven-development abgearbeitet. Alle Commits in einer Kette auf `feat/chrome-remote-control`, beginnend mit `58e5c45` (T1) bis `ed59822` (T19) plus `518fd37` (font-fix). Gesamt ~25 Commits.

**Server:**
- `voice.controller.ts` — State-Machine mit Phasen (idle/listening/transcribing/thinking/tool_call/speaking/paused), orchestriert Whisper → LLM-Stream → SentenceBuffer → chunked TTS → WS-Emit
- `voice.sentences.ts` — SentenceBuffer (7/7 tests) splittet streaming LLM-Output an `.`/`!`/`?`, ignoriert Dezimalpunkte
- `voice.ack-audio.ts` — Pre-generiert 6 ack-audio Varianten bei Server-Start, cached in `~/.tms-terminal/voice-samples/`
- `tts-sidecar.ts` + `tts_sidecar.py` — emittieren per-chunk Audio (`synthesizeChunked()`)
- `ws.handler.ts` — routet alle voice:* Messages (7 client→server, 6 server→client)
- `manager.service.ts` — createVoiceSession() factory, setProvider() blockt bei aktivem Turn
- HTTP endpoints `/voice-videos/:name.mp4` + `/voice-character.html` in `index.ts`

**Mobile:**
- `AudioPlayerQueue.ts` (3/3 tests) — pausable base64-WAV Queue via expo-av
- `VoiceClient.ts` — thin WS wrapper mit typed handlers
- `useVadRecorder.ts` — VAD mit 800ms/-40dB silence-Detection
- `voiceStore.ts` — Zustand state (phase, subtitles, karaoke word count, errors, interjection)
- `VoiceScreen.tsx` — orchestriert alle Components, AppState auto-pause bei background
- `CharacterWebView.tsx` — lädt bundled HTML, postMessage-Bridge für Phase-Sync
- `SubtitleOverlay.tsx` — Karaoke-Highlight (bone → copper glow → bone-dim)
- `VoiceControls.tsx`, `ResumeOptions.tsx`, `StatusPill.tsx`
- `assets/voice-character/index.html` — adapted from `prototype/voice-design/index.html`, transparent bg, phases via `dataset.phase`
- Fonts: Fraunces_400Regular_Italic (AI-Speech) + BricolageGrotesque_{400,500,600} (UI)
- Mic-Button in ManagerChatScreen-Header → navigiert zu VoiceScreen

### Architektur-Entscheidungen
- Server-Side State (VoiceSessionController) = Single Source of Truth, Mobile spiegelt
- Sentence-Chunking im JS (SentenceBuffer) UND Python (split_sentences) — Doppel-Split akzeptiert, `isLast`-Sentinel macht Client robust
- WebView-basiertes Character-Rendering für 1:1-Treue zum approved Mockup
- VAD "record-until-silence, upload-full-WAV" — expo-av streaming ist unreliable
- Fraunces Italic als Signatur für AI-Voice vs Bricolage Grotesque für UI

### Nächste Schritte (User)
1. Server neu starten (`tms-terminal update` oder manueller restart) — neue ack-audios werden erstmalig generiert (~10-30s F5-TTS runtime)
2. Mobile APK bauen: `cd mobile && ./release.sh minor` (v1.19.0 → v1.20.0)
3. Auf Samsung Fold 7 installieren
4. Manuelle Tests durchlaufen (siehe Spec "Manual test checklist")
5. Videos optional: MP4-Dateien in `~/.tms-terminal/voice-videos/` ablegen (idle.mp4, listening.mp4, thinking.mp4, tool_call.mp4, speaking.mp4, paused.mp4)

### Notes
- Font-Name-Fix: SubtitleOverlay nutzte `Fraunces_400Italic`, der Export heißt aber `Fraunces_400Regular_Italic` (`518fd37`)
- Jest + babel-jest + babel-preset-expo als test framework für mobile (neuer Setup)
- `.html` zu metro `assetExts` hinzugefügt damit bundler die Character-HTML included

## 2026-04-23 — T19: Error handling + edge cases

### Was wurde gemacht
- `manager.service.ts`: Guard in `setProvider()` — wirft Error wenn `activeVoiceSession?.isBusy()` true ist (Provider-Wechsel während aktivem Voice-Turn blockiert)
- `VoiceScreen.tsx`: `AppState` Import hinzugefügt, `useEffect` für Auto-Pause wenn App in Hintergrund geht (phase === 'speaking')
- `activeVoiceSession`-Tracking war bereits in T7 implementiert — kein neues Tracking nötig
- Server-Build: sauber (0 Fehler), Mobile TypeCheck: sauber (0 Fehler), Tests: 11/11 pass
- Commit: `ed59822`

## 2026-04-23 — T17: VoiceScreen Integration

### Was wurde gemacht
- `src/screens/VoiceScreen.tsx` erstellt: orchestriert AudioPlayerQueue, VoiceClient, voiceStore, CharacterWebView, SubtitleOverlay, VoiceControls, ResumeOptions, StatusPill
- WS-Pattern: `wsService` aus `route.params` (gleich wie ManagerChatScreen/ProcessMonitorScreen)
- `phaseRef` hinzugefügt, um stale-closure in `onTranscript` zu vermeiden
- `VoiceClient.onError` gibt `(msg, recoverable)` zurück — nur `msg` an `setError` weitergegeben
- `Voice`-Route zu `navigation.types.ts` + `AppNavigator.tsx` hinzugefügt
- TypeCheck: sauber, 0 Fehler in neuen Dateien
- Commit: `848f29a`

## 2026-04-23 — T16: VoiceControls + ResumeOptions + StatusPill + Fonts

### Was wurde gemacht
- `@expo-google-fonts/fraunces` + `@expo-google-fonts/bricolage-grotesque` via `npx expo install` installiert
- `src/App.tsx`: `useFonts({Fraunces_400Regular_Italic, Fraunces_500Medium, BricolageGrotesque_400Regular, BricolageGrotesque_500Medium, BricolageGrotesque_600SemiBold})` hinzugefügt (kein Blocking — passt zum bestehenden App-Pattern)
- Hinweis: Package exportiert `Fraunces_400Regular_Italic` (nicht `Fraunces_400Italic` wie in Task-Description) — korrekten Namen verwendet
- `src/components/voice/VoiceControls.tsx` erstellt: Pause/Resume/Cancel/Mic-Row + REM-Label mit Provider-Name
- `src/components/voice/ResumeOptions.tsx` erstellt: "Weiter wie zuvor" + "Mit meinem Einwand fortsetzen" Buttons
- `src/components/voice/StatusPill.tsx` erstellt: Colored dot + German phase label
- `tsc --noEmit` 0 Fehler; Commit: `f99c765`

## 2026-04-23 — T10: Mobile VoiceClient WebSocket Wrapper

### Was wurde gemacht
- `mobile/src/services/VoiceClient.ts` erstellt: typisierter Wrapper über `WebSocketService`
- Nutzt `ws.addMessageListener()` (gibt unsubscribe-Fn zurück) für inbound `voice:*` messages
- Typed handler interface: `onPhase`, `onTranscript`, `onAiDelta`, `onTtsChunk`, `onAckAudio`, `onError`
- Outbound-Methoden: `start`, `stop`, `sendAudioChunk`, `endTurn`, `pause`, `resume`, `cancel`
- `tsc --noEmit` 0 Fehler; Commit: `5d78eed`

## 2026-04-23 — T9: Mobile AudioPlayerQueue (TDD)

### Was wurde gemacht
- `mobile/src/services/AudioPlayerQueue.ts` erstellt: pausable Queue für sequenzielle WAV-Chunk-Wiedergabe via expo-av
- `mobile/src/services/AudioPlayerQueue.test.ts` erstellt: 3 Unit-Tests (sequenziell, pause/resume, stop)
- Jest via `npm install --save-dev jest jest-expo @types/jest` installiert; Config mit `babel-jest` + `babel-preset-expo` in `package.json`
- Fix: `createAsync({ shouldPlay: true })` wurde durch explizites `playAsync()` nach `createAsync()` ersetzt, damit Mock-Calls korrekt gezählt werden
- Alle 3 Tests PASS, Commit: `3352888`

## 2026-04-22 — T6: VoiceSessionController State Machine (TDD)

### Was wurde gemacht
- `server/src/manager/voice.controller.ts` erstellt: Kernorchestrator für den Voice-Turn-Pipeline (audio → Whisper → LLM stream → SentenceBuffer → chunked TTS → WS emit)
- `server/test/voice.controller.test.ts` erstellt: 4 Unit-Tests mit gemockten sidecars (Whisper, TTS, Registry)
- TDD-Prozess: Test zuerst (FAIL), dann Implementation (PASS 4/4)
- Alle T2-T5 Signaturen passen: `SentenceBuffer.push/flush`, `VoiceEmitter`, `TtsChunk`, `PauseState`, `pickAckAudio`, `synthesizeChunked`
- Commit: `81b2de3`

## 2026-04-22 — T4: TTS-Sidecar per-chunk audio

### Was wurde gemacht
- Python (`tts_sidecar.py`): Text wird per `split_sentences()` in Sätze aufgeteilt; jeder Satz wird einzeln synthetisiert via `synth_sentence()`; nach jedem Satz sofort `{"type":"chunk_audio", ...}` + base64-WAV auf stdout; finale Response enthält weiterhin das konkatenierte Gesamt-WAV (via `_concat_wav_chunks()`) → backward-compatible
- TypeScript (`tts-sidecar.ts`): `PendingRequest` + `SynthesizeOptions` um `onChunkAudio` Callback erweitert; stdout-Parser handelt `resp.type === 'chunk_audio'` → dekodiert base64 zu `Buffer` und ruft Callback auf; neuer Export `synthesizeChunked(text, onChunk)` für VoiceSessionController (Task 6)
- Build: TypeScript kompiliert sauber, Python-Syntax validiert
- Commit: `c91b596`

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

## 2026-04-23 — T14: FCM Background/Foreground Handler + Avatar Cache (Expandable Push Notifications)

### Was wurde gemacht
- `notifications.service.ts`: `NativeModules` + `AsyncStorage` imports hinzugefügt
- Avatar-Cache-Helpers: `cacheAvatarUri()` (export) + `readCachedAvatarUri()` (intern) via AsyncStorage Key `manager.agentAvatarUri`
- `registerBackgroundHandler()` komplett ersetzt: handelt jetzt data-only FCM — `manager_reply` → `AgentNotificationModule.show()` mit Avatar-URI; `task_*` + `watcher_alert` → expo-notifications; Fallback für Legacy
- `registerForegroundHandler()` komplett ersetzt: `manager_reply` → natives Module; alle anderen Typen → expo-notifications mit `data.title/body` statt `notification.title/body`
- `managerStore.ts`: `cacheAvatarUri` Import + Aufruf nach `set()` in `setPersonality` (liest Avatar aus `get().personality.agentAvatarUri`)
- `App.tsx`: `useManagerStore` Import + `cacheAvatarUri(currentAvatar)` im mount-once useEffect
- `tsc --noEmit`: sauber (exit 0)
- Commit: `7209152`
