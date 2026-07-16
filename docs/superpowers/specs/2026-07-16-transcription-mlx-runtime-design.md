# Transkription robuster machen: MLX-Runtime + Resilienz

**Datum:** 2026-07-16
**Status:** Design / genehmigt zur Planung
**Betrifft:** `server/src/audio/whisper-sidecar.ts`, `server/audio/whisper_sidecar*.py`, `server/src/websocket/ws.handler.ts`

## Problem

Die Transkription bricht häufig ab, timeoutet und ist zu langsam. Ursachenanalyse:

- Runtime ist **`openai-whisper`** (die langsamste Whisper-Implementierung) auf MPS mit
  `fp16=False` → erzwingt fp32 auf der GPU, ~2× langsamer + mehr Speicher.
- Ein **einziger Gesamt-Timeout** pro Request (`calcTimeout`, skaliert mit Base64-Größe).
  Bei langen Audios (bis **8 Minuten**) ist das eine Wette auf eine große Zahl.
- **Ein** fehlgeschlagener Chunk wirft eine Exception → die **ganze** Transkription stirbt,
  auch wenn 7 von 8 Minuten schon transkribiert waren.
- Stirbt der Python-Sidecar mitten im Request, wird nur rejected, kein Neustart/Retry.
- Temp-Datei + (implizit) ffmpeg-Ladepfad als zusätzliche Fehlerquellen.

Hardware ist ein **M4 Max, 128 GB RAM** — die Langsamkeit liegt am Runtime, nicht an der Power.

## Ziel

Transkription, die über die gesamte Bandbreite (kurze Kommandos bis 8-Minuten-Diktate)
schnell und zuverlässig ist und Teilergebnisse liefert statt komplett zu scheitern.

## Nicht-Ziele

- Kein Umbau des Client-/Mobile-Aufnahmepfads (WAV 16kHz/mono/16bit bleibt).
- Kein Wechsel des WebSocket-Protokolls (`audio:transcribe` / `audio:progress` /
  `audio:transcription` / `audio:error` bleiben unverändert).
- Kein deutsch-finetuned Modell in diesem Schritt (bewusst zurückgestellt; als späterer
  Modell-Swap trivial nachrüstbar, da mlx-community-Repos austauschbar sind).

## Architektur

### Teil 1 — Runtime: `mlx-whisper` statt `openai-whisper`

- Neues Sidecar-Script **`server/audio/whisper_sidecar_mlx.py`** in eigenem venv
  **`server/audio/.venv-mlx`**. Das bestehende `whisper_sidecar.py` + `.venv` bleibt als
  Fallback unangetastet.
- Modell: **`mlx-community/whisper-large-v3-turbo`** (lädt beim ersten Start selbst von
  HuggingFace, wird nach MLX-Format konvertiert und lokal gecacht).
- **WAV direkt dekodieren statt ffmpeg:** Das WAV ist bereits 16kHz/mono/16bit. Wir parsen
  es mit Pythons `wave`-Modul zu einem `float32`-Numpy-Array (normalisiert auf [-1, 1]) und
  übergeben das Array direkt an `mlx_whisper.transcribe(audio_array, path_or_hf_repo=...,
  language="de")`. Damit entfällt **ffmpeg** als Abhängigkeit und die Temp-Datei-Logik.
- Chunking bleibt (60s-Segmente) — jetzt als Numpy-Slices statt Temp-WAV-Dateien.
  Zweck: Progress-Feedback + Speicher-Deckelung + Chunk-Resilienz (Teil 3).

**Node-Layer (`whisper-sidecar.ts`):** Python-Pfad auf `.venv-mlx/bin/python3` +
`whisper_sidecar_mlx.py` umstellen. JSON-Lines-Protokoll (Request/Progress/Response/Error)
bleibt identisch. Der `'Ready for requests'`-Marker auf stderr bleibt das Start-Signal.

**Modell-Mapping in `ws.handler.ts`:** Die aktuelle Heuristik
(`audio.length > 2MB ? 'turbo' : 'large-v3'`) entfällt — mlx-turbo ist schnell genug für
kurze Clips und gut genug für lange. Es wird durchgängig das Turbo-MLX-Repo genutzt.

**Erwartung M4 Max:** 8-Min-Audio in grob ~30–60s (statt Timeout), kurze Kommandos ~1s.

### Teil 2 — Watchdog-Timeout statt Gesamt-Timeout

Der Timeout in `whisper-sidecar.ts` wird von einem Gesamt-Request-Timeout zu einem
**„kein-Fortschritt"-Watchdog**:

- Ein Timer läuft mit fester Grenze (`CHUNK_STALL_TIMEOUT_MS`, Vorschlag **45s**).
- **Jede** eingehende Progress-Message (ein Chunk fertig) **resettet** den Timer.
- Der finale Response (oder Error) clearet ihn.
- Konsequenz: Solange Chunks fließen, läuft die Transkription beliebig lang. Abbruch nur,
  wenn ein **einzelner** Chunk länger als die Grenze hängt (= echter Hänger).

Damit wird die absolute Audio-Länge für den Timeout irrelevant. `calcTimeout` /
`TIMEOUT_PER_MB_BASE64` entfallen. Für den Sonderfall **1 Chunk (kurzes Audio, kein
Progress-Event)** greift der 45s-Watchdog als einfacher Request-Timeout.

### Teil 3 — Chunk-Resilienz *(Entscheidungspunkt — siehe unten)*

Im Sidecar (`whisper_sidecar_mlx.py`): Wirft die Transkription eines Chunks eine Exception,
wird der Chunk **einmal** wiederholt. Scheitert er erneut, entscheidet die
**Fallback-Policy** (unten), was in den Text an dieser Stelle kommt — die restlichen Chunks
werden in jedem Fall weiter transkribiert und ein Teilergebnis geliefert, statt die ganze
Transkription zu verwerfen.

### Teil 4 — Sidecar-Crash-Recovery

In `whisper-sidecar.ts`: Stirbt der Python-Prozess (`exit`-Event) während ein Request
offen ist:

1. Sidecar wird automatisch neu gestartet (`ensureRunning`).
2. Der betroffene Request wird **einmal** neu gesendet (Audio liegt noch im Node-Speicher).
3. Erst wenn auch der Retry scheitert, geht ein `audio:error` an die App.

Ein Retry-Zähler pro Request verhindert Endlosschleifen.

## Datenfluss (unverändert nach außen)

```
Mobile App ──[audio:transcribe {audio, format:'wav', enhance?}]──► ws.handler
ws.handler ──► whisperTranscribe(audio, {onProgress})  (whisper-sidecar.ts)
whisper-sidecar ──[JSON line: {id, audio_base64, language, model}]──► whisper_sidecar_mlx.py
                 ◄──[progress lines pro Chunk]──── (Watchdog-Reset je Zeile)
                 ◄──[final {id, text}]────────────
ws.handler ──[audio:progress …]──► App   (Live-Text pro Chunk)
ws.handler ──[audio:transcription {text}]──► App   (ggf. nach rewritePrompt, wenn enhance)
```

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| Einzelner Chunk scheitert (nach 1 Retry) | Fallback-Policy (Teil 3), Rest läuft weiter |
| Chunk hängt > 45s | Watchdog bricht Request ab → `audio:error` |
| Sidecar-Crash mit offenem Request | Neustart + 1 Retry, dann `audio:error` |
| Sidecar-Start-Timeout (90s) | `audio:error`, Status `failed` |
| Leeres/kaputtes WAV | `audio:error` „Keine Audiodaten"/Decode-Fehler |

## Offener Entscheidungspunkt: Chunk-Fallback-Policy (Teil 3)

Wenn ein Chunk endgültig (nach Retry) scheitert, was kommt an dieser Stelle in den Text?
Trade-offs:

- **A) Stiller Platzhalter** (`[…]` o.ä.) — Text bleibt lesbar, User sieht dass etwas fehlt,
  aber die Lücke ist klar markiert. Gut fürs Diktat.
- **B) Leerstring** — nahtloser Text, aber die Lücke ist unsichtbar; User merkt evtl. nicht,
  dass ein Stück fehlt. Riskant bei wichtigem Inhalt.
- **C) Fehler-Marker mit Zeit** (`[Fehler bei Min 3–4]`) — maximal transparent, aber
  „technischer" im Fließtext.

Diese Policy wird in `whisper_sidecar_mlx.py` in einer kleinen Funktion
`chunk_failure_placeholder(chunk_index, total_chunks, error)` gekapselt, die der User
selbst schreibt (5–10 Zeilen), da sie eine UX-Entscheidung ist.

## Test-Strategie

- **Kurzes Audio (1 Chunk):** korrekter Text, ~1s, Watchdog greift nicht.
- **Langes Audio (8 Min, mehrere Chunks):** Progress-Events fließen, Watchdog resettet,
  vollständiges Ergebnis, keine Timeouts.
- **Simulierter Chunk-Fehler:** Fallback-Policy greift, Rest wird transkribiert.
- **Simulierter Sidecar-Crash:** Neustart + Retry, Ergebnis kommt an.
- **Regression:** `enhance`-Pfad (rewritePrompt) funktioniert unverändert.

## Rollout / Sicherheit

- Neuer venv `.venv-mlx` — bestehender Pfad bleibt als Fallback; Umschaltung ist eine
  Zeile im Node-Pfad. Bei Problemen sofort zurückschaltbar.
- Erster Start lädt das Modell (~einmalig, danach gecacht) — Start-Timeout ggf. beim
  allerersten Boot beachten.
- Deploy auf dem Live-Branch/Worktree gemäß Projekt-Konventionen.
