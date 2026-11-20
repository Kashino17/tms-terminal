# Diktat-Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diktate werden während der Aufnahme gestreamt und serverseitig vorab transkribiert, überleben Reconnects und blockieren das Mikrofon nicht mehr.

**Architecture:** App liest die wachsende AAC-ADTS-Datei alle ~2 s und schickt Byte-Offset-Stücke (`dictation:*`). Server hält Diktat-Sitzungen unabhängig vom Socket, dekodiert per ffmpeg, schneidet bei Pausen ~60 s-Segmente und gibt sie an den bestehenden Whisper-Sidecar; nach Stopp bleibt nur der Rest.

**Tech Stack:** Node/TS (node:test + ts-node), Python mlx-whisper (pytest), React Native/Expo 50 (expo-av 13, expo-file-system 16).

**Spec:** `docs/superpowers/specs/2026-11-07-dictation-streaming-design.md`

## Global Constraints

- Live-Tree `~/Developer/tms-terminal`, Branch `feat/fernzugriff`; vor Push Remote prüfen.
- `audio:transcribe` bleibt verhaltensgleich (alte Apps, klassische UI).
- UI-Strings Deutsch, Code/Kommentare Englisch.
- Segmentierung: Ziel 60 s, Rest ≤ 1,2 × 60 = 72 s bleibt ungeschnitten, Pausensuche ±6 s, 100-ms-Fenster (wie `_find_pause_split`).
- Aufnahme Android: `extension '.aac'`, `outputFormat 6`, `audioEncoder 3`, `sampleRate 16000`, `numberOfChannels 1`, `bitRate 96000`.
- Fertige Sitzungen 15 min aufheben, unfertige nach 10 min Inaktivität verwerfen; Herzschlag alle 5 s; Decode-Throttle 3 s; Client-Lesetakt 2 s; Funkstille-Resume 60 s; max. 3 Upload-Versuche; Fallback auf `audio:transcribe`, wenn binnen 5 s kein `ack`.
- Server niemals selbst neu starten (killt alle Terminals inkl. dieser Sitzung) — der Nutzer startet neu.

## Review Focus

1. Reconnect mitten im Upload: Client sendet ab `ack`-Stand weiter, Text kommt genau einmal an.
2. Ergebnis kommt an, nachdem der Nutzer ✕ gedrückt hat: wird verworfen, nichts eingefügt.
3. Aufnahme kürzer als ein Lesetakt (< 2 s) / leer: sauberes leeres Ergebnis bzw. Hinweis, kein Hänger.
4. Server-Neustart während Verarbeitung (`unknown`): kompletter Neu-Upload aus der behaltenen Datei.
5. ffmpeg meldet Fehler am halben letzten Frame: Teil-Decode wird trotzdem verwendet.

---

### Task 1: Segmentierung + WAV (Server, rein)

**Files:**
- Create: `server/src/audio/dictation.segment.ts`
- Test: `server/src/audio/dictation.segment.test.ts`

**Interfaces:**
- Produces: `findPauseSplit(samples: Float32Array, targetIdx: number, rate: number, searchSecs?: number): number`; `nextCut(samples: Float32Array, cursor: number, rate: number, final: boolean): number | null` (Ende des nächsten fertigen Segments ab `cursor`; `null` = noch nicht genug; bei `final` immer `samples.length` sobald Rest ≤ 72 s); `encodeWav(samples: Float32Array, rate: number): Buffer` (16-bit PCM mono RIFF).

- [ ] Step 1: Tests: Pause mitten im Signal wird gefunden (Stille-Lücke bei 61 s in 80 s Rauschen → Schnitt innerhalb ±0,1 s der Lücke); `nextCut` liefert `null` bei 70 s ab Cursor (nicht final), eine Zahl bei 75 s, `samples.length` bei final ≤ 72 s; `encodeWav` → Header `RIFF`/`WAVE`, Länge 44 + 2·n, Sample 1.0 → 32767.
- [ ] Step 2: `cd server && npx ts-node` nicht nötig — `node --require ts-node/register --test src/audio/dictation.segment.test.ts` → FAIL.
- [ ] Step 3: Implementieren (Port von `_find_pause_split`/`split_audio` aus `whisper_sidecar_mlx.py`).
- [ ] Step 4: Test → PASS. Step 5: Commit `feat(dictation): pause segmentation + wav encoder`.

### Task 2: Diktat-Sitzungen (Server, Logik mit injizierten Abhängigkeiten)

**Files:**
- Create: `server/src/audio/dictation.ts`
- Test: `server/src/audio/dictation.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  type DictationStatus = 'receiving' | 'processing' | 'done' | 'error';
  interface DictationDeps {
    decode(bytes: Buffer, format: 'adts' | 'file'): Promise<Float32Array>; // 16 kHz mono
    transcribeWav(wavBase64: string): Promise<string>;
    rewrite(text: string): Promise<string>;
    now(): number;
    log(msg: string): void;
  }
  type DictationEvent =
    | { type: 'dictation:ack'; id: string; bytes: number }
    | { type: 'dictation:state'; id: string; status: DictationStatus | 'unknown'; bytes: number; text?: string; message?: string }
    | { type: 'dictation:progress'; id: string }
    | { type: 'dictation:result'; id: string; text: string }
    | { type: 'dictation:error'; id: string; message: string };
  type Sink = (ev: DictationEvent) => void;
  class DictationManager {
    constructor(deps: DictationDeps, opts?: { decodeThrottleMs?: number; heartbeatMs?: number; doneTtlMs?: number; idleTtlMs?: number });
    start(id: string, format: 'adts' | 'file', enhance: boolean, sink: Sink): void;   // idempotent; emits ack
    chunk(id: string, offset: number, data: Buffer, sink: Sink): void;               // unknown id -> state 'unknown'
    end(id: string, totalBytes: number, sink: Sink): void;
    cancel(id: string): void;
    resume(id: string, sink: Sink): void;                                             // rebinds sink, emits state
    sweep(): void;                                                                    // TTL cleanup
  }
  export function acceptRewrite(original: string, rewritten: string): string;      // rewritten unless < 50 % of original word count
  ```
  The manager owns one serialized work queue per session; `sink` of the latest call is where results go.

- [ ] Step 1: Tests (Fake-Deps, `decode` = gespeicherte Float32-Länge aus Bytes, `transcribeWav` zählt Aufrufe):
  - Duplikat (gleicher Offset zweimal) → Bytes einmal angehängt, `ack.bytes` unverändert korrekt.
  - Überlapp (offset < received < offset+len) → nur Rest angehängt.
  - Lücke (offset > received) → nichts angehängt, `ack` mit tatsächlichem Stand.
  - `adts` mit > 72 s → Segment wird VOR `end` transkribiert; nach `end` nur noch der Rest; Ergebnis = Segmenttexte in Reihenfolge, mit Leerzeichen.
  - `end` mit `totalBytes` > empfangen → wartet; fehlendes Stück kommt → Ergebnis.
  - `resume` von neuem Sink nach `done` → `state` mit `text`; Ergebnis landet beim neuen Sink, wenn Rebind vor Fertigstellung.
  - `cancel` → kein `result`.
  - `transcribeWav` wirft → `dictation:error`, Status `error`.
  - `enhance` → `rewrite` aufgerufen; `acceptRewrite('a b c d', 'a')` → Original.
  - `sweep` nach 15 min → `resume` liefert `unknown`.
- [ ] Step 2: Test → FAIL. Step 3: Implementieren (Logzeilen: start, je Segment Audio-s/Rechen-s, Ende mit Gesamt-Audio + ms Stopp→Ergebnis + Zeichen, Fehler). Step 4: PASS. Step 5: Commit `feat(dictation): socket-independent streaming sessions`.

### Task 3: Verdrahtung im Server

**Files:**
- Create: `server/src/audio/ffmpeg-decode.ts` — `decodeToFloat32(bytes: Buffer): Promise<Float32Array>` (ffmpeg via stdin-Pipe für ADTS bzw. Temp-Datei für `file`; Ausgabe `-f f32le -ac 1 -ar 16000`; non-zero Exit MIT Ausgabe = ok). ffmpeg-Suche wie `_find_ffmpeg`.
- Modify: `server/src/websocket/ws.handler.ts` (neue `dictation:*`-Fälle neben `audio:transcribe`, ein Prozess-weiter `DictationManager` mit echten Deps: `transcribe()` aus `whisper-sidecar`, `rewrite` aus `prompt-rewriter-sidecar`; `sweep` per `setInterval(60_000).unref()`; Ende-/Fehler-Logs für `audio:transcribe` mit Dauer).
- Modify: `server/src/websocket/rate-limiter.ts` (`dictation:start|chunk|end|cancel|resume` → `typing`).
- Modify: `shared/` Protokoll-Typen, falls `ClientMessage` dort definiert ist.
- Test: `server/src/audio/ffmpeg-decode.test.ts` — echte ADTS-Fixture (per ffmpeg im Test erzeugt aus Sinus), abgeschnitten bei ungeradem Byte → dekodiert, Präfix identisch zum Gesamt-Decode.

- [ ] Steps: Test → FAIL → implementieren → `npm test` + `npx tsc --noEmit -p .` grün → Commit `feat(dictation): wire streaming protocol into ws handler`.

### Task 4: Sidecar-Härtung

**Files:**
- Modify: `server/src/audio/whisper-sidecar.ts` (`armWatchdog`: bei Stall Sidecar `SIGKILL`, damit der Exit-Handler neu startet und übrige Requests erneut schickt; der gestallte Request wird abgelehnt und nicht erneut geschickt).
- Modify: `server/audio/whisper_sidecar_mlx.py` — `normalize_level(samples) -> np.ndarray` (99,9-Perzentil |x| auf 0,9, Verstärkung ≤ 20, nie absenken, Stille bleibt Stille), aufgerufen in `transcribe_chunk` vor `trim_silence`.
- Modify: `server/audio/prompt_rewriter_sidecar.py` — `max_tokens = max(512, 2 * len(tokenizer.encode(transcript)))`.
- Test: `server/audio/test_whisper_sidecar_mlx.py` (`normalize_level`: 0,01-Pegel → Peak ≈ 0,9; 0,8-Pegel unverändert; Nullen bleiben Nullen; Gain-Deckel bei 1e-4-Pegel → Peak ≤ 20·1e-4·…).
- [ ] Steps: pytest FAIL → implementieren → `cd server/audio && .venv-mlx/bin/python -m pytest -q test_whisper_sidecar_mlx.py` grün → Leise-Benchmark (Testaudio ×0,02 + Rauschen, mit/ohne) dokumentieren → Commit `fix(whisper): level normalization, kill stalled sidecar, rewriter token budget`.

### Task 5: Client-Protokoll (App, rein)

**Files:**
- Create: `mobile/src/season2/hooks/dictationClient.ts`
- Test: `mobile/src/season2/hooks/dictationClient.test.ts` (Lauf: `cd server && TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register --test ../mobile/src/season2/hooks/dictationClient.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  interface DictationIO {
    send(msg: object): boolean;                         // false = not connected
    fileSize(): Promise<number>;
    readBase64(position: number, length: number): Promise<string>;
    now(): number;
  }
  class DictationUpload {
    constructor(id: string, format: 'adts' | 'file', enhance: boolean, io: DictationIO);
    readonly id: string;
    begin(): void;                                       // sends start
    pump(): Promise<void>;                               // sends bytes [sent, fileSize) ; never reads past EOF
    finish(): Promise<void>;                             // final pump + end(totalBytes)
    onServer(msg: { type: string; id?: string; [k: string]: unknown }): 'result' | 'error' | 'restart' | null;
    onReconnect(): void;                                 // sends resume
    text: string | null; error: string | null; attempts: number;
  }
  ```
  `ack` setzt `sent = acked` (heilt Drops). `state unknown` → `attempts++`, `sent = 0`, erneut `start`+alles+`end` (bei `attempts > 3` → `error`). `result` für bereits abgeschlossenes Diktat → `null`.
- [ ] Step 1: Tests mit Fake-IO: Pump liest nur bis Dateigröße; `send` false → nach `onReconnect` + `ack(bytes)` wird ab `bytes` weitergesendet; `unknown` → Neu-Upload ab 0, nach 3 Fehlschlägen `error`; zweites `result` → `null`.
- [ ] Steps 2–5: FAIL → implementieren → PASS → Commit `feat(dictation): client upload protocol`.

### Task 6: `useDictation` + SeasonTwoWebRoot

**Files:**
- Modify: `mobile/src/season2/hooks/useDictation.ts` (ADTS-Optionen; Pump-Intervall 2 s während Aufnahme; `toggle()` bei `processing` = no-op wie bisher, neu `cancel()`; Funkstille-Wächter 60 s → `onReconnect()`; Reconnect über `wsService`-State-Listener → `onReconnect()`; Fallback auf `audio:transcribe`, wenn binnen 5 s kein `ack`; Datei erst nach `result`/endgültigem Fehler/`cancel` löschen; Rückgabe `{ micState, toggle, cancel }`).
- Modify: `mobile/src/season2/SeasonTwoWebRoot.tsx` (`mic:cancel`: bei `micState==='processing'` `cancel()` statt `toggleMic()`; bei `recording` wie bisher discard+stop).
- [ ] Steps: `cd mobile && npx tsc --noEmit -p .` ohne neue Fehler in den berührten Dateien → Commit `feat(dictation): stream recording, never block the mic`.

### Task 7: E2E gegen echten Sidecar + Auslieferung

**Files:**
- Create: `server/scripts/dictation-e2e.ts` (nicht im Testlauf): echter `DictationManager` + echtes ffmpeg + echter Whisper-Sidecar; 240-s-ADTS (aus `say`) in 2-s-Stücken mit 10× Echtzeit einspielen; misst Stopp→Ergebnis; Variante mit verworfenem Stück + `resume`.
- [ ] Step 1: Lauf; Erwartung: Stopp→Ergebnis ≤ 3 s, Text vollständig, Resume-Variante liefert denselben Text.
- [ ] Step 2: `npm test`, `tsc` grün; Commit; Push auf `feat/fernzugriff` (Remote vorher prüfen).
- [ ] Step 3: App-Release: Patch-Bump `mobile/app.json` + `android/app/build.gradle` (versionCode-Formel), `--notes` in `.github/workflows/release-apk.yml`, Tag pushen, CI beobachten.
- [ ] Step 4: Nutzer bitten, den Server neu zu starten (`tms-terminal update`/Neustart) — nicht selbst tun.
- [ ] Step 5: Memory (`memory/project-state.md`, `memory/journal.md`, Auto-Memory) aktualisieren.
