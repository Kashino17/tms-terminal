# Projektzustand

_Zuletzt aktualisiert: 2026-11-08 — Bubble-Stopp-Erkennung + Diagnose; Release v1.129.3_

## Aktueller geprüfter Stand

**Stand 2026-11-08 mittags (neueste):** Release v1.129.3. Bubble war weg, obwohl Schalter an (nur aus/ein half): „Stopp“ in „Aktive Apps“/Force-Stop lässt Android den Dienst als abgestürzt markieren und nie neu binden — App kann das nicht selbst beheben. Jetzt: Erkennung (Einstellungen „Von Android gestoppt“, Hinweis beim Öffnen, Benachrichtigung → Bedienungshilfen), Zeile „Letzter Abbruch“ mit Android-Grund. Bubble erscheint zuverlässiger beim Feld-Öffnen (Nachprüfungen). **Offen:** Nutzer fragen, ob er „Stopp“ gedrückt hat / was „Letzter Abbruch“ zeigt; Akku-Beobachtung.

**Stand 2026-11-08 früh:** Release v1.129.2 (davor v1.129.1). Bubble läuft im eigenen Prozess `:bubble` + Keep-Alive-Vordergrund-Dienst (stille Benachrichtigung „Diktat-Bubble bereit“, wie Wispr Flow) → verschwindet nicht mehr nach langem Hintergrund (Samsung entkoppelte die Bedienungshilfe). Akku-Fresser behoben: A11y-Bindung im App-Prozess hielt ganz TMS wach (gemessen 1,83 s → 0,09 s CPU/min App-Wechsel; App friert wieder ein). Einstellungszeile „Hintergrund-Schutz“ (An/Prüfen/Aus). Nutzer bestätigt: Benachrichtigung sichtbar, Bubble geht. **Offen:** Nutzer beobachtet Akku/Wärme am 2026-11-08 (Einstellungen → Akku → Akkuverbrauch). Server unverändert.

**Stand 2026-11-07 vormittags:** Release v1.129.0: Bubble schreibt direkt ins Feld (auch Web/TMS), Zwischenablage nur bei geschlossener Tastatur; sichtbar nur mit Tastatur; neues minimalistisches Design mit Morph-Animationen. Server unverändert (kein Neustart nötig). Update braucht Play-Protect-Pause.

**Stand 2026-11-07 früh (neueste):** Release v1.128.0 (`d2f4199`): systemweite Diktat-Bubble (Android-Bedienungshilfe `com.tms.terminal.bubble.DictationBubbleService`, Overlay, MediaRecorder ADTS, OkHttp-WS `?role=dictation`). Emulator-geprüft: Bubble auf Feld in fremder App, Einfügen, Zwischenablage ohne Feld, App-Wechsel → Zwischenablage, 15-min-Schlaf, Stille-Wächter. **Server neu gestartet 03:01 (`tms-terminal update`, Build 02:57, Live-Test role=dictation: 471 ms Stopp→Text; 6 Terminals im Wächter überlebt).** Offen: App auf v1.128.0, Bedienungshilfe am Fold einschalten, echter Mikrofon-Test am Fold (Emulator lieferte keinen Host-Ton). Zurückgestellt: Schlaf-Wecktimer, onClosing, Mikro-Stille mitten in der Aufnahme. Spec/Plan: `docs/superpowers/{specs,plans}/2026-11-07-dictation-bubble*`.

**Stand 2026-11-07 nachts (neueste):** Release v1.127.0 (`d6dee27`): Diktat wird während der Aufnahme gestreamt (Android AAC-ADTS, `dictation:*`-Protokoll, Server-Sitzungen unabhängig vom Socket, Vorab-Transkription in ~60-s-Segmenten). E2E echter Sidecar: 4 min → 2,7 s Stopp→Text. ✕ während „Transkribiere…“ gibt Mikrofon frei. **Offen: Mac-Server-Neustart durch Nutzer** (sonst Fallback auf alten Weg), echter Fold-Test (schreibt Samsung-MediaRecorder ADTS fortlaufend?), Teil 2 = systemweite Bubble (eigenes Design). Spec/Plan: `docs/superpowers/{specs,plans}/2026-11-07-dictation-streaming*`.

**Stand 2026-11-07 (neueste):** Release v1.126.0 (`f65ad9b`): Season 2 hält Hauptserver + alle weiteren erreichbaren Geräte gleichzeitig verbunden; Terminal-Leiste nach Gerät gruppiert; Insel nur "+" (Geräte-Wahl) + Fernzugriff mit MAC/WIN-Wechsel. v1.127.1: Dateien und Fingerabdruck folgen dem Gerät des vorderen Terminals. Offen: echter Test Mac+Windows auf dem Fold.

**Stand 2026-11-05 spät (neueste):** Release v1.125.2 (Build lief bei Notiz noch). Mac-Server auf `81fdb2f`-Vorgänger `6a98c81` neu gestartet (22:52); Verlaufssicherung LIVE bestätigt (4 Terminals gesichert, mirrors.json eingelesen, 743 Zeilen Verlauf direkt nach Neustart). v1.125.1: Windows erkennt Vollbild-Programme per Prozessname (ConPTY gibt 1049 nicht weiter; ProcessWatch gedrosselt, geteilte PowerShell-Tabelle). v1.125.2: Dateien-Ansichten setzen den Ordner beim Gerätewechsel auf ~ zurück, fallen bei 400/403/404 auf ~ zurück, verstehen Windows-Pfade. Offen Windows: Server auf kashno17 antwortete nicht auf 100.80.72.101:8767 (PC erreichbar, SSH-Port offen) — `tms-terminal doctor`-Ausgabe vom Nutzer fehlt; Nutzer sagte, `tms-terminal update` lief dort fehlerfrei (alter bash-Weg — unbelegt, ob es wirkte). Log-Fix `81fdb2f` gepusht, wirkt beim nächsten Mac-Neustart.

**Stand 2026-11-05 abends:** Latest Release v1.125.0 (Commit `32a3d27`), Mac-Server auf `32a3d27` neu gestartet (21:52). Terminals haben intern 200 Zeilen (virtuelle Höhe), die Karte zeigt nur den Inhalt; Vollbild-Programme (vim, OpenCode) bekommen die echte Höhe. Versteckte xterm-Renderer stillgelegt (Hitzequelle). Server sichert Terminal-Verlauf beim Herunterfahren (`~/.tms-terminal/mirrors.json`) und lädt ihn beim Start — erst ab dem NÄCHSTEN Neustart wirksam, noch nicht live beobachtet. Offen: Nutzer muss auf v1.125.0 updaten und prüfen, ob noch Kopien entstehen; Auswahllisten (`/resume`) können länger als die Karte sein; Windows-Punkte unten unverändert offen.

**Stand 2026-11-05 (tagsüber):** Latest Release v1.124.2 (Branch feat/fernzugriff, Live-Tree ~/Developer/tms-terminal). Terminal: feste Breite 50 Spalten, Zeilen-Ratsche, Stapel-Messfehler behoben, umgebrochene Links robust. OpenCode-Maus unter Windows über `terminal:process`. Offen: Windows-PC manuell auf feat/fernzugriff aktualisieren (altes Update braucht bash) und `tms-terminal doctor` auswerten; Fernzugriff Windows dann live testen; Mac-Server nicht neu gestartet (braucht die Server-Änderungen nicht dringend); TERM unter Windows ungesetzt (unbewiesen).

- Repository: `/Users/ayysir/Desktop/TMS Terminal`, Branch `feat/fernzugriff`, Basis `8ee3625` (App v1.123.6, tatsächlicher Android-versionCode 22306). Veröffentlicht: v1.123.8 mit versionCode 22308 in app.json und Gradle. Die separate ältere Kopie `tms-terminal` wurde nicht verändert.
- Der Nutzer hat den lokalen Fold-Mockup freigegeben ("ja passt"). Der Nutzer hat anschließend Commit, Push und Veröffentlichung ausdrücklich angefordert, damit das In-App-Update verfügbar wird. Der Release v1.123.8 ist über GitHub veröffentlicht und als Latest Release für die App verifiziert.
- Season-2-Terminal: Bei höchstens 480 CSS-Pixeln sichtbarer Höhe automatisch eine randlose Sitzung mit schmalem Kopf und bestehender Eingabe. Bis 280 px wird die Eingabe auf zwei Zeilen begrenzt. Sitzungswechsel, Lesefokus, Schriftgröße (13–20 px, Standard 15), Sondertasten und Spracheingabe bleiben verfügbar.
- Die WebView nutzt die tatsächlich sichtbare Höhe (inkl. Android adjustResize) und misst den Terminalinhalt. Spalten UND Zeilen werden nach 350 ms stabiler Größe übernommen. Das ersetzt die bisherige Höhen-Ratsche, die kleine Fenster dauerhaft mit zu vielen PTY-Zeilen betrieben hat.
- Ungesendete Texte und Cursorposition bleiben pro Sitzung erhalten; Wechsel senden den bereits übertragenen Text nicht erneut an die PTY.
- Quelle: `mockups/season2/liquid-deck/compact-terminal.{css,js}` mit gezielten Hooks in `index.html` und `mobile/src/season2/web/bridge.js`. `build:season2` bettet beide Dateien in `liquidDeckHtml.ts` ein.

## Release und Prüfung
- Erfolgreich veröffentlicht: https://github.com/Kashino17/tms-terminal/releases/tag/v1.123.8 — Release-Commit `0cb0c5c`, CI-Lauf `40306140012`. Android-APK heruntergeladen und mit aapt/apksigner geprüft: `com.tms.terminal`, v1.123.8 / code 22308, arm64 enthalten, Signatur identisch zu v1.123.6. Der öffentliche, nicht authentifizierte `/releases/latest`-Endpunkt liefert die neue Version samt hochgeladener APK.
- In-App-Update: Einstellungen → Nach Updates suchen. 108 Tests bestanden, 2 Browser-Checks mangels Browser-Verbindung übersprungen; WebView-Build reproduzierbar, Android-Release-Build erfolgreich. Ein echter Fold-/Samsung-Tastatur-Test bleibt dem Gerätetest vorbehalten.
- Tag v1.123.7 wurde gepusht, aber nicht veröffentlicht: Die neue CI-Teststufe fand zwei Tests mit absoluten Mac-Pfaden sowie einen direkten TS-Import, den Node 20 nicht ausführen kann. Die Tests lesen nun relativ zu import.meta.url; Source-Tests verwenden Node 22 mit Type-Stripping, der APK-Build weiterhin Node 20. Für den korrigierten Stand gibt es den neuen Tag v1.123.8; der fehlgeschlagene Tag wird nicht verschoben.
- Signierter Android-Build über `.github/workflows/release-apk.yml` (die letzten fünf Releases waren erfolgreich). Tag-Push startet den Build; der Workflow veröffentlicht danach die APK als Latest Release für den bestehenden Updater. Neue Vorprüfung: WebView erzeugen, 108 Tests plus übersprungene Browser-Checks ausführen und reproduzierbares Bundle sicherstellen.

- `npm run build:season2`: erfolgreich; alle acht eingebetteten Skripte syntaktisch geprüft.
- `node --test scripts/*.test.mjs`: 108 bestanden, 0 fehlgeschlagen, 2 Browser-Tests ohne verfügbare Browser-Verbindung übersprungen. 14 neue Regressionstests decken Größenwechsel, Sitzungsentwürfe, Viewport, Lesefokus und Sperrbildschirm ab.
- Vollständige TypeScript-Läufe mit Node 25 und Node 22 blieben ohne Ausgabe hängen und wurden beendet; keine TS-Logik wurde geändert, nur der neu erzeugte HTML-String.
- APK noch nicht erzeugt: `assembleRelease` mit vorhandenem JDK 17 und Node 25 bzw. Node 22 bleibt vor der Kompilierung bei `ReactNativeModules.getReactNativeConfig()` hängen. Node 22 konnte die CLI auflösen, der anschließende `cli config`-Aufruf blockierte jedoch ebenfalls. Stack-Probe: synchrones Dateilesen innerhalb der lokalen Abhängigkeiten (`walker/lib/walker.js`); separate Dateilesetests funktionieren. Ursache noch offen, kein belastbarer Schluss auf einen reinen Node-Versionsfehler. Die eigenen Build-Versuche wurden abgebrochen; keine globalen Prozesse beendet und keine globale Node-Konfiguration verändert.
- Noch auf dem Fold zu prüfen: Video oben + Terminal unten; Samsung-Tastatur auf/zu; Trennlinie verschieben; Schreiben/Sitzungswechsel/Sondertasten; Lesefokus; Rückkehr ins Vollbild; Voice-Aufnahme.
- Aktuelle CUA-Umgebung bietet keine Browser-Verbindung; ein nativer visueller WebView-Test wurde nicht behauptet.
- Freigegebener Mockup weiterhin unter `https://macbook-pro-2.taile64a95.ts.net:8453/preview.html` (nur Tailnet, Mac/Server müssen laufen).

## 2026-10-28 — Diagnose Verbindung bei Bildschirm-Aus und Ruhezustand

- Nutzer meldet Verbindungsabbrüche bei ausgeschaltetem Bildschirm bzw. MacBook-Ruhezustand ohne Netzteil und möchte keinen zusätzlichen Energieverbrauch.
- Nur Diagnose, keine Änderungen an App, Server, Tailscale oder Energieeinstellungen, kein neuer Release. Ursache am Gerät nicht reproduziert.
- Aktuelle read-only-Abfrage: Netzbetrieb; pmset AC sleep=0, displaysleep=10, womp=1. Ausgelesene letzte Ereignisse zeigen Display-Aus/Ein; daraus kein Nachweis eines System-Sleep-Abbruchs. Akku-Schlafverhalten nicht verifiziert.
- Installierte Tailscale.app laut Info.plist: 1.94.1. Offizielles Changelog nennt in 1.98.8 Korrekturen für Verbindungen nach OS-Wake; aktueller Changelog-Stand 1.104.2. Update ist ein sinnvoller Ansatz, aber keine bewiesene Ursache des konkreten Abbruchs. Quelle: https://tailscale.com/changelog
- Aktueller TMS-Code hält getrennte PTYs ohne Idle-TTL; automatische Wiederverbindung und AppState-Vordergrundbehandlung bestehen bereits. WebSocket-Retries laufen bis maximal 5 Sekunden Abstand; ein expliziter Handshake-Timeout fehlt. Verbesserungsansatz: begrenzter Verbindungsaufbau, verlässliche Wiederaufnahme und langsamere Versuche bei längerem Offline-Zustand statt zusätzlicher Wake-Locks.
- Technische Grenze: Display-Aus und System-Schlaf unterscheiden. Normaler System-Schlaf unterbricht interaktive Terminal-Ausführung; automatisches Wiederverbinden kann erst nach Wake/Netzrückkehr helfen. Durchgehende Arbeit erfordert einen wachen Rechner und kann gegenüber Schlaf nicht ohne Mehrverbrauch versprochen werden. Empfohlen: bestehendes Energiesparen erhalten und Wiederaufnahme verbessern; bei gewünschtem Live-Betrieb nur während tatsächlicher Nutzung wachhalten, als expliziter Energie-Kompromiss.

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
