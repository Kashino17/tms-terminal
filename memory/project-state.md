# Projektzustand

_Zuletzt aktualisiert: 2026-04-26 (Voice Prompt Enhancer released v1.21.3)_

## Aktuelle Version
- **App:** v1.21.3 — Voice Prompt Enhancer (Llama 3.2 3B Instruct via MLX rewritet Sprach-Eingabe in polierte AI-Prompts; Toggle in Settings → Sprache → "KI-Prompt-Modus"; default off)
- **Server:** Pending auf `feat/voice-prompt-enhancer` (von `master` abgezweigt — enthält neuen `prompt_rewriter_sidecar.py` + `.venv-rewriter` mit mlx-lm + ws.handler-Routing). Andere Feature-Branches (`fix/manager-memory-leaks`, `feat/cloud-observer`, `feat/chrome-remote-control`) existieren parallel auf der Dev-Maschine und müssen mit `feat/voice-prompt-enhancer` reconciled werden, da `tms-terminal update` im Moment nur einen einzelnen Branch zieht.

## Zuletzt abgeschlossene Features
- **Voice Prompt Enhancer (v1.21.3, released 2026-04-26)** — neue lokale Llama 3.2 3B Instruct (4-bit MLX) Sidecar-Pipeline, optional zwischen Whisper-Output und Mobile. Drei neue Files server-seitig: `server/audio/prompt_rewriter_sidecar.py` (JSON-Lines stdin/stdout, mirroring whisper-sidecar pattern), `server/src/audio/prompt-rewriter-sidecar.ts` (TS wrapper mit `RewriterBusyError`, single-flight, kill-on-timeout), `server/test/prompt-rewriter-sidecar.test.ts` (3 unit tests, mocks child_process + fs). Wired into `ws.handler.ts:audio:transcribe` mit `payload.enhance === true` strict check; soft-fall-back zu raw Whisper text bei rewriter failure (UI hängt nie). Shutdown-Hook in `index.ts`. Mobile: neuer persistierter `voicePromptEnhanceEnabled` Flag in `settingsStore` (default false), neue "Sprache" section in `SettingsScreen` mit "KI-Prompt-Modus" Switch + Feather `zap` icon, alle 3 Send-Sites (TerminalToolbar, OrbLayer, ManagerChatScreen) lesen den Flag und schicken `payload.enhance`. Smoke-Test: `"also ähm ich will halt das git status ausgeführt wird sozusagen weißt du"` → `"Ausführen des Git-Status"`. Plan: `docs/superpowers/plans/2026-04-26-voice-prompt-enhancer.md`.
- **Activity Indicator + Token Streaming** (v1.14.0) — ThinkingBubble mit Phasen, Live-Timer, Token-Streaming, Phase-Popup
- **Native Tool Calling für GLM-5-Turbo** (v1.15.0) — `write_to_terminal` + `send_enter` als native Function Tools
- **Claude CLI entfernt** (v1.14.0) — nur noch GLM (Default) + Kimi als Provider
- **Stale Buffer Detection** (v1.15.0) — Terminal-Output älter als 60s wird als idle markiert

## Aktive Arbeit
- **Manager Chat Redesign — Design-Phase abgeschlossen 2026-04-26.** Final-Mockup ist `prototype/manager-chat-redesign/v8-tools-direct.html`. Implementation in `mobile/src/screens/ManagerChatScreen.tsx` steht als nächster Schritt an. Decisions-Doc enthält die Architektur-Begründung.
- Shell-Naming: Terminals heißen intern "Shell 1/2/3" aber haben in der App andere Tab-Namen (Verzeichnisnamen). Die AI und der User sollen die echten Namen kennen.
- Tool Calling funktioniert, aber Shell-Label-Zuordnung muss verbessert werden

## Bekannte Offene Punkte
- Terminal-Namen (Tab-Titel = Verzeichnisname) werden nicht an den Manager Agent weitergegeben → AI sagt "Shell 1" statt "ayysir" oder "TMS Terminal"
- Shell-Badges fehlen in der Terminal-UI — User kann "Shell 1/2/3" nicht den echten Terminals zuordnen
- Kimi K2.5 Model-ID muss verifiziert werden
- `git push` hängt manchmal — Fix: `GIT_TERMINAL_PROMPT=0`

## Nächste geplante Schritte
1. **Manager Chat Redesign Implementation** — `v8-tools-direct.html` → React Native umsetzen. Reihenfolge:
   - Header-Refactor (Avatar 36×36 + ⋮-Menu mit Voice/Search/Settings)
   - Multi-Spotlight-Komponente (1/2/4 Pane Grid)
   - Group-Tabs-Bar mit neuem `panegroupsStore` (id/name/terminals[], persist)
   - Tool-Sidebar als neue Component + Flyout-Pattern
   - Direct-Terminal-Mode im Input (Mode-Toggle + send-as-keys statt send-as-message)
   - Voice-Mode Vollbild + Header-Transform-State
   - Rich Transkription mit Confidence-Indikator
- Shell-Naming Feature (parallel): echte Terminal-Namen statt "Shell 1/2/3" + Badges in der Terminal-UI
- Memory: Manager Chat Redesign Decisions in `memory/decisions.md` festgehalten
