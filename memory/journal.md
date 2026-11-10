# Session-Tagebuch

## 2026-04-26 — Manager Chat Redesign (8 Runden HTML-Mockups)

### Was wurde gemacht
- 8 Runden Design-Iteration des Manager Chat Screens als interaktive HTML-Mockups in `prototype/manager-chat-redesign/`. Pro Runde 3 Varianten zum Vergleichen, dann User-Feedback → nächste Runde.
- R1: 3 Architektur-Konzepte (Cockpit / Mosaic / Stage) — Stage gewann
- R2: Stage-Iterationen (Pro / Multi / Float) — Multi gewann
- R3: Multi mit allen echten Features aus ManagerChatScreen.tsx (Native / Studio / Console) — Native gewann
- R4: Native + Polish (Compact / Wide / Premium) — Premium gewann (3-State Rail, Voice-Call mit Header-Transform, Rich Transkription)
- R5: Premium + größerer Avatar (Persona / Messenger / Hero) — alle zu groß
- R6: Minimal-Stufen (Quiet / Hush / Whisper) — Whisper-Header + Quiet-Rail-Kombi gewählt
- R7 (`v7-final.html`): Whisper + Quiet-Rail + NEUES Group-Tabs Feature (Pane-Konfigs als benannte Gruppen speichern/laden, inline-naming, mit Dot-Vorschau)
- R8 (`v8-tools-direct.html`): FINAL — Stage-Sidebar wird zu Tool-Leiste (🔧 Werkzeuge, ⚡ Quick, 📋 Snippets, 🗂 Files, 🔍 Search, 🤖 AI), Chat-Input bekommt Direct-Mode-Toggle (💬↔▶) für direktes Terminal-Schreiben mit Flash-Animation
- Vor R3: Explore-Subagent hat ManagerChatScreen.tsx (3000 Zeilen) komplett gemappt — alle Features (Header, Tasks, Search, Wizards, TTS, Lightbox, Phase-Popup, Voice-Enhance) inventarisiert damit Redesign nichts vergisst.
- Server lief durchgehend auf Port 8789 (Tailscale), User testete am Galaxy Fold 7.
- Final-Decision in `decisions.md` dokumentiert.

### Was lief gut
- Drei-Varianten-pro-Runde-Format hat super geholfen — User konnte Stärken kombinieren ("Whisper-Header aber Quiet-Rail")
- Originale Design-Tokens (`theme.ts`) wurden 1:1 verwendet — Übergang zur Implementation wird visuell konsistent
- Demo-Interaktivität (Klick auf Spines, @mentions, Tool-Cards, Voice-Modus, Transkription) hat User echtes "Feel" gegeben statt nur Static-Mockups
- Group-Tabs-Feature ist user-vorgeschlagen und super sinnvoll für Multi-Pane-Workflows (Default/Debug/Deploy schnell switchen)
- Direct-Terminal-Mode trennt Manager-Conversation klar von Terminal-Befehlen — Mode-Toggle (💬/▶) ist visuell eindeutig

### Was war schwierig
- File-Größe: jede Variante ist ~70-85kb HTML (alle Features inline) — viel Code-Duplication zwischen Varianten
- Lange Iterations-Sequenz (8 Runden) — User hatte sehr genaue Vorstellungen, jede Runde war notwendig

### Entscheidungen
- Final v8-tools-direct.html als Implementation-Vorlage festgelegt
- Group-Tabs sind ein neues Feature (nicht im aktuellen ManagerChatScreen) — braucht neuen Store + Persistenz
- Tool-Sidebar ist neu, Tools sind eigene Components mit Flyout-Pattern
- Stage-Manager-Rail mit Terminal-Abkürzungen wurde gestrichen (redundant zu Term-Chip-Bar unten)

## 2026-04-26 — Voice Prompt Enhancer (v1.21.3)

### Was wurde gemacht
- Neue lokale Llama 3.2 3B Instruct (MLX) Sidecar-Pipeline, optional zwischen Whisper-Output und Mobile.
- Branch `feat/voice-prompt-enhancer` von master abgezweigt; 6 chirurgische Feature-Commits:
  1. `ffeacec` — Protocol-Flag `enhance?: boolean` in `AudioTranscribeMessage.payload`
  2. `b592b24` — `server/audio/prompt_rewriter_sidecar.py` (Llama 3.2 3B 4-bit MLX, JSON-Lines stdin/stdout)
  3. `fde1001` — TS-Wrapper `server/src/audio/prompt-rewriter-sidecar.ts` (mirrors whisper-sidecar) + 3 unit tests
  4. `512f6a1` — `shutdownRewriter()` in graceful-shutdown closure
  5. `408b21e` — `ws.handler.ts:audio:transcribe` Routing mit `enhance === true` strict check + soft-fall-back zu raw Whisper text
  6. `a984af9` — Settings-Store-Flag `voicePromptEnhanceEnabled` (persisted via Zustand+AsyncStorage, default false)
  7. `ffcf21e` — Neue "Sprache" Section in SettingsScreen mit "KI-Prompt-Modus" Switch
  8. `3de2be4` — `enhance: voicePromptEnhanceEnabled` in allen 3 Send-Sites (TerminalToolbar, OrbLayer, ManagerChatScreen)
- `superpowers:writing-plans` für die Spec, dann `superpowers:subagent-driven-development` für die Ausführung mit per-chunk Spec+Quality-Reviews. Final-Aggregat-Review = "Ready for manual E2E".
- Smoke-Test bestätigt: `"also ähm ich will halt das git status ausgeführt wird sozusagen weißt du"` → `"Ausführen des Git-Status"` (Filler-Words entfernt, Intent erhalten, Deutsch erhalten).

### Was lief gut
- Sidecar-Architektur gespiegelt 1:1 vom existierenden whisper-sidecar/tts-sidecar — keine neuen Patterns nötig, einfach zu maintainen.
- Soft-Fall-Back im Server (try/catch um `rewritePrompt`, fallback auf rohen Text) verhindert dass die Mobile-UI hängt wenn der Rewriter mal kaputt ist.
- Plan war so präskriptiv (jede Code-Zeile spezifiziert) dass der Implementer-Subagent sehr schnell war und Reviewer wenig zu beanstanden hatten.
- `payload.enhance === true` strict check — `false`/`undefined`/non-bool gehen alle in den Legacy-Path → null Risiko für bestehende User mit Toggle off.

### Was war schwierig
- Branch-Realität vs Plan-Annahmen: Plan referenzierte `shutdownTts` und `WhisperBusyError`, die auf parallelen unreleased Branches existieren aber nicht auf master. Implementer-Subagent hat sich korrekt angepasst (DONE_WITH_CONCERNS) und die Anpassungen explizit dokumentiert.
- Master ist deutlich hinter den verschiedenen Feature-Branches — `app.json` zeigte 1.18.7 obwohl GH-Release schon bei v1.21.2 war. Vor dem Release musste app.json + build.gradle auf 1.21.2 ge-syncht werden, damit der Patch-Bump auf v1.21.3 geht.
- Final-Code-Reviewer-Subagent crashte beim ersten Versuch mit `API Error: Unable to connect to API (ConnectionRefused)` nach 16 min Laufzeit — Anthropic-API-Blip. Retry war erfolgreich.

### Entscheidungen
- Modell: **Llama 3.2 3B Instruct (4-bit MLX)** — Sweet-Spot zwischen Speed (~80-300ms nach Warmup) und Qualität. Alternatives waren Qwen 2.5 1.5B (schneller, weniger schlau) oder das existierende Manager-Modell Qwen 3 Coder 30B (Overkill, blockiert das Manager-Modell).
- Toggle-Ort: Settings-Screen-Switch (nicht Toolbar-Pill) — User-Wahl. Greift gleichermaßen für Terminal-Mic, Floating-Orb-Mic und Manager-Chat-Mic (kein Trennen Terminal/Chat).
- Output-Path: rewritten Text landet ins Eingabefeld, User editiert + drückt Enter selbst — nicht direkt versendet. User-Wahl.
- Soft-Fall-Back im Server (nicht im Wrapper): bei `rewritePrompt`-Fehler wird der rohe Whisper-Text als `audio:transcription` rausgeschickt. Wrapper bleibt ehrlich über Fehler, Server schützt UX.
- Branch nicht zu master gemerged — andere unreleased Branches (fix/manager-memory-leaks etc.) müssen vom User später reconciled werden, sonst geht deren Server-Work verloren.

### Offene Fragen
- Wie soll das Multi-Branch-Geflecht (`feat/voice-prompt-enhancer`, `fix/manager-memory-leaks`, `feat/cloud-observer`, `feat/chrome-remote-control`) zusammengeführt werden? Aktuell zieht `tms-terminal update` nur einen Branch.
- Code-Review-Follow-ups (alle minor): 4. Test für `child.on('exit')` Path, Tighten busy-error Test, `SIGTERM` für graceful shutdown statt `SIGKILL`, optional unused `isBusy()` export entfernen.

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


## 2026-10-26 — Fold-Splitscreen nach Freigabe umgesetzt

- Ausgangspunkt: Bei aufgeklapptem Fold mit Video oben und Tastatur blieb im TMS-Terminal zu wenig lesbare Ausgabe. Nutzer hat den über Localhost/Tailscale bereitgestellten interaktiven Mockup mit "ja passt" freigegeben.
- Neue kompakte Season-2-Ansicht für kurze Fenster; bestehende PTY, Eingabe, Sondertasten und Recorder werden weiterverwendet. Sitzungswechsler, Lesefokus und Schriftgrößenwahl sind im schmalen Kopf zugänglich.
- Viewport- und Inhaltsgrößen werden beobachtet; stabile PTY-Resizes berücksichtigen jetzt auch schrumpfende Höhen. Entwürfe werden je Sitzung einschließlich des bereits gesendeten Textstands gespeichert und ohne erneute Eingabe wiederhergestellt.
- Der native HTML-Build bettet die neuen CSS-/JS-Dateien ein. 108 Tests bestanden, 2 Browser-Tests übersprungen; acht generierte Inline-Skripte syntaktisch gültig.
- Visuelle Prüfung auf dem echten Fold mit Samsung-Tastatur steht aus. Keine GitHub-Veröffentlichung, kein Push, keine automatische Installation auf dem Handy.

### Build-Abschluss dieser Sitzung
- Quellcode ins separate Repository übernommen und Dateihashes verglichen; `git diff --check` sauber. Testlauf auch direkt im Zielrepository: 108 bestanden, 2 Browser-Tests übersprungen. Eingebettetes HTML mit acht Skripten syntaktisch geprüft.
- Kein APK-Artefakt: Gradle wartet schon in der React-Native-Konfiguration. Node 22 behebt das erste CLI-Import-Hängen, nicht das anschließende `cli config`-Hängen. Thread-/Prozessdiagnose zeigt blockiertes synchrones Lesen lokaler Abhängigkeiten; Einzel-Lesetests gelingen. Ursache nicht abschließend geklärt. Auch TypeScript-Gesamtprüfung blieb ohne Ausgabe hängen.
- Eigene Build-/TypeScript-Prozesse beendet. Kein `deploy.sh`, kein pauschales Beenden von Gradle-/Node-Prozessen, keine Installation, kein Release. Die lokale Implementierung ist gespeichert; APK und Fold-Gerätetest bleiben offen.


## 2026-10-26 — Veröffentlichung des Fold-Updates angefordert

- Nutzer hat Commit, Push und Release ausdrücklich freigegeben, damit die App das Update anbietet. Zielversion v1.123.7, Android-versionCode 22307 (app.json und build.gradle synchronisiert).
- Vorhandenen GitHub-Release-Workflow gefunden: Er umgeht das bereits dokumentierte lokale Headless-Metro-Problem und nutzt den bestehenden Signaturschlüssel aus Repository-Secrets. Letzter erfolgreicher Release: v1.123.6 am 22.10.2026.
- Workflow ergänzt um WebView-Build und Regressionstests vor dem APK-Build; Release-Text beschreibt das Fold-Update. Keine neuen Berechtigungen, Schlüssel oder Runner-Dienste nötig.
- Nächste Prüfung: Tag-Build erfolgreich, APK mit korrekter Paketkennung/Version/Signatur, öffentlicher Latest-Release-Endpunkt für den In-App-Updater. Gerätetest mit echter Samsung-Tastatur bleibt anschließend erforderlich.

### CI-Korrektur für v1.123.8
- v1.123.7: Feature-Commit `b16ceaf` und Tag erfolgreich gepusht. Die neue Teststufe stoppte korrekt vor Signierung/Veröffentlichung: prayer-counter/term-text benutzten absolute Mac-Pfade; tab-identity importiert TypeScript direkt, was Node 20 nicht unterstützt.
- Pfade relativ zur Testdatei gemacht und Node 22 mit explizitem Type-Stripping für die Tests ergänzt. Android/Metro bleibt auf dem zuletzt erfolgreichen Node 20. Keine Tests deaktiviert.
- Neues Release-Ziel v1.123.8 / code 22308; der bereits gepushte, fehlgeschlagene Tag v1.123.7 bleibt unverändert.

### Release abgeschlossen
- v1.123.8 / Android code 22308 erfolgreich veröffentlicht: https://github.com/Kashino17/tms-terminal/releases/tag/v1.123.8. Feature-Commit `b16ceaf`, CI-Korrektur/Release-Commit `0cb0c5c`, Tag v1.123.8. Branch und Tag gepusht.
- GitHub-Lauf 40306140012: WebView-Build und alle 108 ausführbaren Tests erfolgreich (2 Browser-Checks übersprungen), Android-Build/Signierung und Veröffentlichung erfolgreich.
- Veröffentlichte APK (104537152 Bytes) heruntergeladen: Paket `com.tms.terminal`, v1.123.8/code 22308, arm64; Zertifikat identisch zur installierbaren Vorgängerversion v1.123.6. SHA-256: `2c6853be0ff72cbe55cfe3d0816ec96af70dc0f5f581135d7627624463dd8a11`.
- Öffentlichen Latest-Release-Endpunkt ohne Anmeldung geprüft; die App findet die neue APK über ihren vorhandenen Updater. Einstieg: Einstellungen → Nach Updates suchen. Keine direkte Installation auf dem Gerät vorgenommen.
- Git-Push hing mit Delta-Packung; der erfolgreiche Aufruf verwendet temporär `pack.window=0`, `pack.threads=1`, HTTP/1.1 und `gh auth git-credential`, ohne globale Git-Konfiguration zu ändern.

## 2026-10-28 — Diagnose Verbindung bei Bildschirm-Aus und Ruhezustand

- Nutzer meldet Verbindungsabbrüche bei ausgeschaltetem Bildschirm bzw. MacBook-Ruhezustand ohne Netzteil und möchte keinen zusätzlichen Energieverbrauch.
- Nur Diagnose, keine Änderungen an App, Server, Tailscale oder Energieeinstellungen, kein neuer Release. Ursache am Gerät nicht reproduziert.
- Aktuelle read-only-Abfrage: Netzbetrieb; pmset AC sleep=0, displaysleep=10, womp=1. Ausgelesene letzte Ereignisse zeigen Display-Aus/Ein; daraus kein Nachweis eines System-Sleep-Abbruchs. Akku-Schlafverhalten nicht verifiziert.
- Installierte Tailscale.app laut Info.plist: 1.94.1. Offizielles Changelog nennt in 1.98.8 Korrekturen für Verbindungen nach OS-Wake; aktueller Changelog-Stand 1.104.2. Update ist ein sinnvoller Ansatz, aber keine bewiesene Ursache des konkreten Abbruchs. Quelle: https://tailscale.com/changelog
- Aktueller TMS-Code hält getrennte PTYs ohne Idle-TTL; automatische Wiederverbindung und AppState-Vordergrundbehandlung bestehen bereits. WebSocket-Retries laufen bis maximal 5 Sekunden Abstand; ein expliziter Handshake-Timeout fehlt. Verbesserungsansatz: begrenzter Verbindungsaufbau, verlässliche Wiederaufnahme und langsamere Versuche bei längerem Offline-Zustand statt zusätzlicher Wake-Locks.
- Technische Grenze: Display-Aus und System-Schlaf unterscheiden. Normaler System-Schlaf unterbricht interaktive Terminal-Ausführung; automatisches Wiederverbinden kann erst nach Wake/Netzrückkehr helfen. Durchgehende Arbeit erfordert einen wachen Rechner und kann gegenüber Schlaf nicht ohne Mehrverbrauch versprochen werden. Empfohlen: bestehendes Energiesparen erhalten und Wiederaufnahme verbessern; bei gewünschtem Live-Betrieb nur während tatsächlicher Nutzung wachhalten, als expliziter Energie-Kompromiss.

## 2026-11-05 — Terminal-Darstellung: Breite, Dopplungen, OpenCode/Windows, Links

- Analyse + Plan-Seite mit Fragen: https://claude.ai/artifact/CRvLBa2xfpSYR9svMNvCrh (Antworten in db `answers`).
- Ursache „zerhackt“: bridge.js `measureCell` zählte die Stapel-Verkleinerung mit → Karten hinter der aktiven bekamen 42/46/50 statt 39 Spalten, jeder Wisch = SIGWINCH. Live per `stty` auf den PTYs bewiesen.
- Ursache „doppelt“: Zeilen-Ratsche war in v1.123.7 entfernt → Tastatur drückte PTY auf 13 Zeilen, Claudes Live-Bereich höher → Ink lässt Kopien stehen. E2E (echte Seite + echter Claude Code): 1 → 14 Köpfe; mit Ratsche 1, 0 Resizes.
- Feste Breite 50 Spalten (Schrift folgt Kartenbreite, 10–20 px) + kompakter Handy-Rand (6 px statt 32 px). Schriftregler entfallen.
- OpenCode/Windows: ConPTY schluckt Maus-DECSET; Prozessname unter Windows nie ermittelt (pgrep/ps) und `opencode.exe` nicht erkannt → Fix: Get-CimInstance (tiefster Nachfahre), neue Nachricht `terminal:process` bei Alt-Screen-Start, isMouseTui strippt Pfad/.exe.
- Windows-Server: `tms-terminal update` brauchte bash → scheiterte immer. Jetzt bin/update-runner.js (Node); doctor prüft Fernzugriff (Encoder, ddagrab, Sitzung, Probeaufnahme); ffmpeg Baseline/-bf 0. Windows-PC offline → nicht live getestet; erstes Update dort manuell.
- Links: Rand-Regel aus Nachbarzeilen (alter Verlauf mit anderer Breite) + Aufzählungszeichen nie Fortsetzung.
- Releases: v1.123.9, v1.124.0, v1.124.1, v1.124.2 (alle CI grün, latest = v1.124.2). Server-Commit f88aa3e gepusht (Windows).
- v1.124.3: Verlauf nach App-Neustart — App meldet `fresh` (leeres Terminal), Server schickt dann immer das Vollbild.

## 2026-11-05 (abends) — Verlauf nach Server-Neustart, Box-Reste, Akku

- Server-Neustart (21:42/21:52, mit Aufpasser-Skript ~/.tms-terminal/restart-guard.sh) — alle Claude-Sitzungen liefen im Wächter weiter.
- „Verlauf weg“ nach Neustart: neuer Server legte für übernommene Terminals einen LEEREN Spiegel an; das nächste Vollbild ersetzte den App-Verlauf. Fix `e6805d7`: Spiegel werden beim Herunterfahren gesichert und beim Übernehmen eingespeist; Spiegel ohne Vorgeschichte schicken nur an leere Clients ein Vollbild.
- „Dopplungen“: Server-Spiegel selbst enthielt die Reste → nicht App. Ursache belegt mit echtem Claude Code: Unteragenten-Bestätigungen zeigen ganze Befehle (bei 50 Spalten 100–160 Zeilen); Box höher als PTY (31) → Reste. 31 Zeilen → Reste, 200 → keine.
- Fix v1.125.0 (`32a3d27`): virtuelle Höhe 200 Zeilen, Karte schneidet Leerzeilen ab, liest nur geänderte Zeilen neu (xterm-interne Meldung); Server-`screen()` endet beim Inhalt (Auto-Approve).
- Wärme-Fund: versteckte xterm-Renderer bauten bei jedem Rollen alle Zeilen neu (Auswahl-Logik, am Pause-Schalter vorbei) — stillgelegt. Messung (CPU 4× gedrosselt, 10 Terminals Dauerausgabe): 47 → 37 ms Arbeit/s; Fehlerfall: 10 Reste/196 falsche Zeilen → 0/0.
- Tests: Server 495/495, App 121 bestanden; CI-Lauf 42039586986 grün, v1.125.0 = latest.

## 2026-11-05 (spät) — Windows, Dateien-Gerätewechsel

- Windows-PC zunächst offline; Analyse: node-pty nutzt System-ConPTY (useConptyDll=false) → alternativer Bildschirm wird nicht weitergegeben. Folgen: vim/less mit 200 Zeilen (seit v1.125.0), OpenCode-Maus erst nach Neuverbindung. Fix v1.125.1 (`51ace4c`): ProcessWatch (win32, 4 s Drossel + nachlaufende Prüfung, geteilte PowerShell-Tabelle 1,5 s), App-Namensliste FULLSCREEN_TUIS; Mac meldet auch das Ende einer Vollbild-TUI. Nachgestellt (1049 entfernt): 200 → 32 → 200.
- Mac-Server-Neustart 22:52: Verlaufssicherung live bestätigt. Log-Meldung präzisiert (`81fdb2f`).
- Windows später erreichbar (5 ms), aber kein Server auf 8767; SSH-Notizen lesen vom Auto-Mode blockiert → Nutzer soll `tms-terminal doctor` ausführen oder Benutzer/Schlüssel nennen.
- Dateien: Windows-Pfad nach Gerätewechsel am Mac → HTTP 400 (belegt), Ansicht hing dauerhaft. Fix v1.125.2 (`625b8e1`): Reset auf ~ bei Serverwechsel (Leiste + Vollbild), Rückfall auf ~ bei 400/403/404, Windows-Pfade (filePaths.ts + TMS-TEST-EXPORT fsPath, 3 Tests).


## 2026-11-07 — Alle Geräte in einer Ansicht (v1.126.0)

- Nutzer: mit 2 Geräten ständig zwischen Übersicht und Terminals wechseln = Arbeitsfluss kaputt. Erste 3 Redesign-Varianten (Werkbank/Leitstand/Räume) abgelehnt; Fragen gestellt → Konzept: EINE Buchstaben-Leiste mit Terminals beider Geräte, Fernzugriff aus der Insel mit nahtlosem MAC/WIN-Wechsel, Liquid-Deck-Optik bleibt, Stapel/Liste/Übersicht-Knöpfe raus. Mockups per Tailscale (:8510) gezeigt, freigegeben ("bring es live").
- Umsetzung `f65ad9b`: RN verbindet neben dem Hauptserver jedes erreichbare Gerät (Peers), sessionId→Server-Routing, create-FIFO pro Server, Seite meldet `terminal:restored` pro Karte; Leiste nach Gerät gruppiert, Insel "+" mit Geräte-Wahl + Fernzugriff, `TMSRemote.switchTo`.
- Geprüft: tsc 0 Fehler, 125/127 Tests (2 Browser übersprungen), HTML-Diff nur eigene Änderungen, Browser-Simulation mit 2 Geräten (Gruppen, Routing, Create auf WIN, Fernzugriff-Wechsel) und 1 Gerät (unverändert). Echter Gerätetest steht aus.

## 2026-11-07 nachts — Diktat-Streaming (v1.127.0)

- Nutzer: Wispr Flow als Vorbild; unsere Transkription langsam, bricht ab („Zeitüberschreitung“), sperrt danach. Gemessen: Modell NICHT schuld (4 min = 10,6 s large-v3 / 3,8 s turbo). Ursachen im Code: Upload erst nach Stopp als 5-MB-Nachricht, `send()` verwirft still bei getrenntem Socket + Datei schon gelöscht, Ergebnis an alten Socket, Mikro-Sperre in processing, Sidecar-Stau, Rewriter schnitt bei 512 Tokens ab, leise Sprache als Stille weggeschnitten.
- Umsetzung (Design+Plan, TDD): Streaming-Upload während Aufnahme, Byte-Offset-Protokoll mit resume/Neu-Upload, Vorab-Transkription, ✕ gibt frei, Fallback für alte Server, Ende-/Dauer-Logs. Opus-Review: 1 Critical (Offset-Rennen) + 7 Important behoben.
- Leise Sprache: Normalisierung NACH dem Stille-Schnitt; adaptiver Schnitt verworfen (Raumrauschen → „Vielen Dank.“). 0,5-%-Pegel geht weiter verloren (wie vorher).
- Parallel-Job hatte v1.126.0 genommen → rebased, als v1.127.0 released. Server-Neustart steht aus (Nutzer).
- Nachtrag v1.127.1 (`b9cd2f3`): Dateien-Leiste/Explorer folgen dem Gerät des vorderen Terminals (term:active); Fingerabdruck pro Gerät (sudo → Gerät der Sitzung, Fernzugriff → angezeigtes Gerät, Windows → Hinweis). tsc 0, 125 Tests grün, Browser-Simulation bestätigt die Meldungen.

## 2026-11-07 früh — Diktat-Bubble (v1.128.0)

- Teil 2 nach Wispr-Vorbild: Bedienungshilfe + Overlay in allen Apps, Tippen = Aufnahme, ✓ = einfügen (nur in die App, in der ✓ gedrückt wurde), sonst Zwischenablage, Halten = 15 min schlafen. Server: schlanke `?role=dictation`-Verbindung (normale Verbindungen übernehmen `currentWs`).
- Kotlin-Logik pure + JUnit (33 Tests), Test-Server `server/scripts/dictation-test-server.ts` (Port 8799, TEST_AUDIO/DELAY_MS) für Emulator-E2E. Emulator bekommt keinen Host-Mikroton → echte Mikro-Prüfung erst am Fold.
- Opus-Review: Critical = gleichnamiges `var origRenderSettings` im Bridge-IIFE → Season 2 startete nicht; neuer Browser-Test `mobile/scripts/webview-bubble.test.mjs` (TMS_VIZ_PW). 8 Important behoben.
- Parallel-Job hatte v1.127.1 → rebased, liquidDeckHtml neu gebaut, Diff = nur Bridge-Block.

## 2026-11-07 — Bubble v1.129.0 (Redesign, direktes Einfügen)

- Nutzer: alles landete in der Zwischenablage, in TMS selbst nie eingefügt; UI hässlich, beim Abschicken „verschwindet kurz nach rechts“; Bubble nur mit Tastatur.
- Ursache TMS: bei Web-Inhalten liefert findFocus den FrameLayout statt des Eingabeknotens → Baumsuche. Einfügen jetzt per SET_TEXT ohne Zwischenablage; Zwischenablage nur bei Tastatur zu / kein Feld / App-Wechsel. Sichtbar nur mit IME-Fenster.
- Neues Design (BubbleView gezeichnet, Kreis↔Pille-Morph, Bogen beim Transkribieren, Häkchen/Ablage-Symbol, Schütteln bei Fehler). Springen = Android-Move-Animation bei wandernder linker Fensterkante → zwei feste Fenster mit Übergabe. Per Screenrecord-Frames verifiziert.


## 2026-11-07/08 — Bubble: dauerhaft aktiv + Akku (v1.129.1, v1.129.2)

- Bubble verschwand nach längerem Hintergrund trotz Samsung „Nie schlafende Apps“. Emulator (Stock-Android) rebindet nach kill -9 in 1 s → Samsung-Verhalten; Wispr-Doku bestätigt („disconnect Accessibility while Settings still shows it enabled“). Nutzer lehnt adb/Wireless-Debugging ab → nach Wispr-Vorbild gebaut: `BubbleKeepAliveService` (FGS specialUse, START_STICKY, Wächter „getrennt – tippen“).
- Danach Akku leer in Minuten. Messung (Release v1.129.0 im Emulator): A11y-Bindung hielt App-Prozess auf adj 100 → nie eingefroren, RenderThread zeichnete im Hintergrund. Fix: Bubble + Keep-Alive in `:bubble`-Prozess (MainApplication ohne RN-Init dort), Prefs nach Besitzer getrennt (MODE_MULTI_PROCESS), Feldsuche erst nach billigen Checks. 1,83 s → 0,09 s CPU/min.
- v1.129.2: Benachrichtigung fehlte (keine POST_NOTIFICATIONS-Abfrage in Season 2) → Zeile „Hintergrund-Schutz“ + TMS startet Keep-Alive bei jedem Öffnen. Nutzer: klappt, Benachrichtigung sichtbar. Akku-Beobachtung läuft.

## 2026-11-08 — Bubble-Stopp erkennen + Diagnose (v1.129.3)
- Bubble weg trotz Schalter an; Emulator: `am stop-app` (= „Stopp“ in Aktive Apps) → Dienst „crashed“, kein Rebind, auch nicht beim App-Öffnen; nur Schalter aus/ein (Nutzer bestätigt).
- Erkennung via gebundene Dienste, Hinweis/Benachrichtigung führen zum Schalter, „Letzter Abbruch“ aus ApplicationExitInfo.
- Feld-Erkennung robuster (Nachprüfen + Cache leeren); CPU-Mehrkosten im Rauschen.

## 2026-11-08 — Bubble-Anzeige-Fix (v1.129.4)
- v1.129.3: Bubble einmal sichtbar, danach nie wieder (Status gebunden/an). clearCache() in Nachprüfung entfernt; „Letzte Prüfung“ in Einstellungen (Entscheidung + Sekunde).
- Emulator: nach Update kann „Bound + Crashed“ entstehen → An aber unsichtbar, Toggle hilft (nicht sicher die Fold-Ursache).

## 2026-11-08 — Bubble-Erkennung neu (v1.129.5)
- Nutzer: Bubble erscheint oft erst nach 2–3× Öffnen, „Pflaster statt Ursache“. Erkennung umgebaut: Android-Eingabesitzung (Passwort aus inputType) statt Feldsuche im App-Baum; Cursor-Bewegung als Auslöser.
- „Protokoll kopieren“ für Fehlersuche am Fold. Emulator-Tests ok; alter Code dort ebenfalls ok → Wirkung am Fold offen.

## 2026-11-08 — Bubble v1.129.6
- Fold-Protokoll ausgewertet: Feld immer erkannt, Ausfall = Tastatur nicht in Fensterliste gesehen + keine spätere Fenstermeldung. Fix: bei aktivem Feld ~10 s jede Sekunde nachschauen, Accessibility-Cache aus, Protokoll „Tastatur meldet sich“. Released ohne Emulator-Test (Mac überlastet), Nutzer testet am Handy.

## 2026-11-08 — Bubble v1.129.7
- Protokoll v1.129.6: Erkennung ok („sichtbar“), aber Bubble nicht auf dem Schirm. Ursache im Overlay: Position nur einmal berechnet (Fold innen→außen = außerhalb), verlorenes Fenster nicht neu angelegt. Fix + Protokoll-Zeile „Bubble bei x,y“. Released ohne Emulator-Test (Mac überlastet).

## 2026-11-08 — Bubble v1.129.8
- Protokoll v1.129.7: Position jetzt ok; Restausfälle ohne jedes Tastatur-Signal, Nutzer bestätigt Tastatur war offen. Suche auf allen Displays + Fensterliste im Protokoll bei Ausfall. Emulator 5/5.

## 2026-11-08 — Bubble v1.129.9
- Protokoll + Screenshots: Bubble-Fenster da, aber Einblend-Animation (alpha 0→1) lief am Samsung nicht an → durchsichtig. Jetzt sofort sichtbar, Animation nur Deko, Ausblenden per Timer. Emulator ok auch ohne Animationen.

## 2026-11-09 — Fernzugriff v1.129.10
- Flackern MAC/WIN beim Wechsel: Handler hingen an globaler `ws`; später onclose der alten Verbindung nullte die neue, Neuversuch + verwaiste Ströme in einem Dekoder. Fix Socket-Identität, remoteWantId, RN schickt id. Test webview-remote-switch.test.mjs (vorher 3/3 rot, jetzt grün).
- Windows-Delay: Zeiger nur im Video, relative SendInput mit Beschleunigung, PowerShell-Schleife → cursor-helper.ps1 + draw_mouse=0, exaktes rel, C#-Run-Loop, scale korrekt. C# per dotnet LangVersion 5 geprüft. Windows-PC offline, nicht live getestet.

## 2026-11-09 — Fernzugriff v1.129.11
- Windows-Standbild: Verwerfen + kein Vollbild auf Anfrage + keine Live-Bitrate. Fix: größeres Budget/keine Vollbild-Verwürfe/App-Rückstand 8, Bitrate via zweitem ffmpeg (nahtlose Übergabe, Fake-ffmpeg-Prozesstest), Statuszeile zeigt Verwürfe.

## 2026-11-09 — Fernzugriff v1.130.0
- Mac-Sperrhinweis/Touch ID blieben auf WIN (Sperrzustand nie zurückgesetzt) → pro Verbindung, `unlock` in remote:started.
- Neu: Ton aufs Handy + Verdunkeln (Details Commit bb93c7d). Mac live geprüft (Ton-Pakete, Helligkeit 0/zurück), Windows nur kompiliert + Fake-Prozess-Tests; ffmpeg-Prüfphase-Falle (5 s ohne Ton) gefunden und behoben.

## 2026-11-09 — v1.130.1 + Update-Prüfung
- Windows-Features gingen nicht: Server dort alt; Update lief unsichtbar → afd5b60 (Vordergrund, stash, Stempel, /health build, version-Befehl).
- Hinweis-Spam: Sitzung lief nach Verlassen weiter → suspend beim Verlassen, Hinweis einmalig, Toast-Umbruch. Tests (alt rot, neu grün).

## 2026-11-10 — Windows virtueller Bildschirm + Fernzugriff bleibt (v1.131.0)
- Maus auf Windows tot: Backtick `r im Add-Type-Here-String → CR → C#-Compile-Fehler; Fix + Lint-Test; windowsHide überall (Konsolenfenster).
- Windows „Bildschirm aus“ = Virtual Display Driver (SYSTEM-Task schaltet, User darf nur auslösen), Probelauf auf PC ok, eingebaut; 2. Start scheiterte → „ffmpeg fehlt“ war Fehltext (capture_unavailable) → capture_failed + Log + Wiederholungen + `display restore`.
- Mac-Umbau abgeraten (bereits exakt 2:1 Retina), stattdessen Auto 1728.
- Fernzugriff bleibt bis zum Schließen (Server-Ruhe/Übernahme, remote:view, Insel-Punkt). Tests: Server 572, WebView 12 grün.

## 2026-11-10 — Fernzugriff-Redesign (v1.132.0)
- Mockup mit Nutzer: Bild = Trackpad, eine Leiste, Menü am Geräte-Chip; Runde 2: Pad-Fläche raus, Füllen/Ganz statt Leerraum, alles matt statt Glas.
- Live: bridge.js entschlackt (−233 Zeilen alter Zoom/Layout/Zeiger), neuer WebView-Test v2 (Fläche gefüllt, Gesten → Eingaben, Tastatur verkleinert nicht); Test fand „Füllen schrumpft bei Tastatur“ → behoben. Alle Mobile-Tests grün.
- Nachgelegt v1.133.0: Dateien senden/holen im Fernzugriff (Upload-Endpunkt, Explorer aufs Fernzugriff-Gerät inkl. iCloud Drive). Test fand Private-Network-Vorabfrage → Kopf + OPTIONS vor Auth.

## 2026-11-10 — Bund: kein Hauptserver (v1.134.0, Push offen)
- Ursache Dateien/Upload aufs falsche Gerät: alles hing an servers[0]; Umbau auf Geräte-Routing nach Terminal vorne.
- Mockup mit Nutzer über mehrere Runden (Leiste minimal, Desk-Layout, Karten mit Griff), dann Spec + Plan + 12 Tasks inline.
- E2E der echten Seite fand: Bund-Demo-Knopf warf in der App (brach setServers ab). Review (Opus): 6 Important (Browser-Bridge 2. Gerät, Holen, Desk-+, Diktat-caps, Filter, Desk-Status) + 3 hochgestufte Minors — alle mit Test rot→grün behoben.
- Push/Tag vom Auto-Modus blockiert → Nutzer muss freigeben.

## 2026-11-10 — Ohne Insel (v1.135.0) + Windows-Zwischenablage
- v1.134.0 nach Freigabe gepusht, CI grün. Windows-Server per SSH + geplante Aufgabe aktualisiert (npm-Link über SSH kaputt → node cli.js direkt).
- Windows-Zwischenablage gebaut, C# mit dotnet (LangVersion 5) auf dem Mac kompiliert, auf dem PC end-to-end getestet.
- Mockup 5 Varianten ohne Insel; Fehler: unsichtbares V5-Menü fing Tipps auf ⋮ ab → Menü oben links; Mockup-Leiste → schwebender Knopf. Nutzer wählt V3 (⋮-Menü) → eingebaut, E2E 14/14.

## 2026-11-10 — v1.136.0 Korrekturen
- Ursache Snippets eingefroren / Explorer springt auf / Galerie startet erneut: bridge.openToolSheet merkte Bund-Karten als `openTool`, jedes setTool der App rief origOpenTool → __bundTool erneut (Snippets: Endlosschleife tool:open↔setTool). Fix: Bund-Karten vor dem Merken abfangen.
- Bilder wieder alte Karte (Kamera + Galerie), ⋮-Menü zweistufig (Geräte untereinander).
- Windows-Papierkorb: DeleteFile auch für Ordner → DeleteDirectory, Pfad per Env; Sammel-Löschen meldet Fehlschläge. Auf dem PC echt geprüft.

## 2026-11-10 — v1.137.0 Puls-Ring
- Läuft ein Fernzugriff (body.remote-alive), pulsiert ein sanfter grüner Ring um ⋮ (nicht Splitscreen); im Menü schimmert „Fernzugriff“, aufgeklappt das laufende Gerät.

## 2026-11-10 — v1.139.0 In-App-Updater
- v1.138.0-Build scheiterte: paralleler Job hatte index.html geändert (uncommittet beim Build, committet nach dem Tag) → liquidDeckHtml.ts passte nicht zum Tag. Lehre: vor dem Tag `node scripts/build-season2-html.js && git diff --exit-code liquidDeckHtml.ts`.
- Updater: sucht Start/15 min/App-zurück, lädt APK in den Cache (expo-file-system), öffnet Installer (REQUEST_INSTALL_PACKAGES); matte Leiste statt Glas-Pille. Puls einmalig + Fernzugriff im Menü beenden mit drin.

## 2026-11-10 — Explorer: Vorschau/Senden/Teilen (in v1.139.0)
- Ursache leere Vorschau: Seite läuft als https://tms.local, Chromium Local Network Access sperrt img/video/XHR an Tailscale 100.x. Liste ging, weil RN sie lädt. Toasts lagen hinter dem Explorer (z 100 < 300) → Knöpfe wirkten tot.
- Fix 0a0f3d3: fileTransfer.ts — Vorschau nativ (Bild data:-URL, Video/PDF Android-Betrachter), Upload in Base64-Stücken über RN (`/files/upload?up&part&enc=b64`, GET `?caps=1`), #toasts z 400. Tests mit App-Ursprung (page.route https://tms.local).
- Kam mit v1.139.0 (Tag vom parallelen Job) raus, CI grün. Server-Teil braucht `tms-terminal update` auf Mac + Windows.

## 2026-11-10 — v1.140.0 Fernzugriff-Beenden echt
- Bug: ⋮-Menü-✕ beendete nichts am Rechner, UI sagte „beendet“. Ursache: Stopp ging über frische 2. Verbindung; Server beendete darüber nur die *ruhende* Sitzung — die laufende gehörte der pausierten Bildverbindung (remote:view false, nicht geparkt). Client markierte nach 0,8 s blind als beendet. Alter E2E-Test hatte __closeRemoteDevice gestubbt → Fehler verdeckt.
- Fix 1d5061f: Server `live`-Register (remote:stop von irgendwo beendet laufende/ruhende Sitzung, bestätigt immer); Menü → TMSRemote.closeDevice (Stopp über eigene ws, kein Reconnect, Bestätigung über frische ws, Ring erst mit remote:stopped weg, sonst ehrliche Meldung). Beide Server auf 8496966.

## 2026-11-10 — v1.141.0 Dateien holen: Umlaute + HEIC
- Gerätetest: Vorschau/Teilen/Laden → HTTP 400 bei „Görfidan Rückseite.PNG“. Ursache Server: Dateiname roh in Content-Disposition; macOS-NFD (o+U+0308) bzw. ı sind kein Latin-1 → Node wirft „Invalid character in header content“, catch → 400. Fix e88910d `disposition.util.ts` (RFC 6266 filename*=UTF-8''), auch ZIP. Braucht `tms-terminal update` Mac + Windows.
- HEIC/HEIF öffnet im Android-Betrachter (Seite schickt kind 'heic' → nativer Intent-Pfad), ff0cc18.

## 2026-11-10 — v1.142.0 Einstellungen neu + Installieren mit Rückmeldung
- Einstellungen = settings.js/settings.css (liquid-deck, im Build eingebunden): Startseite mit Suche, Bubble-Schnellzugriff, Kategorien (Symbol + Zustand), Unterseiten, Fold zwei Spalten. Ersetzt Bridge-Einschübe (Bubble-Gruppe, „Oberfläche“). Daten: TMSBridge.setSettings/bubbleStatus, prayerMeta, cloudAccounts; Änderungen settings:set + bestehende adhan:/bubble:-Nachrichten.
- Nur was in Season 2 wirkt. NICHT übernommen (wirken nur im klassischen Terminal): Terminal-Theme, Externe Tastatur, Inaktivitäts-Push, Deploy-Alerts/Polling. Hintergrund-Verbindung jetzt auch in S2 (ConnectionService beim Start).
- Neu nativ: Bubble 15 Min. pausieren aus der App (BubbleConfig.snoozeReq in App-Prefs, effectiveSnooze wie wake).
- Installieren: Zustand 'installing' + Ladekreis, Sperre gegen Mehrfach-Installer, Rückkehr ohne Install → Hinweis (AppState).
- Paralleler Job hatte v1.141.0 (Dateien/HEIC) in derselben Arbeitskopie veröffentlicht → mein Bump lief ins Leere; vor Tag immer `git ls-remote --tags origin vX` + app.json-Version prüfen.

## 2026-11-10 — v1.143.0 Installer + v1.144.0 Gebetsruf nativ
- v1.143.0: Installer am Emulator belegt — NEW_TASK versteckte InstallStart hinter TMS, expo-intent-launcher blockierte Folgestarts (ActivityAlreadyStarted). Fix ApkInstallerModule (startActivity aus Activity, Erlaubnis „Apps installieren“ zuerst).
- v1.144.0 Gebetsruf: Zeiten auf dem Handy (adhan-java 1.2.1), Land aus Zeitzone → Methode (assets/prayer_methods.json), JAKIM auf e-Solat kalibriert (Fajr/Isha 18° + 2 Min.; ±2 Min. ganzes Jahr), MUIS/Kemenag amtlich, Rest Aladhan ±1. Alarm-Kette nativ (setAlarmClock, Boot/TZ/Update). AdhanRingService: gesperrt Vollbild, entsperrt Overlay über allem; Stumm/Laut/Sperr-/Lautstärketaste. Einstellungen: Methode automatisch, nächster Azān, Erlaubnis-Checkliste.
- Emulator-Probe 1.144.0: KL-Zeiten = amtlich ±1 Min., Alarm als Wecker (exakt), Overlay bleibt nach Home, Lautstärke/Sperrtaste = Stumm, Laut spielt USAGE_ALARM, Alarm übersteht Neustart. Nicht testbar im Emulator: echter Sperrbildschirm mit PIN, GPS-Einspeisung (Ort per Picker gesetzt).

## 2026-11-10 — v1.145.0 Flackern beim Terminalwechsel
- Gemessen statt geraten: Emulator + zwei isolierte Test-Server (8790/8795, eigenes HOME), 6 Terminals mit Dauerausgabe. Seiten-JS unauffällig (keine Long Tasks); Last auf RenderThread/GPU (50–57 % bei Wechseln). screenrecord-Montage zeigt eckige Blöcke auf Dock/Punkten/Gerätelinie.
- Ursache: backdrop-filter auf ALLEN Stapelkarten, die beim Wechsel gleichzeitig federn. Fix: Glas nur auf `.stack-card.is-active` (Ruhebild identisch). 150→280 Bilder je 5 Wechsel, App-Antwort 201→139 ms, Artefakte weg. Aufgeklappte Desk-Ansicht hatte schon kein Glas.
- Lokal mit Playwright schlagen terminal-create/webview-bubble schon vorher fehl, webview-prayer hängt — CI (ohne Playwright) grün.
