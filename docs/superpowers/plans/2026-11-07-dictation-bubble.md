# Diktat-Bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Systemweite Diktat-Bubble (Android-Bedienungshilfe + Overlay), die das Streaming-Protokoll aus Teil 1 nutzt und Text ins fokussierte Feld oder in die Zwischenablage legt.

**Architecture:** Kotlin-`AccessibilityService` erkennt fokussierte Textfelder, zeigt ein `TYPE_ACCESSIBILITY_OVERLAY`, nimmt per `MediaRecorder` ADTS auf und streamt über eine eigene WS-Verbindung (`role=dictation`) an den Server. Reine Logik (Upload-Protokoll, Text-Merge, Sichtbarkeit/Schlaf) ist pure Kotlin mit JUnit.

**Tech Stack:** Kotlin 1.8 / Android SDK 34, OkHttp (aus RN), JUnit 4; Node/TS Server; Season-2 `bridge.js`.

**Spec:** `docs/superpowers/specs/2026-11-07-dictation-bubble-design.md`

## Global Constraints

- Paket `com.tms.terminal.bubble`; UI-Texte Deutsch.
- Aufnahme identisch Teil 1: `OutputFormat.AAC_ADTS`, `AudioEncoder.AAC`, 16000 Hz, mono, 96000 bit/s.
- Protokoll unverändert (`dictation:start/chunk/end/cancel/resume`, Antworten `ack/state/progress/result/error`), Chunk ≤ 64 KiB, Pump 2 s, max. 3 Upload-Versuche.
- Schlaf 15 min; Long-Press-Schwelle 450 ms; Bubble 52 dp.
- Kein Server-Neustart durch mich.

## Review Focus

1. Feld wird während der Verarbeitung geschlossen/gewechselt → Text in Zwischenablage, nicht in ein fremdes Feld der nächsten App? (Regel: eingefügt wird ins Feld, das bei Ergebnis-Ankunft fokussiert ist; Nutzerwunsch.)
2. Passwortfeld fokussiert → keine Bubble.
3. Mikrofon still gestellt → sichtbarer Hinweis.
4. Server nicht erreichbar → nach Ablauf klare Meldung, Aufnahme bleibt bis dahin erhalten.
5. Bubble-Verbindung stört die App-Verbindung nicht (Manager-Nachrichten weiter an die App).

---

### Task 1: Server — schlanke Diktat-Verbindung
**Files:** Modify `server/src/websocket/ws.server.ts`, `server/src/websocket/ws.handler.ts`; Test `server/src/websocket/dictation.connection.test.ts`.
**Produces:** `handleDictationConnection(ws: WebSocket, ip: string): void` (exportiert aus ws.handler); ws.server ruft sie bei `role=dictation` statt `handleConnection`.
- [ ] Test: Fake-WS bekommt `dictation:start` → `dictation:ack`; `currentWs`-Ziel (über `getCurrentWsForTest()`) bleibt unverändert; Nicht-Diktat-Nachrichten werden ignoriert.
- [ ] FAIL → implementieren → `npm test` + `tsc` grün → Commit.

### Task 2: Kotlin-Logik (pure) + JUnit
**Files:** Create `bubble/DictationUploadK.kt`, `bubble/TextMerge.kt`, `bubble/BubbleRules.kt`; Test `android/app/src/test/java/com/tms/terminal/bubble/*Test.kt`; `app/build.gradle` `testImplementation 'junit:junit:4.13.2'` + `org.json:json` für JVM-Tests.
**Produces:**
- `class DictationUploadK(id: String, format: String, enhance: Boolean, io: UploadIO)` mit `begin()`, `pump()`, `finish()`, `onServer(json: JSONObject): Outcome?` (`RESULT|ERROR|RESTART`), `onReconnect()`, Felder `text`, `error`, `attempts`, `ackSeen`, `lastHeard`, `isEnded`, `done`. `interface UploadIO { fun send(json: String): Boolean; fun fileSize(): Long; fun read(pos: Long, len: Int): ByteArray; fun now(): Long }` (synchron; Aufrufer läuft auf eigenem Thread).
- `fun mergeAtSelection(text: String, selStart: Int, selEnd: Int, insert: String): Pair<String, Int>` (neuer Text, neue Cursorposition; Leerzeichen-Regel: vor dem Einfügen ein Leerzeichen, wenn davor kein Leerraum steht).
- `object BubbleRules { fun shouldShow(editable: Boolean, password: Boolean, ownWindow: Boolean, busy: Boolean, snoozedUntil: Long, now: Long, enabled: Boolean): Boolean; fun snoozeUntil(now: Long): Long /* +15 min */ }`
- [ ] Tests (Port der 13 TS-Tests für den Upload, plus Merge: Mitte/Ende/Auswahl ersetzen/Leerzeichen; Regeln: Passwort, Schlaf, busy hält sichtbar) → FAIL → implementieren → `./gradlew :app:testDebugUnitTest` grün → Commit.

### Task 3: Android-Dienst, Overlay, Recorder, Socket, Einfügen, RN-Modul
**Files:** Create `bubble/DictationBubbleService.kt`, `BubbleOverlay.kt`, `BubbleRecorder.kt`, `DictationSocket.kt`, `TextInserter.kt`, `BubbleConfig.kt`, `DictationBubbleModule.kt`, `DictationBubblePackage.kt`, `res/xml/tms_bubble_accessibility.xml`, `res/drawable/bubble_*.xml`; Modify `AndroidManifest.xml`, `MainApplication.kt`, `res/values/strings.xml`.
- [ ] `./gradlew :app:assembleDebug` grün → Commit.

### Task 4: App-Seite (RN + Bridge)
**Files:** Modify `mobile/src/season2/SeasonTwoWebRoot.tsx` (configure + bubble:* Nachrichten + Status), `mobile/src/season2/web/bridge.js` (renderSettings-Hülle, `TMSBridge.bubbleStatus`), regenerate `mobile/src/season2/web/liquidDeckHtml.ts`; Create `mobile/src/native/dictationBubble.ts` (typisierte NativeModules-Hülle, no-op auf iOS).
- [ ] `node --check bridge.js`; `build:season2`; HTML-Diff = nur Bridge-Änderung; mobile `tsc` 0 Fehler; `npm run test:mockup` grün → Commit.

### Task 5: Emulator-E2E
**Files:** Create `server/scripts/dictation-test-server.ts` (Port 8799, echter DictationManager + Sidecar, Token-Prüfung aus).
- [ ] Debug-APK auf `emulator-5554`, Dienst + Mikro-Recht per adb, Prefs per `run-as`, Textfeld in fremder App → Screenshot Bubble; Aufnahme mit `say` über Host-Mikro → Text im Feld; Feld geschlossen → Zwischenablage; Schlaf-Geste → Bubble weg.
- [ ] Commit Test-Server.

### Task 6: Auslieferung
- [ ] Remote prüfen, Version-Bump (minor), Release-Notes, Tag, CI beobachten, „Latest“ prüfen; Memory aktualisieren; Nutzer: Server-Neustart + Bedienungshilfe einschalten.
