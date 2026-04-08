# Projektzustand

_Zuletzt aktualisiert: 2026-04-08_

## Aktuelle Version
- **App:** v1.12.2
- **Server:** muss nach v1.12.2 noch aktualisiert werden (git pull + npm run build + Neustart)

## Zuletzt abgeschlossene Features
- **Manager Agent** (v1.12.0) — AI-Chat-Hub der alle Terminals überwacht
  - 3 AI Provider: Claude CLI, Kimi K2.5, GLM 5.0 Turbo
  - 15-Min Polling + manuelle Zusammenfassungen
  - Terminal-Selector-Chips, Provider-Picker
  - Image Attachments im Chat
  - API-Key Verwaltung in Settings
- **Personality System** (v1.12.1) — Intelligente Terminal-Analyse, dynamischer System-Prompt
- **Conversational Onboarding** (v1.12.2) — Natürlicher Chat statt Wizard
- **Memory System** (in Arbeit) — Persistentes Gedächtnis über Sessions hinweg

## Aktive Arbeit
- Memory-System implementieren (diese Session)
- Manager Agent braucht noch Server-Update auf dem Produktiv-Server

## Bekannte Offene Punkte
- Kimi K2.5 und GLM 5.0 Model-IDs müssen verifiziert werden (nach Knowledge-Cutoff)
  - Workaround: `/v1/models` Endpoint mit eigenem API Key abfragen
- Manager Agent Personality wird auf dem Server nur im RAM gehalten, nicht persistiert
  - Client schickt sie beim Connect, aber bei Server-Neustart ohne Client = verloren
- `git push` hängt manchmal — Fix: `GIT_TERMINAL_PROMPT=0` oder `gh auth setup-git`

## Nächste geplante Schritte
- Memory-System testen und verfeinern
- Manager Agent auf dem Server deployen und testen
- UI-Polish des Chat-Screens (ggf. mit frontend-design Skill)
