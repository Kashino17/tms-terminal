# Projektzustand

_Zuletzt aktualisiert: 2026-04-23 (v1.19.0 released)_

## Aktuelle Version
- **App:** v1.19.0 (auf GitHub Released, Auto-Update aktiv)
- **Server:** v1.19.0 (via `tms-terminal update` aktualisiert — **User muss neu starten**)

## Zuletzt abgeschlossene Features
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
- **Voice Chat Pipeline (feat/chrome-remote-control Branch):** T1–T6 abgeschlossen. T7 (WS Handler Wiring) als nächstes.
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
