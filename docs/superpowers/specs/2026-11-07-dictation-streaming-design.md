# Diktat auf Wispr-Flow-Niveau — Teil 1: Streaming + Zuverlässigkeit

Stand: 2026-11-07 · Branch `feat/fernzugriff` · Teil 2 (systemweite Bubble) folgt als eigenes Design.

## Warum

Der Nutzer hat Wispr Flow ausprobiert: minutenlange Nachrichten sind Sekunden nach dem Stopp eingefügt, fast fehlerfrei, auch leise/undeutlich. Unser Diktat lädt bei langen Aufnahmen ewig, bricht mit „Zeitüberschreitung“ ab, verliert dabei die Aufnahme und sperrt danach das Mikrofon. Erst wenn das auf Wispr-Niveau ist, lohnt sich die Bubble (Teil 2).

## Befund (gemessen / im Code belegt)

- **Das Modell ist nicht der Engpass.** 240 s AAC (wie vom Fold) auf dem Mac: mlx `whisper-large-v3` 10,6 s, `large-v3-turbo` 3,8 s; Modell ist beim Serverstart vorgeladen.
- **Upload erst nach Stopp, als EINE Nachricht** (4 min ≈ 5 MB Base64) — über DERP sehr langsam.
- **`websocket.service.ts send()` verwirft still**, wenn der Socket nicht offen ist; `useDictation` hat die Datei da schon gelöscht → Aufnahme weg, nach 90 s „Zeitüberschreitung“.
- **Ergebnis geht an den alten Socket** (Closure in `ws.handler.ts`) → nach Reconnect verloren.
- **Mikrofon gesperrt**, solange `micState === 'processing'` (Hook + `SeasonTwoWebRoot`-Wächter).
- **Sidecar-Stau:** 45-s-Stall-Watchdog verwirft den Request, der Python-Prozess rechnet aber seriell weiter → Folge-Diktate warten dahinter.
- **Rewriter schneidet ab:** `prompt_rewriter_sidecar.py` `MAX_TOKENS = 512` → lange Diktate mit „Prompt verbessern“ werden still gekürzt.
- **Leise Sprache:** `trim_silence` schneidet mit absoluter Schwelle (RMS 0,003) — sehr leise Aufnahmen werden als Stille verworfen; keine Pegelanhebung.
- **Blind:** Server loggt nur den Start einer Transkription, nie Ende/Dauer/Fehler.

## Wie Wispr Flow es macht (Recherche)

Cloud-ASR + feinabgestimmtes Llama zum Aufräumen, Ziel < 700 ms p99 Ende-zu-Ende; Audio wird während des Sprechens übertragen. Wir bleiben **lokal** (Nutzerwunsch, Mac ist schnell genug) und übernehmen das Prinzip: **die Arbeit passiert während man spricht**.

## Ziele

1. Ergebnis wenige Sekunden nach Stopp — unabhängig von der Länge (Ziel: ≤ 3 s für den Rest nach Stopp bei direkter Verbindung).
2. Keine verlorene Aufnahme mehr: Verbindungsabbruch, Reconnect, Server-Sidecar-Absturz → Diktat kommt trotzdem an (automatisch nachgeschickt).
3. Mikrofon nie gesperrt: ✕ während der Verarbeitung gibt sofort frei, danach kann man direkt neu aufnehmen.
4. Leise/undeutliche Sprache besser erkannt (Pegel-Normalisierung).
5. Server-Log zeigt pro Diktat Dauer, Länge, Ergebnis/Fehler.

## Nicht-Ziele

- Bubble / Bedienungshilfen-Dienst (Teil 2).
- Cloud-ASR, Modellwechsel um jeden Preis, Personal Dictionary/Lernen aus Korrekturen.
- Klassische (Nicht-Season-2-)UI-Pfade umbauen (`TerminalToolbar`, `OrbLayer`, `ManagerChatScreen*`) — die nutzen weiter `audio:transcribe`, das unverändert bleibt.
- Live-Zwischentext während des Sprechens anzeigen.

## Anti-Ziele (wäre ein Fehlschlag, selbst wenn es „läuft“)

- Genauigkeit schlechter als heute (z. B. durch Schnitte mitten im Wort).
- Text landet im falschen Ziel (falsches Terminal / als Tastatureingabe am PC).
- Doppelt eingefügter Text nach Reconnect/Retry.
- Alte App-Versionen gehen kaputt (Server muss `audio:transcribe` weiter können).

## Design

### Aufnahme (App, Android) — ohne nativen Code

- expo-av nimmt im **AAC-ADTS**-Format auf (`outputFormat: 6`, `audioEncoder: 3`, 16 kHz mono, 96 kbit/s, Endung `.aac`). ADTS ist ein Strom aus selbstständigen Frames: die halb geschriebene Datei ist jederzeit dekodierbar, und das Präfix dekodiert byte-identisch zum späteren Gesamt-Decode (verifiziert mit ffmpeg).
- Alle ~2 s liest der Hook die neuen Bytes der wachsenden Datei (`FileSystem.getInfoAsync` → Größe, dann `readAsStringAsync` mit `position`/`length`, nie über das Dateiende hinaus — die native Implementierung crasht sonst) und schickt sie.
- iOS bleibt bei WAV/lpcm und schickt die ganze Datei erst beim Stopp (gleiches Protokoll, nur ohne Streaming).
- Die Datei bleibt bis zum bestätigten Ergebnis erhalten.

### Protokoll (neu, idempotent über Byte-Offsets)

Jedes Diktat hat eine vom Client erzeugte `id`.

- `dictation:start { id, format: 'adts' | 'file', enhance }`
- `dictation:chunk { id, offset, data }` — `data` = Base64 der Bytes ab `offset`.
- `dictation:end { id, totalBytes }`
- `dictation:cancel { id }`
- `dictation:resume { id }` — nach Reconnect / bei Funkstille.
- Server → Client: `dictation:ack { id, bytes }` (Bytes, die der Server hat), `dictation:state { id, status: 'receiving'|'processing'|'done'|'error'|'unknown', bytes, text?, message? }`, `dictation:progress { id }` (Herzschlag während der Verarbeitung), `dictation:result { id, text }`, `dictation:error { id, message }`.

Regeln: Server hängt nur an, wenn `offset ≤ empfangen < offset+len` (überlappender Teil wird verworfen); bei `offset > empfangen` antwortet er mit `ack` des tatsächlichen Stands, der Client schickt ab dort neu. Damit sind Doppelsendungen harmlos und Lücken heilen sich selbst.

### Server: Diktat-Sitzungen

- Neues Modul `server/src/audio/dictation.ts`: `Map<id, DictationSession>` **unabhängig vom Socket**. Die Sitzung merkt sich den zuletzt aktiven Socket und antwortet dorthin; ein `resume` von einem neuen Socket übernimmt sie.
- Während `receiving` (nur `adts`): höchstens alle ~3 s gesamten Puffer per ffmpeg zu 16-kHz-float32 dekodieren (Pipe ok, ADTS braucht kein Seek; ffmpeg-Fehler am letzten halben Frame ist erwartet). Liegen hinter dem Cursor > 72 s Audio, wird bei einer Sprechpause nahe Cursor+60 s geschnitten (gleiche Logik wie `_find_pause_split` im Sidecar, nach TS portiert) und das Segment als WAV an den Whisper-Sidecar gegeben. → Gleiche Schnittstellen wie heute, also keine Genauigkeitseinbuße; nach Stopp bleiben ≤ 72 s Rest.
- Bei `end` (sobald alle Bytes da): Rest-Segment transkribieren, Segmente in Reihenfolge zusammenfügen, optional Rewriter (`enhance`), Ergebnis senden **und speichern**. Fertige/fehlerhafte Sitzungen 15 min aufheben (für `resume`), dann löschen; unfertige ohne Aktivität nach 10 min verwerfen.
- Herzschlag `dictation:progress` alle 5 s während `processing`.
- Logs: Start (id, Format), je Segment (Audio-s, Rechen-s), Ende (Gesamt-Audio, Zeit Stopp→Ergebnis, Zeichen), Fehler.
- `audio:transcribe` (alt) bleibt unverändert, bekommt aber dieselben Ende-/Fehler-Logs.
- Rate-Limiter: `dictation:*` in die Kategorie `typing` (billig pro Nachricht; die teure Arbeit bündelt der Server selbst).

### Server: Sidecar-Härtung

- Stall-Watchdog tötet den Sidecar (`SIGKILL`) statt nur den Request zu verwerfen → bestehender Exit-Handler startet neu und schickt die anderen offenen Requests erneut; kein Stau mehr.
- `whisper_sidecar_mlx.py`: Pegel-Normalisierung vor `trim_silence` (Spitze ≈ 99,9-Perzentil auf ~0,9 anheben, Verstärkung gedeckelt, z. B. ≤ 20×; nie absenken).
- `prompt_rewriter_sidecar.py`: `max_tokens` an Eingabelänge koppeln (≥ 512, ~2× Eingabe-Tokens); Server-seitiger Schutz: ist der Rewrite < 50 % der Wortzahl des Originals, Original verwenden.

### App: `useDictation` neu

- Weiterhin **ein Diktat zur Zeit** (die Season-2-Leiste kennt nur eine Aufnahme; keine Mockup-/Bridge-Änderung nötig). Aber: **✕ während „Transkribiere…“ gibt sofort frei** — `cancel()` schickt `dictation:cancel`, verwirft ein später eintreffendes Ergebnis und setzt `micState` sofort auf `'idle'`. Heute blockiert `toggle()` genau hier (Ursache der „läuft schon“-Sperre).
- Zuverlässigkeit: nach jedem Reconnect `resume` für alle offenen Diktate; bei `unknown` (Server neu gestartet) wird die gespeicherte Datei komplett neu hochgeladen (max. 3 Versuche). Kein fester 90-s-Abbruch mehr: Fehler erst, wenn der Server einen meldet oder 3 Versuche gescheitert sind; Funkstille-Wächter (60 s ohne Server-Nachricht bei offener Verbindung) löst `resume` aus, nicht Abbruch.
- Ein `result` für eine bereits abgeschlossene `id` wird ignoriert (keine Doppel-Einfügung).
- Fallback: meldet der Server `dictation:*` als unbekannten Nachrichtentyp (alter Server), nutzt der Hook den alten `audio:transcribe`-Weg. (Erkennung: kein `ack` binnen 5 s nach `start` → Fallback.)

## Entscheidungen (meine, zum Gegenprüfen)

- **Modell bleibt large-v3**, nicht Turbo: durch Streaming ist nach dem Stopp nur noch ≤ 72 s Rest übrig (~3 s), und large-v3 hat sich beim Testsatz einmal weniger verhört („Wettsocket“ bei Turbo). Umschalten bleibt eine Ein-Zeilen-Änderung, falls echte Aufnahmen etwas anderes zeigen.
- **Kein nativer Android-Code in Teil 1** (ADTS + Dateilesen reicht). Teil 2 braucht ohnehin einen nativen Recorder; dann kann der In-App-Weg nachziehen.
- **Kein „Erneut senden“-Knopf in Teil 1** — automatisches Nachschicken deckt die Fälle ab, solange die App läuft; ein sichtbarer Knopf kommt mit der Bubble-UI.
- **Kein Längenlimit** (Wispr: 5 min) — Streaming macht es unnötig.

## Was dem Umsetzer überlassen ist

Exakte Dateinamen/Struktur in `server/src/audio/dictation.ts`, Throttle-Werte innerhalb der genannten Größenordnung, Testaufbau (vitest-Gotcha `toFake: ['setTimeout','clearTimeout']` beachten).

## Verifikation

- Unit: Offset-Anhängen (Duplikat/Lücke/Überlapp), Pausen-Schnitt, Normalisierung, Rewriter-Schutz.
- E2E gegen echten Server-Code mit echtem Sidecar: 4-min-ADTS in 2-s-Stücken streamen, Zeit Stopp→Ergebnis messen (Ziel ≤ 3 s); Verbindungsabbruch mittendrin simulieren → Ergebnis kommt nach `resume`; Server-Sitzung weg → Neu-Upload.
- Leise-Test: Testaudio auf 2 % Pegel + Rauschen, vorher/nachher vergleichen.
- Auf dem Gerät erst nach Release (CI-APK) + Server-Neustart — beides braucht den Nutzer (Neustart killt laufende Sitzungen).
