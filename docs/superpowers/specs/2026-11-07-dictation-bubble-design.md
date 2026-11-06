# Diktat-Bubble — Teil 2: Wispr-Flow-Bubble in allen Apps

Stand: 2026-11-07 · Branch `feat/fernzugriff` · baut auf Teil 1 auf (`2026-11-07-dictation-streaming-design.md`, Protokoll `dictation:*`).

## Warum

Der Nutzer will die Wispr-Flow-Bedienung mit der eigenen (lokalen) Transkription: Überall, wo er eine Eingabezeile öffnet, erscheint ein kleines, transparentes TMS-Icon. Antippen → Aufnahme mit Senden/Abbrechen → Text landet im Feld, oder — wenn das Feld weg ist — in der Zwischenablage. Gedrückt halten → 15 Minuten schlafen legen. Vorbild-Screenshot: Icon frei schwebend über dem Terminal, Schlaf-Ziel (Zzz-Kreis) unten mittig.

## Ziele

1. Bubble erscheint in jeder App, sobald ein editierbares Textfeld den Eingabefokus hat (nicht bei Passwortfeldern); verschwindet, wenn kein Feld mehr fokussiert ist (außer während Aufnahme/Verarbeitung).
2. Frei verschiebbar; Position bleibt gespeichert.
3. Tippen → Aufnahme startet sofort; Panel mit Laufzeit, Pegel, ✕ (verwerfen) und ✓ (senden).
4. Nach ✓: Text wird ins aktuell fokussierte Feld eingefügt; gibt es keins mehr → Zwischenablage + Hinweis „In Zwischenablage kopiert“.
5. Gedrückt halten → Schlaf-Ziel unten erscheint; darauf loslassen → 15 Minuten unsichtbar (Wispr: 10). Woanders loslassen = nur verschoben. Aufwecken vorzeitig über die App-Einstellungen.
6. Gleiche Qualität/Zuverlässigkeit wie Teil 1: gleiches Streaming-Protokoll, Reconnect/Resume, Neu-Upload.

## Nicht-Ziele

- Eigene Tastatur (IME), Wispr-Funktionen wie Befehle/Personal Dictionary/Lernen aus Korrekturen.
- Shake-to-wake, iOS.
- Ersatz des In-App-Mikrofons in Season 2 (bleibt wie in Teil 1).

## Anti-Ziele

- Bubble über Passwortfeldern oder ständig im Weg (z. B. über der Tastatur festklebend ohne Verschieben).
- Text in falsches Feld / doppelt eingefügt.
- Die Haupt-App-Verbindung des Servers wird gestört (Manager-Nachrichten, Browser-Bridge).
- Stille Fehlschläge: wenn Android das Mikrofon still stellt, muss der Nutzer es merken.

## Design

### Android-Bausteine (Kotlin, `mobile/android/app/src/main/java/com/tms/terminal/bubble/`)

- **`DictationBubbleService`** — `AccessibilityService`. Ereignisse `typeViewFocused|typeWindowStateChanged|typeWindowsChanged|typeViewClicked`; nach jedem (entprellt ~150 ms) `findFocus(FOCUS_INPUT)` → sichtbar, wenn `isEditable && !isPassword` und das Fenster nicht unser eigenes ist. Hält Overlay, Recorder, Client.
  Mikrofon: Aufnahme direkt im Dienst (das System bindet Bedienungshilfen mit `BIND_INCLUDE_CAPABILITIES`, damit erbt der Prozess das Vordergrund-Mikrofonrecht — so arbeitet auch Wispr Flow). Kein Vordergrund-Dienst. Fehlt `RECORD_AUDIO` → Hinweis „Mikrofon-Berechtigung fehlt — TMS öffnen“ + App starten.
  Stille-Wächter: liefert `getMaxAmplitude()` 2 s lang nur 0 → Hinweis „Mikrofon blockiert“ (Android stellt Hintergrund-Aufnahmen still statt Fehler zu werfen).
- **`BubbleOverlay`** — Fenster `TYPE_ACCESSIBILITY_OVERLAY`, `FLAG_NOT_FOCUSABLE` (Fokus bleibt im Textfeld). Zustände: `bubble` (52 dp, abgerundet, halbtransparent, Wellenform-Symbol), `recording` (Pille: ✕ · Pegel · Zeit · ✓), `processing` (Pille mit Spinner + ✕), `toast` (kurzer Text, 1,8 s). Gesten: Tippen = Aufnahme; Ziehen = verschieben; Gedrückt halten (≥ 450 ms) = Schlaf-Ziel unten mittig einblenden, Loslassen darüber = schlafen. Position in Prefs; am Bildschirmrand eingeklemmt.
- **`BubbleRecorder`** — `MediaRecorder` AAC-ADTS 16 kHz mono 96 kbit/s (identisch zu Teil 1) in `cacheDir`, Pegel per `getMaxAmplitude()`.
- **`DictationSocket`** — OkHttp-WebSocket `ws://host:port?token=…&role=dictation`, Reconnect mit Backoff solange ein Diktat offen ist, sonst geschlossen.
- **`DictationUploadK`** — Kotlin-Port von `mobile/src/season2/hooks/dictationClient.ts` (gleiche Regeln: Offsets, Epoch gegen Reset-Rennen, `state`-Neupositionierung, `unknown` → Neu-Upload ≤ 3, ein Ergebnis genau einmal). Pure Kotlin, JUnit-getestet.
- **`TextInserter`** — Einfügen ins fokussierte Feld: Text in die Zwischenablage, dann `ACTION_PASTE` auf den Fokus-Knoten; scheitert das, `ACTION_SET_TEXT` mit an der Cursor-Position eingefügtem Text (`mergeAtSelection`, pure, getestet). Kein Feld → nur Zwischenablage.
- **`BubbleConfig`** — `SharedPreferences "tms_bubble"`: host, port, token, enhance, enabled, snoozeUntil, x, y.
- **`DictationBubbleModule`/`Package`** — RN-Brücke: `configure(host, port, token, enhance)`, `getStatus(): {serviceOn, enabled, snoozedUntil}`, `openAccessibilitySettings()`, `setEnabled(bool)`, `wake()`.
- Manifest: `<service android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">` + `res/xml/tms_bubble_accessibility.xml` (`canRetrieveWindowContent`, `flagRetrieveInteractiveWindows`), Beschreibungstext Deutsch.

### Server

- `role=dictation` im WS-Query → eigene schlanke Verbindung: nur `dictation:*` (gleicher `DictationManager`), **kein** `currentWs`-Wechsel, keine Titel/Unlock-Status, kein Manager-Distill beim Schließen, eigener Rate-Limiter.

### App (RN + Season-2-Seite)

- RN: sobald Hauptserver + Token bekannt → `configure(...)`. Neue Bridge-Nachrichten `bubble:open` (Bedienungshilfen öffnen), `bubble:toggle`, `bubble:wake`; RN → Seite `TMSBridge.bubbleStatus(...)` beim Öffnen der Einstellungen und bei App-Fokus.
- Seite: `bridge.js` umhüllt `renderSettings()` und hängt eine Gruppe „Diktat-Bubble“ an (Status, Ein/Aus, „schläft bis HH:MM — aufwecken“, Samsung-Hinweis „Nie schlafende Apps“). Kein Mockup-Edit nötig.

## Entscheidungen (meine)

- Schlafdauer 15 min (Nutzerwunsch), nicht Wispr-10.
- Einfügen per Zwischenablage + Paste zuerst: funktioniert auch in WebViews/Compose, wo `ACTION_SET_TEXT` den ganzen Inhalt ersetzt; Nebeneffekt: der Text liegt danach auch in der Zwischenablage (wie vom Nutzer für den Fallback gewünscht).
- Token in normalen App-Prefs (MODE_PRIVATE) wie AsyncStorage; keine EncryptedSharedPreferences (zusätzliche Abhängigkeit, gleicher Schutz durch App-Sandbox).
- Bubble nutzt immer den Hauptserver (wie das In-App-Diktat).

## Verifikation

- JUnit: Upload-Protokoll (Port der TS-Tests), `mergeAtSelection`, Sichtbarkeitsregel, Schlaf-Logik.
- Server: node:test für `role=dictation` (kein `currentWs`-Wechsel).
- Emulator (API 34, `emulator-5554`): Debug-Build, Dienst per `adb settings` aktivieren, Textfeld in fremder App → Bubble sichtbar (Screenshot); Aufnahme gegen lokalen Test-Server mit echtem Whisper (Mac-Mikro per `adb emu avd hostmicon`, `say` als Sprecher) → Text im Feld; Feld schließen → Zwischenablage; Schlaf-Geste.
- Fold: nach Release + Server-Neustart durch den Nutzer.
