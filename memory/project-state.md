# Projektzustand

_Zuletzt aktualisiert: 2026-04-22_

## Aktuelle Version
- **App:** v1.15.1 (auf GitHub Released, Auto-Update aktiv)
- **Server:** v1.15.1 (via `tms-terminal update` aktualisiert)

## Zuletzt abgeschlossene Features
- **Verlässliche Transkription** (v1.15.1) — nur noch `turbo` Model (kein Cold-Swap-Hang), Busy-Lock + SIGKILL on Timeout (keine Zombies), Mobile-Watchdog (60s) in allen 3 Mic-Komponenten
- **Auto-Approve Zuverlässigkeit** (v1.15.1) — Immediate-Match pro Feed (statt nur bei Silence → Spinner blockieren nicht mehr), Startup-Grace 5s → 1.5s, Tail-Hash-Dedup, Buffer 1200 → 3000
- **Activity Indicator + Token Streaming** (v1.14.0) — ThinkingBubble mit Phasen, Live-Timer, Token-Streaming, Phase-Popup
- **Native Tool Calling für GLM-5-Turbo** (v1.15.0) — `write_to_terminal` + `send_enter` als native Function Tools
- **Claude CLI entfernt** (v1.14.0) — nur noch GLM (Default) + Kimi als Provider
- **Stale Buffer Detection** (v1.15.0) — Terminal-Output älter als 60s wird als idle markiert

## Aktive Arbeit
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
