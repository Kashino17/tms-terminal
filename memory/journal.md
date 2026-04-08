# Session-Tagebuch

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
