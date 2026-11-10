# Diktat-Tempo (Diktat-Bubble 2.0, Teil A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nach dem Stopp steht der diktierte Text in unter 0,7 s da — bei jeder Länge, ohne KI.

**Architecture:** Der Server schneidet den hereinkommenden Ton an Sprechpausen in Stücke von 8–28 s statt 60 s und transkribiert sie während des Sprechens; dekodiert wird nur noch, was neu ist. Endet der Ton in einer Pause, wird das Reststück vorab transkribiert, sodass beim Stopp meist nichts mehr zu rechnen ist. App und Bubble laden dafür alle 500 ms statt alle 2 s hoch.

**Tech Stack:** Node + TypeScript (`server/`), Tests mit `node:test` über `ts-node`; ffmpeg; mlx-whisper-Sidecar (unverändert); React Native Hook und Kotlin-Dienst (je eine Konstante).

**Spec:** `docs/superpowers/specs/2026-11-11-diktat-bubble-2-design.md` — dieser Plan setzt **nur Teil A** um (A1–A5). Wörterbuch, Einstellungen, Entfernen des KI-Prompt-Modus, Lernen, Denkpausen und Flüstermodus bekommen eigene Pläne, jeweils nachdem der vorige Teil gemessen ist.

## Global Constraints

- Ziel aus dem Spec: Mitte ≤ 0,5 s und mindestens 90 % der Diktate ≤ 0,7 s über die letzten 50 Diktate, gemessen im Server-Log vom Eintreffen des Stopps bis zum fertigen Text.
- Ausgangswerte (Server-Log 7.–11.11.2026, 508 Diktate): Mitte 1,5 s; 16 % ≤ 0,7 s; bis 10 s → 0,5 s; 10–30 s → 1,0 s; 30–60 s → 2,0 s; länger → 2,2–2,4 s. Keine Stufe darf schlechter sein.
- Text darf sich nicht ändern außer durch die andere Stückelung. Gegenprobe in Task 5 ist Pflicht vor dem Ausliefern.
- Format `file` (alter Upload ohne Streaming) und das alte `audio:transcribe` bleiben unverändert.
- `enhance`/Rewriter wird hier **nicht** angefasst (eigener Plan).
- Alle Arbeit im Live-Tree `~/Developer/tms-terminal`, Branch `feat/fernzugriff`. Tests: `cd server && npm test`.
- Code-Kommentare und Namen Englisch, Texte für den Nutzer Deutsch.
- Server-Neustart und App-Release löst der Nutzer aus bzw. gibt sie frei — nicht von selbst neu starten (die Sitzung läuft im Server-PTY).

## Review Focus

1. **Leises Sprechen:** Die Pausen-Erkennung darf leise Sprache nicht für Stille halten — sonst wird mitten im Wort geschnitten. Erwartet: Pausen werden relativ zur Sprechlautstärke erkannt. → Test in Task 1.
2. **Dauerrauschen ohne echte Pausen** (Lüfter, Straße): Es findet sich nie eine Pause. Erwartet: trotzdem spätestens nach 28 s ein Schnitt, damit der Rest nach dem Stopp klein bleibt. → Test in Task 1.
3. **Anderes Aufnahmeformat** (nicht 16 kHz oder kein AAC-LC): Die Rechnung „1024 Samples je Rahmen“ stimmt nicht. Erwartet: stiller Rückfall auf vollständiges Dekodieren, gleiches Ergebnis. → Test in Task 2.
4. **Wiederverbinden mitten im Diktat:** doppelt oder überlappend ankommende Bytes dürfen nicht doppelt im Ton landen. Erwartet: jedes Byte genau einmal. → Test in Task 3.
5. **Weitersprechen nach einer kurzen Pause:** Ein vorab transkribiertes Reststück darf nicht zusätzlich zum späteren Text erscheinen. Erwartet: kein doppelter Text. → Test in Task 6.

---

### Task 1: Pausen finden und kürzer schneiden

**Files:**
- Modify: `server/src/audio/dictation.segment.ts`
- Test: `server/src/audio/dictation.segment.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MIN_SEGMENT_SECS = 8;
  export const MAX_SEGMENT_SECS = 28;
  export const PAUSE_MIN_SECS = 0.3;
  export interface Pause { start: number; end: number }          // sample indices, [start, end)
  export function findPauses(samples: Float32Array, from: number, to: number, rate: number, minSecs?: number): Pause[];
  export function nextCut(samples: Float32Array, cursor: number, rate: number, final: boolean): number | null;
  export function nextCutLegacy(samples: Float32Array, cursor: number, rate: number, final: boolean): number | null; // today's 60 s rule, for the A/B script only
  ```
  `findPauseSplit` und `encodeWav` bleiben unverändert.

- [ ] **Step 1: Tests schreiben** (Hilfsfunktion `tone(secs, level)` und `concat(...)` im Test; Sprache = Konstante 0,3, Stille = 0)

```ts
test('findPauses finds a 0.5s gap and ignores a 0.2s gap', () => {
  const s = concat(tone(3, 0.3), tone(0.2, 0), tone(3, 0.3), tone(0.5, 0), tone(3, 0.3));
  const p = findPauses(s, 0, s.length, RATE);
  assert.strictEqual(p.length, 1);
  assert.ok(Math.abs(p[0].start / RATE - 6.2) < 0.15 && Math.abs(p[0].end / RATE - 6.7) < 0.15);
});
test('findPauses works for quiet speech (level 0.01)', () => {
  const s = concat(tone(3, 0.01), tone(0.5, 0), tone(3, 0.01));
  assert.strictEqual(findPauses(s, 0, s.length, RATE).length, 1);
});
test('findPauses treats a low noise floor between words as a pause', () => {
  const s = concat(tone(3, 0.3), tone(0.5, 0.004), tone(3, 0.3));
  assert.strictEqual(findPauses(s, 0, s.length, RATE).length, 1);
});
test('nextCut waits while less than 8s are buffered', () => {
  assert.strictEqual(nextCut(concat(tone(5, 0.3), tone(0.5, 0), tone(1, 0.3)), 0, RATE, false), null);
});
test('nextCut cuts in the middle of the last closed pause between 8s and 28s', () => {
  const s = concat(tone(9, 0.3), tone(0.5, 0), tone(5, 0.3), tone(0.5, 0), tone(2, 0.3));
  assert.ok(Math.abs(nextCut(s, 0, RATE, false)! / RATE - 14.75) < 0.15);
});
test('nextCut ignores a pause at the live edge', () => {
  assert.strictEqual(nextCut(concat(tone(10, 0.3), tone(0.6, 0)), 0, RATE, false), null);
});
test('nextCut forces a cut by 28s when there is no pause (steady noise)', () => {
  const cut = nextCut(tone(40, 0.3), 0, RATE, false)!;
  assert.ok(cut / RATE > 20 && cut / RATE <= 28);
});
test('nextCut respects the cursor', () => {
  const s = concat(tone(20, 0.3), tone(0.5, 0), tone(9, 0.3), tone(0.5, 0), tone(2, 0.3));
  const first = nextCut(s, 0, RATE, false)!;
  assert.ok(nextCut(s, first, RATE, false)! > first);
});
test('nextCut on final takes the whole rest up to 28s', () => {
  const s = tone(20, 0.3);
  assert.strictEqual(nextCut(s, 0, RATE, true), s.length);
});
test('nextCut on final still splits a rest longer than 28s', () => {
  const cut = nextCut(tone(40, 0.3), 0, RATE, true)!;
  assert.ok(cut < 40 * RATE && cut / RATE <= 28);
});
test('nextCut on final with nothing left returns null', () => {
  const s = tone(5, 0.3);
  assert.strictEqual(nextCut(s, s.length, RATE, true), null);
});
```

Die sechs vorhandenen `nextCut`-Tests auf `nextCutLegacy` umbenennen (Verhalten unverändert).

- [ ] **Step 2: Fehlschlag prüfen** — `cd server && npm test 2>&1 | grep -E "findPauses|nextCut"` → FAIL (`findPauses` nicht exportiert).

- [ ] **Step 3: Umsetzen.** Bisheriges `nextCut` in `nextCutLegacy` umbenennen. Neu:

  `findPauses`: 100-ms-Rahmen ab `from`; je Rahmen der RMS. Bezugswert = 90. Perzentil der Rahmen-RMS in `[from, to)`. Ein Rahmen ist leise, wenn `rms < max(0.003, 0.12 * bezug)`; liegt der Bezugswert selbst unter 0,003, ist der ganze Bereich eine Pause. Eine Pause ist eine Folge leiser Rahmen von mindestens `minSecs` (Standard `PAUSE_MIN_SECS`).

  `nextCut`: `rest = samples.length - cursor`. `rest <= 0` → `null`. Kandidaten = Pausen in `[cursor, samples.length)`, deren Mitte in `[cursor + MIN, cursor + MAX]` liegt **und** die vor dem Ende des Puffers enden (danach kam wieder Sprache). Nicht final: `rest < MIN` → `null`; Kandidaten vorhanden → Mitte des letzten; sonst `rest > MAX` → `findPauseSplit(samples, cursor + (MAX - 3) * rate, rate, 3)`; sonst `null`. Final: `rest <= MAX` → `samples.length`; sonst wie nicht final (Kandidat oder erzwungener Schnitt).

- [ ] **Step 4: Tests grün** — `cd server && npm test 2>&1 | tail -5` → `fail 0`.

- [ ] **Step 5: Commit** — `git add server/src/audio/dictation.segment.ts server/src/audio/dictation.segment.test.ts && git commit -m "feat(dictation): cut segments at speech pauses (8-28s)"`

---

### Task 2: Nur neuen Ton dekodieren

**Files:**
- Create: `server/src/audio/adts-pcm.ts`
- Test: `server/src/audio/adts-pcm.test.ts`

**Interfaces:**
- Consumes: `decodeToFloat32(bytes: Buffer, format: 'adts' | 'file'): Promise<Float32Array>` aus `ffmpeg-decode.ts`.
- Produces:
  ```ts
  export interface PcmStream {
    push(bytes: Buffer): void;
    /** All samples decoded so far (16 kHz mono); decodes only what is new. */
    samples(): Promise<Float32Array>;
    /** Raw bytes still held in memory. */
    readonly bytes: number;
    release(): void;
  }
  export const ADTS_FRAME_SAMPLES = 1024;
  /** Start offsets of the complete ADTS frames in buf at/after `from`, plus the offset just past the last one. */
  export function adtsFrames(buf: Buffer, from: number): { starts: number[]; end: number };
  export class AdtsPcm implements PcmStream {
    constructor(decode: (bytes: Buffer) => Promise<Float32Array>);
    readonly mode: 'incremental' | 'full';
  }
  ```

- [ ] **Step 1: Tests schreiben.** Fixture wie in `ffmpeg-decode.test.ts` per ffmpeg erzeugen (`{ skip: !ffmpeg }`): 20 s `sine=frequency=440` mit Lautstärke-Wechseln, als ADTS 16 kHz mono 96k.

```ts
test('adtsFrames returns only complete frames', () => {
  const f = adtsFixture(); const { starts, end } = adtsFrames(f.subarray(0, 5000), 0);
  assert.ok(starts.length > 5 && end <= 5000 && end > 4000);
  assert.strictEqual(adtsFrames(f, 0).end, f.length);
});
test('incremental decode equals one full decode', { skip: !ffmpeg }, async () => {
  const f = adtsFixture(); const full = await decodeToFloat32(f, 'adts');
  const pcm = new AdtsPcm((b) => decodeToFloat32(b, 'adts'));
  let last = new Float32Array(0);
  for (let off = 0; off < f.length; off += 6000) { pcm.push(f.subarray(off, off + 6000)); last = await pcm.samples(); } // 6000 B = 0.5s, cuts mid-frame
  assert.strictEqual(pcm.mode, 'incremental');
  assert.strictEqual(last.length, full.length);
  let worst = 0; for (let i = 0; i < full.length; i++) worst = Math.max(worst, Math.abs(full[i] - last[i]));
  assert.ok(worst < 1e-3, `max diff ${worst}`);
});
test('each frame is decoded once (plus the overlap)', { skip: !ffmpeg }, async () => {
  const f = adtsFixture(); let decodedBytes = 0;
  const pcm = new AdtsPcm((b) => { decodedBytes += b.length; return decodeToFloat32(b, 'adts'); });
  for (let off = 0; off < f.length; off += 6000) { pcm.push(f.subarray(off, off + 6000)); await pcm.samples(); }
  assert.ok(decodedBytes < f.length * 1.5, `${decodedBytes} of ${f.length}`);
});
test('a different sample rate falls back to full decoding with the same result', { skip: !ffmpeg }, async () => {
  const f = adtsFixture(44100); const full = await decodeToFloat32(f, 'adts');
  const pcm = new AdtsPcm((b) => decodeToFloat32(b, 'adts'));
  for (let off = 0; off < f.length; off += 6000) { pcm.push(f.subarray(off, off + 6000)); await pcm.samples(); }
  assert.strictEqual(pcm.mode, 'full');
  assert.strictEqual((await pcm.samples()).length, full.length);
});
test('samples() without new frames does not decode', async () => {
  let n = 0; const pcm = new AdtsPcm(async () => { n++; return new Float32Array(0); });
  await pcm.samples(); assert.strictEqual(n, 0);
});
test('release drops the raw bytes', () => { const pcm = new AdtsPcm(async () => new Float32Array(0)); pcm.push(Buffer.alloc(100)); pcm.release(); assert.strictEqual(pcm.bytes, 0); });
```

- [ ] **Step 2: Fehlschlag prüfen** — `npm test 2>&1 | grep -E "adts"` → FAIL (Modul fehlt).

- [ ] **Step 3: Umsetzen.**

  ADTS-Rahmen: Sync, wenn `buf[i] === 0xFF && (buf[i+1] & 0xF0) === 0xF0`; Rahmenlänge `((buf[i+3] & 0x03) << 11) | (buf[i+4] << 3) | (buf[i+5] >> 5)`. Ein Rahmen ist vollständig, wenn `i + länge <= buf.length`. Länge < 7 oder kein Sync an erwarteter Stelle → Strom gilt als beschädigt → `mode = 'full'`.

  `samples()`: neue vollständige Rahmen ermitteln; keine → bisherigen Stand zurückgeben. Sonst ab `max(0, decodedFrames - 2)` bis zum letzten vollständigen Rahmen dekodieren (2 Rahmen Überlappung, weil AAC-Rahmen aufeinander aufbauen). Erwartete Länge = dekodierte Rahmen × 1024; stimmt sie, die ersten `überlappung × 1024` Samples verwerfen und den Rest anhängen; stimmt sie nicht → `mode = 'full'`. Im Modus `full` wird bei jedem Aufruf alles Rohe dekodiert und nichts verworfen. Im Modus `incremental` dürfen Roh-Bytes vor dem Überlappungs-Punkt freigegeben werden. PCM in einem Puffer halten, der sich bei Bedarf verdoppelt.

  **Maßstab ist der Gleichheits-Test.** Reichen 2 Rahmen Überlappung nicht für `worst < 1e-3`, auf 3–4 erhöhen; liefert ffmpeg am Strom-Anfang eine feste Zahl Samples weniger oder mehr, das in der Erwartung berücksichtigen. Nicht die Schwelle im Test aufweichen.

- [ ] **Step 4: Tests grün** — `npm test 2>&1 | tail -5` → `fail 0`.

- [ ] **Step 5: Commit** — `git add server/src/audio/adts-pcm.ts server/src/audio/adts-pcm.test.ts && git commit -m "feat(dictation): decode only newly arrived ADTS frames"`

---

### Task 3: Manager nutzt kurze Stücke und den PCM-Strom

**Files:**
- Modify: `server/src/audio/dictation.ts`
- Modify: `server/src/websocket/ws.handler.ts:90-96` (Abhängigkeiten)
- Test: `server/src/audio/dictation.test.ts`

**Interfaces:**
- Consumes: `nextCut`, `MIN_SEGMENT_SECS`, `PAUSE_MIN_SECS` (Task 1); `PcmStream`, `AdtsPcm` (Task 2).
- Produces:
  ```ts
  export interface DictationDeps { /* bisherige Felder */ openPcm?: () => PcmStream; }
  export interface DictationOptions { /* bisherige Felder */ cut?: typeof nextCut; }   // default: nextCut
  ```
  Standard für `decodeThrottleMs`: 500 (bisher 3000). Log-Zeile bei Ende: `done — 47.3s audio, 310ms stop->result, rest 4.1s, compute 1711ms, 662 chars`.

- [ ] **Step 1: Test-Harness umstellen.** Der Fake-Codec bleibt „1 Byte = 0,1 s“, aber der Byte-Wert bestimmt den Pegel: Wert 1 → 0,3 (Sprache), Wert 0 → 0 (Stille). `bytes(n, fill)` gibt es schon. Dazu ein Fake-`openPcm`, der dieselbe Regel anwendet und mitzählt:

```ts
function fakePcm(counter: { pushed: number }) {
  let raw = Buffer.alloc(0);
  return { push(b: Buffer) { raw = Buffer.concat([raw, b]); counter.pushed += b.length; },
    async samples() { const s = new Float32Array(raw.length * SAMPLES_PER_BYTE); for (let i = 0; i < raw.length; i++) s.fill(raw[i] ? 0.3 : 0, i * SAMPLES_PER_BYTE, (i + 1) * SAMPLES_PER_BYTE); return s; },
    get bytes() { return raw.length; }, release() { raw = Buffer.alloc(0); } };
}
```

- [ ] **Step 2: Tests schreiben/anpassen.**

```ts
test('pieces are transcribed while recording; only a short rest after stop', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  const audio = Buffer.concat([bytes(200), bytes(4, 0), bytes(100), bytes(4, 0), bytes(40)]); // 20s, 0.4s pause, 10s, 0.4s pause, 4s
  h.mgr.chunk('d1', 0, audio.subarray(0, 328), s.fn);   // up to 2s into the last part
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [20, 10]);            // 20.2s and 10.4s, rounded
  h.mgr.chunk('d1', 328, audio.subarray(328), s.fn);
  h.mgr.end('d1', audio.length, s.fn);
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [20, 10, 4]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1 seg2 seg3');
});
test('with a pcm stream every byte is pushed exactly once, also on overlap and duplicates', async () => {
  const counter = { pushed: 0 };
  const h = harness({ openPcm: () => fakePcm(counter) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);
  h.mgr.chunk('d1', 0, bytes(50), s.fn);      // duplicate
  h.mgr.chunk('d1', 30, bytes(50), s.fn);     // overlap
  h.mgr.chunk('d1', 200, bytes(10), s.fn);    // gap: ignored
  assert.strictEqual(counter.pushed, 80);
});
test('a pcm stream is released when the dictation finishes', async () => {
  const counter = { pushed: 0 }; const h = harness({ openPcm: () => fakePcm(counter) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn); h.mgr.chunk('d1', 0, bytes(50), s.fn); h.mgr.end('d1', 50, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(h.mgr.bufferedBytes('d1'), 0);
});
test('a tap too short to hold audio ends with an empty result (pcm stream)', async () => {
  const h = harness({ openPcm: () => ({ push() {}, async samples() { return new Float32Array(0); }, bytes: 0, release() {} }) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn); h.mgr.chunk('d1', 0, bytes(3), s.fn); h.mgr.end('d1', 3, s.fn);
  await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, '');
});
test('the legacy cut can be injected', async () => {
  const h = harness({}, { cut: nextCutLegacy }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, bytes(750), s.fn);               // 75s of speech
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [60]);                // as today
});
```

  Bestehende Tests anpassen: „adts segments are transcribed before end…“ durch den ersten Test oben ersetzen; „streaming does not decode again until a segment could be ready“ auf die neue Schwelle umstellen (150 s Sprache in 1-s-Stücken ohne `openPcm`: höchstens ein Dekodieren je Durchlauf, erstes Stück ≤ 28 s). `harness(over, opts)` bekommt dafür einen zweiten Parameter, der in die `DictationOptions` gemischt wird. Alle übrigen Tests müssen unverändert grün bleiben.

- [ ] **Step 3: Fehlschlag prüfen** — `npm test 2>&1 | grep -E "not ok"` → die neuen Tests schlagen fehl.

- [ ] **Step 4: Umsetzen.**
  - `Session` bekommt `pcm: PcmStream | null` (gesetzt in `start`, wenn `format === 'adts'` und `deps.openPcm` vorhanden).
  - `chunk`: das neue Endstück geht nach `pcm.push(tail)` statt nach `parts`, wenn `pcm` gesetzt ist.
  - `transcribeReady`: Samples aus `pcm.samples()`, sonst wie bisher aus `deps.decode(Buffer.concat(parts))`. Schnitt über `this.cut` (Option, Standard `nextCut`).
  - `schedulePass`: die Vorab-Sperre über `bytesPerSec` gilt nur ohne `pcm`, und dort mit `MIN_SEGMENT_SECS + PAUSE_MIN_SECS` statt 72 s.
  - Beim Finalisieren `restSecs = (samples.length - cursor) / RATE` vor dem letzten Durchlauf merken und in die Log-Zeile schreiben.
  - `bufferedBytes` zählt `pcm.bytes` mit; im `finally` von `maybeFinalize` und in `cancel` `pcm.release()`.
  - `ws.handler.ts`: `openPcm: () => new AdtsPcm((b) => decodeToFloat32(b, 'adts'))`.

- [ ] **Step 5: Tests grün** — `npm test 2>&1 | tail -5` → `fail 0`; `npx tsc --noEmit -p .` ohne Fehler.

- [ ] **Step 6: Commit** — `git add server/src/audio/dictation.ts server/src/audio/dictation.test.ts server/src/websocket/ws.handler.ts && git commit -m "feat(dictation): short segments + incremental pcm in the manager"`

---

### Task 4: Messwerte festhalten

**Files:**
- Create: `server/src/audio/dictation.stats.ts`
- Modify: `server/src/audio/dictation.ts` (Aufruf), `server/src/websocket/ws.handler.ts` (Verdrahtung)
- Test: `server/src/audio/dictation.stats.test.ts`, `server/src/audio/dictation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DictationStat { at: number; audioSecs: number; waitMs: number; restSecs: number; specHit: boolean }
  export interface DictationSummary { count: number; medianMs: number; under700: number /* 0..1 */; waits: number[] /* oldest first */ }
  export class DictationStatsStore {
    constructor(file: string, keep?: number);     // keep default 50
    record(stat: DictationStat): void;
    summary(): DictationSummary;
  }
  // DictationDeps: onDone?: (stat: DictationStat) => void
  ```
  Datei: `~/.tms-terminal/dictation-stats.json`, Inhalt `{ "version": 1, "stats": [...] }`. Pfad und atomares Schreiben nach dem Muster von `server/src/terminal/titles.store.ts`.

- [ ] **Step 1: Tests schreiben.**

```ts
test('keeps only the newest 50', () => { const st = store(); for (let i = 0; i < 60; i++) st.record(stat(i)); assert.strictEqual(st.summary().count, 50); assert.strictEqual(st.summary().waits[0], 10); });
test('summary: median and share under 700ms', () => { const st = store(); [300, 500, 900, 700].forEach((w) => st.record(stat(w))); assert.strictEqual(st.summary().medianMs, 600); assert.strictEqual(st.summary().under700, 0.75); });
test('survives a restart', () => { const f = tmpFile(); new DictationStatsStore(f).record(stat(400)); assert.strictEqual(new DictationStatsStore(f).summary().count, 1); });
test('a corrupt file is kept aside, not overwritten silently', () => { const f = tmpFile(); fs.writeFileSync(f, '{oops'); const st = new DictationStatsStore(f); st.record(stat(400)); assert.ok(fs.existsSync(f + '.bad')); assert.strictEqual(st.summary().count, 1); });
test('empty store has a neutral summary', () => { assert.deepStrictEqual(store().summary(), { count: 0, medianMs: 0, under700: 0, waits: [] }); });
// dictation.test.ts
test('a finished dictation reports its stat', async () => {
  const stats: DictationStat[] = []; const h = harness({ onDone: (s) => stats.push(s) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn); h.mgr.chunk('d1', 0, bytes(50), s.fn); h.clock.t = 1000; h.mgr.end('d1', 50, s.fn); h.clock.t = 1300;
  await h.mgr.idle('d1');
  assert.strictEqual(stats.length, 1); assert.strictEqual(stats[0].audioSecs, 5); assert.strictEqual(stats[0].restSecs, 5); assert.strictEqual(stats[0].specHit, false);
});
```
  (`waitMs` im letzten Test nicht prüfen — die Fake-Uhr steht während der Arbeit.) Fehlgeschlagene und abgebrochene Diktate melden nichts.

- [ ] **Step 2: Fehlschlag prüfen**, **Step 3: Umsetzen**, **Step 4: Tests grün** (`npm test`, `npx tsc --noEmit -p .`).

- [ ] **Step 5: Commit** — `git commit -m "feat(dictation): keep the last 50 stop-to-text timings"`

---

### Task 5: Messen gegen heute — Tempo und Genauigkeit

**Files:**
- Modify: `server/scripts/dictation-e2e.ts`
- Create: `server/scripts/dictation-fixtures.sh`

**Interfaces:**
- Consumes: `DictationOptions.cut`, `nextCutLegacy` (Task 1/3), `AdtsPcm` (Task 2).
- Produces: Aufruf `node --require ts-node/register scripts/dictation-e2e.ts <audio> [--piece=0.5] [--stop-delay=600] [--cut=new|legacy] [--truth=<text file>]`. Ausgabe je Lauf: `stop -> result Nms, rest N.Ns, calls N, word errors N of N`.

- [ ] **Step 1: Fixtures erzeugen.** `dictation-fixtures.sh <zielordner>` baut mit `say -v Anna` und ffmpeg vier deutsche Aufnahmen samt Soll-Text: rund 10 s, 45 s, 3 min, 6 min; natürliche Pausen über `[[slnc 400]]` zwischen Sätzen und einige `[[slnc 2500]]`. Die Texte sind gewöhnliche Arbeits-Diktate mit Fachbegriffen (Claude Code, Tailscale, WebView). Zielordner außerhalb des Repos (z. B. `/private/tmp/tms-dictation-fixtures`).

- [ ] **Step 2: Skript erweitern.** Echtzeit-Lauf (Stückgröße `--piece` Sekunden, danach `--stop-delay` ms warten, dann `end`), Wahl der Schnittregel, Wortfehler gegen den Soll-Text (Wörter klein, ohne Satzzeichen; Abstand über längste gemeinsame Teilfolge). Der bisherige Wiederaufnahme-Lauf („drop + resume“) bleibt erhalten.

- [ ] **Step 3: Messen und Tabelle festhalten.** Für jede der vier Aufnahmen: `--cut=legacy --piece=2` (heute) gegen `--cut=new --piece=2` (nur Server) — je `--stop-delay=0` und `600`. Ergebnis als Tabelle unten in diesen Plan schreiben (Abschnitt „Messung“).

  Erwartet: neue Regel ≤ 0,7 s nach dem Stopp bei allen vier Längen; Wortfehler nicht höher als bei der alten Regel plus 1 Wort je 100.

- [ ] **Step 4: Nachstellen, falls nötig.** Sind die Wortfehler höher: `MIN_SEGMENT_SECS` auf 12 heben und neu messen. Ist das Tempo über 0,7 s bei unveränderten Fehlern: auf 5 senken und neu messen. Die gewählten Werte und der Grund kommen in die Tabelle. Bleibt beides unvereinbar: anhalten und dem Nutzer die Zahlen zeigen.

- [ ] **Step 5: Commit** — `git commit -m "test(dictation): real-time e2e with cut A/B and word errors"`

**Auslieferung Server-Teil:** Nach Task 5 kann der Nutzer den Server aktualisieren und neu starten. Danach im Log prüfen: `grep "\[dictation\].*done" ~/.tms-terminal/logs/server.log | tail -20` — die Zeilen tragen jetzt `rest N.Ns`.

---

### Task 6: Vorauseilen

**Files:**
- Modify: `server/src/audio/dictation.segment.ts`, `server/src/audio/dictation.ts`
- Test: `server/src/audio/dictation.segment.test.ts`, `server/src/audio/dictation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SPEC_PAUSE_SECS = 0.4;
  /** Sample index where the trailing silence starts, if the buffer ends in >= minSecs of quiet and [cursor, that index) holds >= 0.5s of speech; else null. */
  export function edgePause(samples: Float32Array, cursor: number, rate: number, minSecs?: number): number | null;
  /** True if [from, to) contains at least 0.2s that is not quiet. */
  export function hasSpeech(samples: Float32Array, from: number, to: number, rate: number): boolean;
  ```
  `Session` bekommt `spec: { from: number; to: number; text: string } | null`. `DictationStat.specHit` wird `true`, wenn das Endergebnis ohne Whisper-Aufruf nach dem Stopp zustande kam.

- [ ] **Step 1: Tests schreiben.**

```ts
// segment
test('edgePause finds trailing silence after speech', () => { const s = concat(tone(3, 0.3), tone(0.5, 0)); assert.ok(Math.abs(edgePause(s, 0, RATE)! / RATE - 3) < 0.15); });
test('edgePause is null while speech is still running', () => { assert.strictEqual(edgePause(concat(tone(3, 0.3), tone(0.2, 0)), 0, RATE), null); });
test('edgePause is null for silence only', () => { assert.strictEqual(edgePause(tone(3, 0), 0, RATE), null); });
// manager (fake pcm, bytes(n, 0) = silence)
test('a pause at the live edge is transcribed ahead; stop without new speech needs no further call', async () => {
  const stats: DictationStat[] = []; const h = harness({ onDone: (x) => stats.push(x) }); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(50), bytes(5, 0)]), s.fn);   // 5s speech + 0.5s quiet
  await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [5]);
  h.mgr.end('d1', 55, s.fn); await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [5]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1');
  assert.strictEqual(stats[0].specHit, true);
});
test('speech after a short speculative piece discards it — no duplicate text', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(30), bytes(5, 0)]), s.fn); await h.mgr.idle('d1');   // 3s + pause → speculative seg1
  h.mgr.chunk('d1', 35, bytes(31), s.fn); h.mgr.end('d1', 66, s.fn); await h.mgr.idle('d1');
  assert.strictEqual(s.last('dictation:result').text, 'seg2');          // one text for the whole 6.6s
  assert.deepStrictEqual(h.calls, [3, 7]);
});
test('a speculative piece of at least 8s is kept when speech resumes', async () => {
  const h = harness(); const s = sink();
  h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(100), bytes(5, 0)]), s.fn); await h.mgr.idle('d1');  // 10s + pause
  h.mgr.chunk('d1', 105, bytes(30), s.fn); h.mgr.end('d1', 135, s.fn); await h.mgr.idle('d1');
  assert.deepStrictEqual(h.calls, [10, 3]);
  assert.strictEqual(s.last('dictation:result').text, 'seg1 seg2');
});
test('a stop during a speculative transcription waits for it instead of starting another', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let n = 0;
  const h = harness({ transcribeWav: async () => { n++; await gate; return 'ahead'; } });
  const s = sink(); h.mgr.start('d1', 'adts', false, s.fn);
  h.mgr.chunk('d1', 0, Buffer.concat([bytes(50), bytes(5, 0)]), s.fn);
  await new Promise((r) => setImmediate(r)); h.mgr.end('d1', 55, s.fn); release(); await h.mgr.idle('d1');
  assert.strictEqual(n, 1);
  assert.strictEqual(s.last('dictation:result').text, 'ahead');
});
test('no speculation on silence only', async () => { const h = harness(); const s = sink(); h.mgr.start('d1', 'adts', false, s.fn); h.mgr.chunk('d1', 0, bytes(30, 0), s.fn); await h.mgr.idle('d1'); assert.deepStrictEqual(h.calls, []); });
```

- [ ] **Step 2: Fehlschlag prüfen.**

- [ ] **Step 3: Umsetzen.** In `transcribeReady` (nicht final), nachdem alle regulären Stücke geschnitten sind: liefert `edgePause(samples, cursor, RATE)` eine Stelle `to` und gibt es noch kein `spec` mit `from === cursor && to === to`, dann `[cursor, to + 0.15 s)` transkribieren und als `spec` merken.

  Beim nächsten Durchlauf mit `spec`:
  - Gibt es zwischen `spec.to` und dem Pufferende keine Sprache (`hasSpeech` falsch) → nichts tun.
  - Sonst, wenn `spec.to - cursor >= MIN_SEGMENT_SECS * RATE`: Text übernehmen, `cursor` in die Mitte der Pause nach `spec.to` setzen, `spec = null`.
  - Sonst `spec = null` (wird später mit dem Folgenden zusammen transkribiert).

  Final: zuerst dieselbe Prüfung wie oben (ein Stopp kann vor dem nächsten gewöhnlichen Durchlauf eintreffen). Liegt nach `spec.to` keine Sprache → Text übernehmen, `cursor = samples.length`, kein Whisper-Aufruf, `specHit = true`. Wurde ein langes Vorab-Stück übernommen, folgt der normale letzte Durchlauf für den Rest; wurde es verworfen, für alles ab `cursor`.

  Alles läuft in der bestehenden `s.work`-Kette, dadurch wartet ein Stopp von selbst auf einen laufenden Vorab-Auftrag.

- [ ] **Step 4: Tests grün** (`npm test`, `npx tsc --noEmit -p .`).

- [ ] **Step 5: Messen.** Task-5-Skript mit `--cut=new --piece=0.5 --stop-delay=600` und `--stop-delay=0` für alle vier Aufnahmen; Zeilen in die Tabelle „Messung“ ergänzen. Erwartet mit 600 ms: unter 0,3 s.

- [ ] **Step 6: Commit** — `git commit -m "feat(dictation): transcribe ahead at a trailing pause"`

---

### Task 7: App und Bubble laden alle 500 ms hoch

**Files:**
- Modify: `mobile/src/season2/hooks/useDictation.ts:29` (`PUMP_INTERVAL_MS`)
- Modify: `mobile/android/app/src/main/java/com/tms/terminal/bubble/DictationBubbleService.kt:34` (`PUMP_MS`)
- Modify: `server/src/websocket/rate-limiter.ts` (nur der Kommentar „one small message every ~2s“)

**Interfaces:**
- Consumes: nichts Neues. `DictationUpload.pump()` ist bereits gegen überlappende Aufrufe geschützt (`pumping`-Promise); der Rate-Limiter lässt 100 Nachrichten je Sekunde in der Klasse `typing` durch.

- [ ] **Step 1:** Beide Konstanten auf 500 setzen. Kommentar im Rate-Limiter anpassen.
- [ ] **Step 2: Prüfen.** `cd mobile && npx tsc --noEmit`; `cd mobile/android && ./gradlew :app:testDebugUnitTest` → beide ohne Fehler. `cd server && npm test` → `fail 0`.
- [ ] **Step 3: Akku-Gegenprobe Bubble** nach dem Messrezept aus v1.129.1: CPU-Zeit des `:bubble`-Prozesses über 60 s **Aufnahme** vor und nach der Änderung (im Leerlauf läuft der Takt nicht). Wert notieren; mehr als das Doppelte → Takt auf 750 ms und erneut messen.
- [ ] **Step 4: Commit** — `git commit -m "feat(dictation): upload every 500ms so the server sees pauses in time"`

**Auslieferung Geräte-Teil:** Version erhöhen und Release über den Tag-Workflow — erst nach Freigabe durch den Nutzer. Alte App + neuer Server und neue App + alter Server müssen beide weiter funktionieren (kein Protokoll geändert).

---

### Task 8: Am echten Gerät gegen das Ziel prüfen

**Files:**
- Modify: `memory/journal.md`, `memory/project-state.md`

- [ ] **Step 1:** Nach mindestens 50 echten Diktaten mit neuer App und neuem Server `~/.tms-terminal/dictation-stats.json` auswerten: Mitte, Anteil ≤ 0,7 s, Anteil `specHit`.
- [ ] **Step 2:** Mit Ziel vergleichen (Mitte ≤ 0,5 s, ≥ 90 % ≤ 0,7 s). Verfehlt → die langsamsten Diktate im Log ansehen (`rest N.Ns`) und die Ursache benennen, bevor eine Stellschraube gedreht wird.
- [ ] **Step 3:** Ergebnis ins Journal und in den Projektzustand; dem Nutzer die Zahlen nennen. Erst danach beginnt der Plan für das Wörterbuch.

---

## Messung

Task 5, 2026-11-11, MacBook M4 Max unter Fremdlast (Load 7–13), Aufnahmen aus `scripts/dictation-fixtures.sh` (Stimme Anna), Upload-Takt 2 s wie die heutige App, 8-fache Geschwindigkeit. „alt“ = 60-s-Regel, „neu“ = Pausen-Regel mit Vorrang für Satzpausen.

| Aufnahme | Regel | Stopp → Text | Rest nach Stopp | Aufrufe | Wortfehler |
|---|---|---|---|---|---|
| 12 s | alt | 662 ms | 12,4 s | 1 | 0 von 27 |
| 12 s | neu | 673 ms | 12,4 s | 1 | 0 von 27 |
| 47 s | alt | 1930 ms | 47,5 s | 1 | 1 von 114 |
| 47 s | neu | 597 ms | 13,1 s | 4 | 1 von 114 |
| 183 s | alt | 2724–2753 ms | 68,4 s | 3 | 2 von 434 |
| 183 s | neu | 514–631 ms | 6,2–12,1 s | 15–16 | 2 von 434 |
| 366 s | alt | 2560–2857 ms | 60,2 s | 6 | 3 von 875 |
| 366 s | neu | 578–593 ms | 11,1 s | 31 | 3 von 875 |

**Nachgestellt (Step 4):** Die erste Fassung der Regel („letzte Pause ab 0,3 s“) war gleich schnell, machte aber bei 366 s 7–15 statt 3 Wortfehler; einmal fehlte ein Halbsatz. Ursache: Schnitte an kurzen Atempausen mitten im Satz. Verglichen wurden Mindestlänge 12 s (7 Fehler), 15 s (4–5 Fehler) und „Satzpause ab 0,4 s bevorzugen“ (3 Fehler = wie alt). Gewählt: Satzpausen-Vorrang, kurze Pause erst nach 16 s ohne Satzpause (`SENTENCE_PAUSE_SECS`, `SETTLE_SECS`). `MIN_SEGMENT_SECS` bleibt 8.

**Offen:** Kurze Diktate (unter etwa 15 s) bleiben bei rund 0,67 s — sie bestehen aus einem einzigen Stück. Das behebt erst das Vorauseilen (Task 6) zusammen mit dem schnelleren Upload (Task 7). Die Aufnahmen sind Sprachausgabe mit sehr regelmäßigen Pausen; echte Sprache wird in Task 8 am Gerät gemessen.
