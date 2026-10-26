# Projektzustand

_Zuletzt aktualisiert: 2026-10-26 — Release v1.123.8 vorbereitet_

## Aktueller geprüfter Stand
- Repository: `/Users/ayysir/Desktop/TMS Terminal`, Branch `feat/fernzugriff`, Basis `8ee3625` (App v1.123.6, tatsächlicher Android-versionCode 22306). Release-Ziel: v1.123.8 mit versionCode 22308 in app.json und Gradle. Die separate ältere Kopie `tms-terminal` wurde nicht verändert.
- Der Nutzer hat den lokalen Fold-Mockup freigegeben ("ja passt"). Der Nutzer hat anschließend Commit, Push und Veröffentlichung ausdrücklich angefordert, damit das In-App-Update verfügbar wird. Der korrigierte Release v1.123.8 wird über den bestehenden GitHub-Workflow vorbereitet; Veröffentlichung noch zu verifizieren.
- Season-2-Terminal: Bei höchstens 480 CSS-Pixeln sichtbarer Höhe automatisch eine randlose Sitzung mit schmalem Kopf und bestehender Eingabe. Bis 280 px wird die Eingabe auf zwei Zeilen begrenzt. Sitzungswechsel, Lesefokus, Schriftgröße (13–20 px, Standard 15), Sondertasten und Spracheingabe bleiben verfügbar.
- Die WebView nutzt die tatsächlich sichtbare Höhe (inkl. Android adjustResize) und misst den Terminalinhalt. Spalten UND Zeilen werden nach 350 ms stabiler Größe übernommen. Das ersetzt die bisherige Höhen-Ratsche, die kleine Fenster dauerhaft mit zu vielen PTY-Zeilen betrieben hat.
- Ungesendete Texte und Cursorposition bleiben pro Sitzung erhalten; Wechsel senden den bereits übertragenen Text nicht erneut an die PTY.
- Quelle: `mockups/season2/liquid-deck/compact-terminal.{css,js}` mit gezielten Hooks in `index.html` und `mobile/src/season2/web/bridge.js`. `build:season2` bettet beide Dateien in `liquidDeckHtml.ts` ein.

## Release und Prüfung
- Tag v1.123.7 wurde gepusht, aber nicht veröffentlicht: Die neue CI-Teststufe fand zwei Tests mit absoluten Mac-Pfaden sowie einen direkten TS-Import, den Node 20 nicht ausführen kann. Die Tests lesen nun relativ zu import.meta.url; Source-Tests verwenden Node 22 mit Type-Stripping, der APK-Build weiterhin Node 20. Für den korrigierten Stand gibt es den neuen Tag v1.123.8; der fehlgeschlagene Tag wird nicht verschoben.
- Signierter Android-Build über `.github/workflows/release-apk.yml` (die letzten fünf Releases waren erfolgreich). Tag-Push startet den Build; der Workflow veröffentlicht danach die APK als Latest Release für den bestehenden Updater. Neue Vorprüfung: WebView erzeugen, 108 Tests plus übersprungene Browser-Checks ausführen und reproduzierbares Bundle sicherstellen.

- `npm run build:season2`: erfolgreich; alle acht eingebetteten Skripte syntaktisch geprüft.
- `node --test scripts/*.test.mjs`: 108 bestanden, 0 fehlgeschlagen, 2 Browser-Tests ohne verfügbare Browser-Verbindung übersprungen. 14 neue Regressionstests decken Größenwechsel, Sitzungsentwürfe, Viewport, Lesefokus und Sperrbildschirm ab.
- Vollständige TypeScript-Läufe mit Node 25 und Node 22 blieben ohne Ausgabe hängen und wurden beendet; keine TS-Logik wurde geändert, nur der neu erzeugte HTML-String.
- APK noch nicht erzeugt: `assembleRelease` mit vorhandenem JDK 17 und Node 25 bzw. Node 22 bleibt vor der Kompilierung bei `ReactNativeModules.getReactNativeConfig()` hängen. Node 22 konnte die CLI auflösen, der anschließende `cli config`-Aufruf blockierte jedoch ebenfalls. Stack-Probe: synchrones Dateilesen innerhalb der lokalen Abhängigkeiten (`walker/lib/walker.js`); separate Dateilesetests funktionieren. Ursache noch offen, kein belastbarer Schluss auf einen reinen Node-Versionsfehler. Die eigenen Build-Versuche wurden abgebrochen; keine globalen Prozesse beendet und keine globale Node-Konfiguration verändert.
- Noch auf dem Fold zu prüfen: Video oben + Terminal unten; Samsung-Tastatur auf/zu; Trennlinie verschieben; Schreiben/Sitzungswechsel/Sondertasten; Lesefokus; Rückkehr ins Vollbild; Voice-Aufnahme.
- Aktuelle CUA-Umgebung bietet keine Browser-Verbindung; ein nativer visueller WebView-Test wurde nicht behauptet.
- Freigegebener Mockup weiterhin unter `https://macbook-pro-2.taile64a95.ts.net:8453/preview.html` (nur Tailnet, Mac/Server müssen laufen).

## Historischer Stand vom 2026-04-26
Die folgenden älteren Arbeitsnotizen wurden bewahrt und in dieser Sitzung nicht erneut verifiziert.

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
