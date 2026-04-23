# Projektzustand

_Zuletzt aktualisiert: 2026-04-23 (Voice Chat + Expandable Push Notifications Code complete — awaiting manual test + v1.20.0 release)_

## Aktuelle Version
- **App:** v1.19.0 released; **v1.20.0 code ready on feat/chrome-remote-control** (Voice Chat + Expandable Push Notifications — pending manual test + release.sh)
- **Server:** v1.19.0 (via `tms-terminal update`); v1.20.0 code merged into same branch

## Zuletzt abgeschlossene Features
- **Expandable Push Notifications (v1.20.0, pending release)** — WhatsApp-artig ausklappbare Push-Benachrichtigungen für Manager-Replies + Task-Events. Server: `fcm.service.sendBig()` (data-only FCM), `ManagerPushDecider` (screen-state + stale-detection 15s + globaler 3s-Debounce), neue `client:active_screen` WS-Message, Markdown-Stripping. Mobile: Preview 80→800 Zeichen, `ManagerChatScreen` sendet 10s-Heartbeat, AppState-Regel invertiert (local nur wenn `active && !chatActive`), AsyncStorage-Avatar-Cache für Background-Handler. Kotlin: `AgentNotificationModule.show()` +messageId, unique `PendingIntent`, `consumeLaunchExtras()` @ReactMethod. `App.tsx` + `TerminalScreen.tsx` setzen/konsumieren Pending-Flag für Tap-Navigation (verhindert Cold-Start-Crash ohne WS-Params). 33 Unit-Tests grün. Spec: `docs/superpowers/specs/2026-04-23-expandable-push-notifications-design.md`, Plan: `docs/superpowers/plans/2026-04-23-expandable-push-notifications.md`.
- **Voice Chat Manager (v1.20.0, pending release)** — Fullscreen Voice-Screen mit phasen-synchronisiertem Character-WebView, Karaoke-Untertiteln (Fraunces Italic + Bricolage Grotesque), VAD-Mikrofon mit 800ms-Silence-Detection, Pause/Resume mit pre-generierten Ack-Audios (3 Varianten pro kind), 2-Optionen Resume bei User-Einwand. Server: neuer VoiceSessionController, F5-TTS-Sidecar emittiert per-chunk Audio, ack-audio Pre-Generation bei Startup. 13 neue voice:* WebSocket-Messages. Alle 5 Provider unterstützt. Spec: `docs/superpowers/specs/2026-04-22-manager-voice-chat-design.md`, Plan: `docs/superpowers/plans/2026-04-23-manager-voice-chat.md`.
- **Lokale Model-Lade-Anzeige + empty-reply fix** (v1.19.0) — WS-Event `manager:model_status` streamt `loading|ready|error` + elapsedMs + Progress-% aus `lms load` stdout; Mobile zeigt Banner mit Timer und disabled Input; Online-Dot pulsiert 2× bei Ready. Empty-Reply-Fallback bei Gemma 4 Memory-only-Antworten: `📝 Notiert: <fact>` statt generischem "Verstanden". `max_tokens` auf 16384 (vorher 4096).
- **Qwen 3 Coder 30B + Qwen 3.6 35B lokal auswählbar** (v1.18.10) — neue Provider `qwen-27b`/`qwen-35b` im Manager; `LmStudioController` lädt gewähltes Modell via `lms` CLI automatisch und unloadet alle anderen (VRAM frei); Model-IDs überschreibbar via `~/.tms-terminal/manager.json` → `localModels`
- **Manager-Agent Timeout-Fix** (v1.18.9) — Idle-Timeout (60s zwischen Tokens) statt absolutem 3min-Limit; Gemma 4 31B kann jetzt lange generieren ohne Abbruch; Hard-Ceiling 30min als Sicherheitsnetz
- **Verlässliche Transkription** (v1.18.9) — nur noch `turbo` Model (kein Cold-Swap-Hang), Busy-Lock + SIGKILL on Timeout (keine Zombies), Mobile-Watchdog (60s) in allen 3 Mic-Komponenten
- **Auto-Approve Zuverlässigkeit** (v1.18.9) — Immediate-Match pro Feed (statt nur bei Silence → Spinner blockieren nicht mehr), Startup-Grace 5s → 1.5s, Tail-Hash-Dedup, Buffer 1200 → 3000
- **Activity Indicator + Token Streaming** (v1.14.0) — ThinkingBubble mit Phasen, Live-Timer, Token-Streaming, Phase-Popup
- **Native Tool Calling für GLM-5-Turbo** (v1.15.0) — `write_to_terminal` + `send_enter` als native Function Tools
- **Claude CLI entfernt** (v1.14.0) — nur noch GLM (Default) + Kimi als Provider
- **Stale Buffer Detection** (v1.15.0) — Terminal-Output älter als 60s wird als idle markiert

## Aktive Arbeit
- **feat/chrome-remote-control Branch:** Voice Chat T1–T19 abgeschlossen. Expandable Push Notifications T1–T14 abgeschlossen + Review-Fixes (C-1, I-1, M-6) + Polish (I-3, M-1, M-2, M-5) + Spec-Klärung (I-2, M-7). **Beide Features warten auf Manual Tests auf Samsung Galaxy Fold 7 + `./release.sh` für v1.20.0.**
- Shell-Naming: Terminals heißen intern "Shell 1/2/3" aber haben in der App andere Tab-Namen (Verzeichnisnamen). Die AI und der User sollen die echten Namen kennen.
- Tool Calling funktioniert, aber Shell-Label-Zuordnung muss verbessert werden

## Bekannte Offene Punkte
- Terminal-Namen (Tab-Titel = Verzeichnisname) werden nicht an den Manager Agent weitergegeben → AI sagt "Shell 1" statt "ayysir" oder "TMS Terminal"
- Shell-Badges fehlen in der Terminal-UI — User kann "Shell 1/2/3" nicht den echten Terminals zuordnen
- Kimi K2.5 Model-ID muss verifiziert werden
- `git push` hängt manchmal — Fix: `GIT_TERMINAL_PROMPT=0`

## Nächste geplante Schritte
- Shell-Naming Feature: echte Terminal-Namen statt "Shell 1/2/3" + Badges in der Terminal-UI
- Manager Agent UI-Polish
