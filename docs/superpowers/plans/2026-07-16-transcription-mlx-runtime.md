# Transkription robuster via MLX-Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transkription auf `mlx-whisper` umstellen und gegen Timeouts, tote Chunks und Sidecar-Crashes härten, sodass auch 8-Minuten-Audios zuverlässig durchlaufen.

**Architecture:** Neuer Python-Sidecar (`whisper_sidecar_mlx.py`, eigener `.venv-mlx`) transkribiert mit MLX nativ auf der M4-GPU; WAV wird direkt als float32-Numpy-Array dekodiert (kein ffmpeg/Temp-File). Der Node-Layer (`whisper-sidecar.ts`) bekommt einen „kein-Fortschritt"-Watchdog statt Gesamt-Timeout und startet den Sidecar bei Crash automatisch neu (mit 1 Retry). Das JSON-Lines-Protokoll und das WebSocket-Protokoll bleiben unverändert; das alte openai-whisper-Setup bleibt als Fallback bestehen.

**Tech Stack:** TypeScript (Node, `child_process`, ws), Python 3 (`mlx-whisper`, `numpy`, `wave`), Tests: vitest (Node, gemockter `child_process` + Fake-Timer), pytest (Python-Pure-Funktionen).

## Global Constraints

- Deploy-Ziel ist der Live-Worktree `~/Desktop/tms-terminal` auf Branch `feat/manager-chat-redesign` (NICHT master). Spec/Plan liegen im `~/Desktop/TMS Terminal`-Worktree.
- Audio-Eingang bleibt **WAV, 16 kHz, mono, 16-bit** — nicht ändern.
- WebSocket-Protokoll unverändert: `audio:transcribe` / `audio:progress` / `audio:transcription` / `audio:error`.
- JSON-Lines-Sidecar-Protokoll unverändert: Request `{id, audio_base64, language, model}`, Progress `{id, progress:true, chunk, total, text}`, Response `{id, text}`, Error `{id, error}`. Start-Signal ist die stderr-Zeile, die `Ready for requests` enthält.
- Chunk-Fallback = **Policy A** (stiller Platzhalter `[…]`).
- Watchdog-Grenze = **45 s** ohne Fortschritt (`CHUNK_STALL_TIMEOUT_MS`).
- Modell durchgängig **`mlx-community/whisper-large-v3-turbo`**.
- UI-Strings Deutsch, Code/Kommentare Englisch.
- Node-Test-Runner: die `test/`-Dir nutzt **vitest** (siehe `test/prompt-rewriter-sidecar.test.ts`). Neue Sidecar-Tests dort ablegen.

---

### Task 1: MLX-Runtime bereitstellen (venv + Smoke-Test)

Deliverable: Ein `.venv-mlx`, in dem `mlx_whisper` das Turbo-Modell lädt und ein kurzes WAV transkribiert.

**Files:**
- Create: `server/audio/requirements-mlx.txt`
- Create: `server/audio/.venv-mlx/` (venv, nicht eingecheckt)

- [ ] **Step 1: requirements-mlx.txt anlegen**

`server/audio/requirements-mlx.txt`:
```
mlx-whisper>=0.4.0
numpy>=2.0
pytest>=8.0
```

- [ ] **Step 2: venv erstellen + installieren**

```bash
cd ~/Desktop/tms-terminal/server/audio
python3 -m venv .venv-mlx
.venv-mlx/bin/pip install --upgrade pip
.venv-mlx/bin/pip install -r requirements-mlx.txt
```
Expected: Installation ohne Fehler; `mlx-whisper` + `numpy` + `pytest` vorhanden.

- [ ] **Step 3: Smoke-Test-WAV erzeugen (1 s Stille, 16 kHz mono)**

```bash
cd ~/Desktop/tms-terminal/server/audio
.venv-mlx/bin/python3 - <<'PY'
import wave, struct
with wave.open("/tmp/smoke.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(struct.pack("<%dh" % 16000, *([0]*16000)))
print("wrote /tmp/smoke.wav")
PY
```
Expected: `wrote /tmp/smoke.wav`

- [ ] **Step 4: MLX-Transkription smoke-testen (lädt Modell einmalig)**

```bash
cd ~/Desktop/tms-terminal/server/audio
.venv-mlx/bin/python3 - <<'PY'
import mlx_whisper
r = mlx_whisper.transcribe("/tmp/smoke.wav",
        path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language="de")
print("OK, text=%r" % r.get("text", ""))
PY
```
Expected: Beim ersten Lauf Modell-Download, dann `OK, text=...` (bei Stille meist leer/kurz). Kein Crash.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/audio/requirements-mlx.txt
git commit -m "build(audio): add mlx-whisper runtime requirements"
```

---

### Task 2: Pure Audio-Helfer im neuen Sidecar (TDD)

Deliverable: `whisper_sidecar_mlx.py` mit getesteten, modellfreien Funktionen für WAV→Array, Chunking und die Chunk-Fehler-Policy.

**Files:**
- Create: `server/audio/whisper_sidecar_mlx.py`
- Test: `server/audio/test_whisper_sidecar_mlx.py`

**Interfaces:**
- Produces:
  - `wav_bytes_to_float32(wav_bytes: bytes) -> tuple[np.ndarray, int]` — float32-Samples in [-1,1], Sample-Rate.
  - `split_audio(samples: np.ndarray, sample_rate: int, chunk_secs: int = 60) -> list[np.ndarray]`
  - `chunk_failure_placeholder(chunk_index: int, total_chunks: int, error: str) -> str`

- [ ] **Step 1: Failing test schreiben**

`server/audio/test_whisper_sidecar_mlx.py`:
```python
import io, wave, struct
import numpy as np
import whisper_sidecar_mlx as sc


def _make_wav(samples_int16, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % len(samples_int16), *samples_int16))
    return buf.getvalue()


def test_wav_bytes_to_float32_range_and_rate():
    wav = _make_wav([32767, -32768, 0], rate=16000)
    samples, rate = sc.wav_bytes_to_float32(wav)
    assert rate == 16000
    assert samples.dtype == np.float32
    assert samples.shape[0] == 3
    assert abs(samples[0] - 1.0) < 1e-3
    assert abs(samples[1] + 1.0) < 1e-3
    assert abs(samples[2]) < 1e-6


def test_split_audio_short_stays_single():
    samples = np.zeros(16000 * 30, dtype=np.float32)  # 30s
    chunks = sc.split_audio(samples, 16000, chunk_secs=60)
    assert len(chunks) == 1


def test_split_audio_long_splits_into_chunks():
    samples = np.zeros(16000 * 150, dtype=np.float32)  # 150s
    chunks = sc.split_audio(samples, 16000, chunk_secs=60)
    assert len(chunks) == 3
    assert sum(c.shape[0] for c in chunks) == samples.shape[0]


def test_chunk_failure_placeholder_is_bracket_ellipsis():
    out = sc.chunk_failure_placeholder(2, 5, "boom")
    assert out == "[…]"
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd ~/Desktop/tms-terminal/server/audio
.venv-mlx/bin/python3 -m pytest test_whisper_sidecar_mlx.py -q
```
Expected: FAIL — `ModuleNotFoundError: No module named 'whisper_sidecar_mlx'` bzw. AttributeError.

- [ ] **Step 3: Minimal-Implementierung der Pure-Funktionen**

`server/audio/whisper_sidecar_mlx.py` (nur die Helfer — Main-Loop folgt in Task 3):
```python
#!/usr/bin/env python3
"""Whisper sidecar (MLX runtime) — long-running transcription process.

Reads JSON Lines from stdin, transcribes with mlx-whisper, writes JSON Lines to stdout.
Same protocol as whisper_sidecar.py. Decodes WAV directly to a numpy array (no ffmpeg).
"""

import sys
import json
import base64
import wave
import io
import numpy as np

CHUNK_DURATION_SECS = 60
MODEL_REPO = "mlx-community/whisper-large-v3-turbo"


def wav_bytes_to_float32(wav_bytes):
    """Decode 16-bit PCM WAV bytes to (float32 mono samples in [-1,1], sample_rate)."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        n_channels = w.getnchannels()
        sample_width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sample_width != 2:
        raise ValueError("Only 16-bit PCM WAV is supported")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return np.ascontiguousarray(samples, dtype=np.float32), rate


def split_audio(samples, sample_rate, chunk_secs=CHUNK_DURATION_SECS):
    """Split samples into <=chunk_secs slices. Short audio (<=1.2x chunk) stays a single chunk."""
    chunk_len = int(sample_rate * chunk_secs)
    if samples.shape[0] <= chunk_len * 1.2:
        return [samples]
    return [samples[i:i + chunk_len] for i in range(0, samples.shape[0], chunk_len)]


def chunk_failure_placeholder(chunk_index, total_chunks, error):
    """Policy A: silent placeholder for a chunk that failed after retry.

    Returns the string inserted into the transcript in place of the dead chunk.
    Keeps the text readable while clearly marking the gap.
    """
    return "[…]"
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

```bash
cd ~/Desktop/tms-terminal/server/audio
.venv-mlx/bin/python3 -m pytest test_whisper_sidecar_mlx.py -q
```
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/audio/whisper_sidecar_mlx.py server/audio/test_whisper_sidecar_mlx.py
git commit -m "feat(audio): mlx sidecar pure helpers (wav decode, chunking, chunk placeholder)"
```

> **Dein Entscheidungspunkt (Policy A):** `chunk_failure_placeholder` ist bewusst klein und dir überlassen. Die Referenz oben liefert `"[…]"` (Policy A, wie in der Spec entschieden). Wenn du die Lücke anders markieren willst (z.B. `" … "` mit Leerzeichen, damit sie nicht an Nachbarwörter klebt), ändere hier — und passe `test_chunk_failure_placeholder_is_bracket_ellipsis` entsprechend an. Der Rest des Systems hängt nur davon ab, dass die Funktion einen String zurückgibt.

---

### Task 3: Sidecar-Main-Loop (MLX-Transkription, Chunk-Retry, Progress)

Deliverable: Der Sidecar liest Requests von stdin, transkribiert chunkweise mit MLX, sendet Progress pro Chunk, überlebt einen kaputten Chunk (1 Retry → Platzhalter) und antwortet mit dem Gesamttext.

**Files:**
- Modify: `server/audio/whisper_sidecar_mlx.py` (Main-Loop + Transkriptions-Helfer anhängen)

**Interfaces:**
- Consumes: `wav_bytes_to_float32`, `split_audio`, `chunk_failure_placeholder`, `MODEL_REPO` (Task 2).
- Produces: stderr-Zeile `... Ready for requests.` als Start-Signal; stdout JSON-Lines gemäß Protokoll.

- [ ] **Step 1: Transkriptions-Helfer + Main-Loop anhängen**

Ans Ende von `server/audio/whisper_sidecar_mlx.py` (nach den Pure-Funktionen):
```python
def _log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _emit(obj):
    print(json.dumps(obj))


def transcribe_chunk(mlx_whisper, samples, language):
    """Transcribe one chunk (numpy float32). One retry, then raise."""
    last_err = None
    for _attempt in range(2):
        try:
            result = mlx_whisper.transcribe(
                samples, path_or_hf_repo=MODEL_REPO, language=language
            )
            return result.get("text", "").strip()
        except Exception as e:  # noqa: BLE001 — resilience boundary
            last_err = e
    raise last_err


def handle_request(mlx_whisper, req):
    req_id = req.get("id", "unknown")
    audio_b64 = req.get("audio_base64", "")
    language = req.get("language", "de")

    if not audio_b64:
        _emit({"id": req_id, "error": "No audio data provided"})
        return

    samples, rate = wav_bytes_to_float32(base64.b64decode(audio_b64))
    duration = samples.shape[0] / rate if rate else 0
    _log(f"[whisper-mlx] {req_id}: {duration:.1f}s audio, rate={rate}")

    chunks = split_audio(samples, rate)
    total = len(chunks)
    parts = []

    if total == 1:
        text = transcribe_chunk(mlx_whisper, chunks[0], language)
        _emit({"id": req_id, "text": text})
        return

    _log(f"[whisper-mlx] {req_id}: split into {total} chunks")
    for i, chunk in enumerate(chunks):
        try:
            text = transcribe_chunk(mlx_whisper, chunk, language)
        except Exception as e:  # noqa: BLE001
            _log(f"[whisper-mlx] {req_id}: chunk {i+1}/{total} failed: {e}")
            text = chunk_failure_placeholder(i, total, str(e))
        parts.append(text)
        _emit({"id": req_id, "progress": True, "chunk": i + 1, "total": total, "text": text})

    _emit({"id": req_id, "text": " ".join(p for p in parts if p)})


def main():
    sys.stdout.reconfigure(line_buffering=True)
    _log("[whisper-mlx] Starting up...")
    try:
        import mlx_whisper
    except ImportError as e:
        _log(f"[whisper-mlx] Missing dependency: {e}")
        _log("[whisper-mlx] Install with: pip install mlx-whisper")
        sys.exit(1)

    # Warm the model so the first real request is fast.
    _log(f"[whisper-mlx] Loading model {MODEL_REPO}...")
    try:
        mlx_whisper.transcribe(
            np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL_REPO, language="de"
        )
    except Exception as e:  # noqa: BLE001
        _log(f"[whisper-mlx] Warmup failed (continuing): {e}")
    _log("[whisper-mlx] Ready for requests.")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle_request(mlx_whisper, req)
        except Exception as e:  # noqa: BLE001
            _emit({"id": req.get("id", "unknown"), "error": str(e)})


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Integrationstest — echtes Audio durch den Sidecar**

Kurzes Audio erzeugen und einen Request per stdin schicken:
```bash
cd ~/Desktop/tms-terminal/server/audio
.venv-mlx/bin/python3 - <<'PY'
import base64, json, subprocess, wave, struct, io, math
# 1s 440Hz Ton als WAV
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(struct.pack("<16000h", *[int(3000*math.sin(2*math.pi*440*t/16000)) for t in range(16000)]))
b64 = base64.b64encode(buf.getvalue()).decode()
req = json.dumps({"id":"req-1","audio_base64":b64,"language":"de"}) + "\n"
p = subprocess.run([".venv-mlx/bin/python3","whisper_sidecar_mlx.py"],
                   input=req, capture_output=True, text=True, timeout=180)
print("STDERR tail:", p.stderr.strip().splitlines()[-2:])
print("STDOUT:", [l for l in p.stdout.splitlines() if l.strip()])
PY
```
Expected: stderr enthält `Ready for requests.`; stdout enthält eine JSON-Zeile `{"id": "req-1", "text": ...}` ohne `error`.

- [ ] **Step 3: Pure-Tests erneut laufen (Regression)**

```bash
cd ~/Desktop/tms-terminal/server/audio
.venv-mlx/bin/python3 -m pytest test_whisper_sidecar_mlx.py -q
```
Expected: PASS (4 passed).

- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/audio/whisper_sidecar_mlx.py
git commit -m "feat(audio): mlx sidecar main loop with per-chunk retry + progress"
```

---

### Task 4: Node zeigt auf den MLX-Sidecar

Deliverable: `whisper-sidecar.ts` startet `whisper_sidecar_mlx.py` aus `.venv-mlx`; Boot-Test grün.

**Files:**
- Modify: `server/src/audio/whisper-sidecar.ts:36-38`

- [ ] **Step 1: Pfade umstellen**

In `server/src/audio/whisper-sidecar.ts`, den Block bei Zeile 36–38 ersetzen:
```typescript
const SIDECAR_DIR = path.join(SERVER_ROOT, 'audio');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'whisper_sidecar_mlx.py');
const VENV_PYTHON = path.join(SIDECAR_DIR, '.venv-mlx', 'bin', 'python3');
```

- [ ] **Step 2: Bestehende Sidecar-Tests laufen (kein Regressions-Bruch)**

```bash
cd ~/Desktop/tms-terminal/server
npx vitest run test/prompt-rewriter-sidecar.test.ts
```
Expected: PASS (unverändert — dieser Test betrifft den Rewriter, muss grün bleiben).

- [ ] **Step 3: Build prüfen**

```bash
cd ~/Desktop/tms-terminal/server
npx tsc --noEmit
```
Expected: keine Typfehler.

- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/audio/whisper-sidecar.ts
git commit -m "feat(audio): point whisper sidecar at mlx runtime (.venv-mlx)"
```

---

### Task 5: Watchdog-Timeout statt Gesamt-Timeout (TDD)

Deliverable: Der Node-seitige Timeout wird bei jeder Progress-Message resettet; nur ein einzelner Stillstand > 45 s bricht ab. `calcTimeout`/`TIMEOUT_PER_MB_BASE64` entfallen.

**Files:**
- Modify: `server/src/audio/whisper-sidecar.ts` (Timeout-Logik in `transcribe` + Progress-Zweig in `stdout`-Handler; `calcTimeout` entfernen, `CHUNK_STALL_TIMEOUT_MS` einführen)
- Test: `server/test/whisper-sidecar.test.ts`

**Interfaces:**
- Consumes: `transcribe(audioBase64, {model?, language?, onProgress?})` aus `whisper-sidecar.ts`.
- Produces: `CHUNK_STALL_TIMEOUT_MS = 45_000`; Watchdog, der pro Request-Progress via `req.timer` neu gesetzt wird.

- [ ] **Step 1: Failing test schreiben**

`server/test/whisper-sidecar.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('fs', async (orig) => {
  const real = (await orig()) as typeof import('fs');
  return { ...real, existsSync: vi.fn(() => true) };
});

function makeChild() {
  const child: any = {
    stdin: { write: vi.fn(), writable: true },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: vi.fn(function (this: any) { this.killed = true; }),
    on: vi.fn(),
  };
  return child;
}

let spawned: any[] = [];
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = makeChild();
    spawned.push(child);
    setImmediate(() => child.stderr.emit('data', Buffer.from('[whisper-mlx] Ready for requests.\n')));
    return child;
  }),
}));

async function flush() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); }

describe('whisper-sidecar watchdog', () => {
  beforeEach(() => { vi.resetModules(); spawned = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resets the stall timeout on each progress message', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const p = mod.transcribe('AAAA', { onProgress: () => {} });
    await flush();
    const child = spawned.at(-1);

    // 40s pass, then a progress message resets the watchdog
    vi.advanceTimersByTime(40_000);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', progress: true, chunk: 1, total: 2, text: 'a' }) + '\n'));
    await flush();

    // another 40s (would have exceeded 45s total, but timer was reset) then final result
    vi.advanceTimersByTime(40_000);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', text: 'a b' }) + '\n'));

    await expect(p).resolves.toBe('a b');
  });

  it('rejects when no progress arrives within the stall window', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const p = mod.transcribe('AAAA');
    await flush();

    vi.advanceTimersByTime(45_001);
    await expect(p).rejects.toThrow(/Timeout/i);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd ~/Desktop/tms-terminal/server
npx vitest run test/whisper-sidecar.test.ts
```
Expected: FAIL — der bestehende Gesamt-Timeout skaliert mit Größe, der Watchdog-Reset existiert noch nicht.

- [ ] **Step 3: Timeout-Logik umbauen**

In `server/src/audio/whisper-sidecar.ts`:

(a) Konstanten ersetzen — `BASE_TIMEOUT_MS`, `TIMEOUT_PER_MB_BASE64`, `calcTimeout` löschen und einführen:
```typescript
// Watchdog: abort a request only if a single chunk makes no progress for this long.
// Each progress message resets the timer, so total audio length is irrelevant.
const CHUNK_STALL_TIMEOUT_MS = 45_000;
const SIDECAR_START_TIMEOUT_MS = 90_000;
```

(b) Im `stdout`-Handler den Progress-Zweig so ändern, dass er den Timer resettet (ersetzt die vorhandenen Zeilen um `if (resp.progress) { req.onProgress?.(...); continue; }`):
```typescript
          // Progress update (chunk completed but more to come) — reset the watchdog.
          if (resp.progress) {
            clearTimeout(req.timer);
            req.timer = setTimeout(() => {
              pending.delete(id);
              req.reject(new Error(`Transkription Timeout (${CHUNK_STALL_TIMEOUT_MS / 1000}s). Chunk haengt.`));
            }, CHUNK_STALL_TIMEOUT_MS);
            req.onProgress?.({ chunk: resp.chunk, total: resp.total, text: resp.text ?? '' });
            continue;
          }
```

(c) `PendingRequest.timer` muss neu zuweisbar sein — sie ist bereits `NodeJS.Timeout` (Zeile 8), das genügt; wir mutieren `req.timer`.

(d) In `transcribe` den initialen Timer auf den Watchdog umstellen (ersetzt `const timeoutMs = calcTimeout(...)` und den `setTimeout`-Block):
```typescript
  const id = `req-${++requestId}`;

  logger.info(`[whisper] Transcription request ${id}: ${(audioBase64.length / 1024).toFixed(0)} KB Base64, stallTimeout=${CHUNK_STALL_TIMEOUT_MS / 1000}s, model=${options.model ?? 'default'}`);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Transkription Timeout (${CHUNK_STALL_TIMEOUT_MS / 1000}s). Chunk haengt oder Model zu langsam.`));
    }, CHUNK_STALL_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer, onProgress: options.onProgress });

    const request = JSON.stringify({
      id,
      audio_base64: audioBase64,
      language: options.language ?? 'de',
      model: options.model,
    }) + '\n';
    sidecar!.stdin!.write(request);
  });
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

```bash
cd ~/Desktop/tms-terminal/server
npx vitest run test/whisper-sidecar.test.ts
```
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/audio/whisper-sidecar.ts server/test/whisper-sidecar.test.ts
git commit -m "feat(audio): watchdog timeout resets on progress (length-independent)"
```

---

### Task 6: Sidecar-Crash-Recovery mit 1 Retry (TDD)

Deliverable: Stirbt der Sidecar mit offenem Request, wird er neu gestartet und der Request genau einmal neu gesendet; erst der zweite Crash liefert `audio:error`.

**Files:**
- Modify: `server/src/audio/whisper-sidecar.ts` (Request-Kontext um `audioBase64`, `options`, `attempts` erweitern; `exit`-Handler + neue `resend`-Logik)
- Test: `server/test/whisper-sidecar.test.ts` (Testfall ergänzen)

**Interfaces:**
- Consumes: `ensureRunning()`, `pending`-Map, `transcribe`.
- Produces: `PendingRequest` erhält `audioBase64: string`, `options: TranscribeOptions`, `attempts: number`; interne `resendPending()`-Funktion, die nach Neustart offene Requests einmal neu schickt.

- [ ] **Step 1: Failing test ergänzen**

Im `describe('whisper-sidecar watchdog', ...)` in `server/test/whisper-sidecar.test.ts` diesen Test hinzufügen:
```typescript
  it('restarts sidecar and retries the request once on crash', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const p = mod.transcribe('AAAA');
    await flush();
    const first = spawned.at(-1);

    // Grab the exit handler the module registered, then simulate a crash.
    const exitCall = first.on.mock.calls.find((c: any[]) => c[0] === 'exit');
    expect(exitCall).toBeTruthy();
    exitCall[1](1); // exit code 1
    await flush();

    // A new sidecar was spawned and becomes ready.
    expect(spawned.length).toBe(2);
    const second = spawned.at(-1);
    second.stderr.emit('data', Buffer.from('[whisper-mlx] Ready for requests.\n'));
    await flush();

    // The retried request now resolves.
    second.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', text: 'recovered' }) + '\n'));
    await expect(p).resolves.toBe('recovered');
  });
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
cd ~/Desktop/tms-terminal/server
npx vitest run test/whisper-sidecar.test.ts
```
Expected: FAIL — der aktuelle `exit`-Handler rejected offene Requests, statt neu zu starten und zu resenden.

- [ ] **Step 3: PendingRequest erweitern**

In `server/src/audio/whisper-sidecar.ts` das Interface (Zeile 5–10) ersetzen:
```typescript
interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (info: { chunk: number; total: number; text: string }) => void;
  audioBase64: string;
  options: TranscribeOptions;
  attempts: number;
}
```
(`TranscribeOptions` ist weiter unten definiert; da Interfaces gehoisted werden, ist die Referenz ok.)

- [ ] **Step 4: exit-Handler auf Restart+Retry umbauen**

Den `child.on('exit', ...)`-Block ersetzen. Statt alle Pending zu rejecten: Timer stoppen, Sidecar-State zurücksetzen, dann — falls Requests offen sind — neu starten und resenden.
```typescript
    child.on('exit', (code) => {
      logger.warn(`[whisper] Sidecar exited with code ${code}`);
      clearTimeout(startTimer);
      sidecar = null;
      startPromise = null;
      for (const [, req] of pending) clearTimeout(req.timer);

      if (!resolved) {
        resolved = true;
        const msg = `Whisper sidecar failed to start (exit ${code})`;
        setStatus({ state: 'failed', message: msg });
        reject(new Error(msg));
        return;
      }

      setStatus({ state: 'failed', message: `Whisper sidecar exited (code ${code})` });

      if (pending.size === 0) return;
      // Restart and retry each open request once.
      ensureRunning()
        .then(() => resendPending())
        .catch((err) => {
          for (const [id, req] of pending) {
            pending.delete(id);
            req.reject(new Error(`Whisper sidecar restart failed: ${err.message}`));
          }
        });
    });
```

- [ ] **Step 5: resendPending() + Zähler einführen**

Oberhalb von `transcribe` (z.B. direkt nach `ensureRunning`) hinzufügen:
```typescript
function armWatchdog(id: string, req: PendingRequest): void {
  req.timer = setTimeout(() => {
    pending.delete(id);
    req.reject(new Error(`Transkription Timeout (${CHUNK_STALL_TIMEOUT_MS / 1000}s). Chunk haengt oder Model zu langsam.`));
  }, CHUNK_STALL_TIMEOUT_MS);
}

function writeRequest(id: string, req: PendingRequest): void {
  const payload = JSON.stringify({
    id,
    audio_base64: req.audioBase64,
    language: req.options.language ?? 'de',
    model: req.options.model,
  }) + '\n';
  sidecar!.stdin!.write(payload);
}

function resendPending(): void {
  for (const [id, req] of pending) {
    if (req.attempts >= 2) {
      pending.delete(id);
      req.reject(new Error('Whisper sidecar crashed repeatedly'));
      continue;
    }
    req.attempts += 1;
    clearTimeout(req.timer);
    armWatchdog(id, req);
    writeRequest(id, req);
    logger.info(`[whisper] Resent request ${id} (attempt ${req.attempts})`);
  }
}
```

- [ ] **Step 6: transcribe auf die neuen Felder + Helfer umstellen**

`transcribe` so anpassen, dass es `audioBase64`, `options`, `attempts` in den Pending-Eintrag schreibt und `armWatchdog`/`writeRequest` nutzt (ersetzt den `return new Promise`-Block aus Task 5):
```typescript
  return new Promise<string>((resolve, reject) => {
    const req: PendingRequest = {
      resolve, reject, timer: null as unknown as NodeJS.Timeout,
      onProgress: options.onProgress,
      audioBase64, options, attempts: 1,
    };
    pending.set(id, req);
    armWatchdog(id, req);
    writeRequest(id, req);
  });
```

- [ ] **Step 7: Alle Sidecar-Tests laufen lassen**

```bash
cd ~/Desktop/tms-terminal/server
npx vitest run test/whisper-sidecar.test.ts && npx tsc --noEmit
```
Expected: PASS (3 passed) und keine Typfehler.

- [ ] **Step 8: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/audio/whisper-sidecar.ts server/test/whisper-sidecar.test.ts
git commit -m "feat(audio): auto-restart sidecar and retry request once on crash"
```

---

### Task 7: Modell-Heuristik im ws.handler entfernen

Deliverable: `ws.handler.ts` schickt keine größenabhängige Modellwahl mehr; der MLX-Sidecar nutzt durchgängig Turbo.

**Files:**
- Modify: `server/src/websocket/ws.handler.ts:738-744`

- [ ] **Step 1: Heuristik entfernen**

In `server/src/websocket/ws.handler.ts` die Zeilen
```typescript
      // Auto-select model based on audio size: turbo for long audio (>2MB base64 ≈ 1+ min), large-v3 for short
      const autoModel = audio.length > 2 * 1024 * 1024 ? 'turbo' : 'large-v3';

      whisperTranscribe(audio, {
        model: autoModel,
```
ersetzen durch:
```typescript
      // MLX sidecar uses a single turbo model for all lengths; no per-size model switch.
      whisperTranscribe(audio, {
```

- [ ] **Step 2: Build prüfen**

```bash
cd ~/Desktop/tms-terminal/server
npx tsc --noEmit
```
Expected: keine Typfehler (das `model`-Feld in `TranscribeOptions` bleibt optional).

- [ ] **Step 3: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/websocket/ws.handler.ts
git commit -m "refactor(audio): drop size-based model heuristic (mlx turbo for all)"
```

---

### Task 8: End-to-End-Verifikation am echten Server

Deliverable: Manuelle Bestätigung, dass die App über den laufenden Server kurze UND lange Audios transkribiert.

**Files:** keine.

- [ ] **Step 1: Server neu bauen + starten**

```bash
cd ~/Desktop/tms-terminal/server
npm run build && npm start
```
Expected: Log `[whisper] Starting sidecar...`, dann `[whisper-mlx] Ready for requests.`, Status `ready`. (Hinweis: Server-Neustart kann die eigene Claude-Sitzung im PTY betreffen — siehe Memory. Falls du im TMS-PTY läufst, Server in einem separaten Terminal starten.)

- [ ] **Step 2: Kurzes Kommando aus der App transkribieren**

In der App ein kurzes Sprach-Kommando (<15s) aufnehmen. Erwartung: Ergebnis in ~1–2 s, korrekter deutscher Text, kein Timeout.

- [ ] **Step 3: Langes Audio (~8 Min) transkribieren**

Ein langes Diktat aufnehmen. Erwartung: `audio:progress`-Updates erscheinen chunkweise (Live-Text), Gesamtergebnis kommt vollständig an, kein Timeout. Serverlog zeigt `split into N chunks`.

- [ ] **Step 4: Beobachtung festhalten**

Kurz notieren: Dauer für 8-Min-Audio, ob Chunks flossen, ob `enhance` (falls genutzt) weiter funktioniert. Bei Regressionen: Node-Pfad in `whisper-sidecar.ts` zurück auf `whisper_sidecar.py` + `.venv` = sofortiger Fallback.

---

## Notes

- **Fallback:** Das alte `whisper_sidecar.py` + `.venv` bleiben unangetastet. Rückschalten = zwei Pfad-Zeilen in `whisper-sidecar.ts` (Task 4) rückgängig.
- **Deutsch-Finetune (später):** In `whisper_sidecar_mlx.py` nur `MODEL_REPO` auf ein mlx-community-DE-Repo ändern (z.B. eine MLX-Konvertierung von `primeline/whisper-large-v3-turbo-german`). Kein weiterer Code betroffen.
- **Warmup:** Der Sidecar wärmt das Modell beim Start mit 1 s Stille vor, damit der erste echte Request schnell ist. Der 90-s-Start-Timeout deckt den einmaligen Modell-Download beim allerersten Boot ab; bei sehr langsamer Leitung ggf. Modell vorab per Task-1-Smoke-Test ziehen.
```
