# Fernzugriff (Remote Desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Hinweis für dieses Projekt:** Der Nutzer wünscht ausdrücklich **keine** Subagenten für die Implementierung. Es gilt `superpowers:executing-plans` im Hauptkontext.

**Goal:** Vom Handy aus den Bildschirm des verbundenen Mac oder Windows-Rechners sehen und ihn über Trackpad, Bildschirmtastatur oder angeschlossene Hardware bedienen.

**Architecture:** Der PC nimmt seinen Hauptbildschirm auf, kodiert ihn als H.264 und schickt Access Units über eine eigene WebSocket-Verbindung `/remote` an die App. Die Seite im WebView dekodiert mit WebCodecs auf ein Canvas und schickt Eingaben als kurze JSON-Nachrichten zurück, die ein dauerhafter Helferprozess in echte Systemeingaben übersetzt.

**Tech Stack:** Node 20 + TypeScript + `ws` (Server) · Swift 6 mit ScreenCaptureKit und VideoToolbox (macOS-Helfer) · ffmpeg mit `ddagrab` und PowerShell/`SendInput` (Windows) · WebCodecs im Android-WebView (App)

**Spec:** `docs/superpowers/specs/2026-08-18-fernzugriff-design.md`

## Global Constraints

- **Server- und App-Code:** `~/Desktop/tms-terminal`, Zweig `feat/manager-chat-redesign`. Dort läuft der ausgelieferte Server — nicht auf `master`.
- **Mockup:** `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`, Zweig `master`. Der Bauschritt liest den Mockup **fest von diesem Pfad**.
- **Nach jeder Mockup-Änderung:** `cd ~/Desktop/tms-terminal/mobile && npm run build:season2` — erzeugt `src/season2/web/liquidDeckHtml.ts`. Diese Datei **muss mit eingecheckt werden**. `liquidDeckHtml.ts` wird nie von Hand bearbeitet.
- **Tests:** `cd ~/Desktop/tms-terminal/server && npm test` (führt `node --require ts-node/register --test 'src/**/*.test.ts'` aus).
- **Zur Testausgabe:** Dieses Node schreibt die Zusammenfassung als `ℹ pass 5` / `ℹ fail 0`, **nicht** als `# pass 5`. Wo unten „Erwartet: `# pass N`" steht, ist die Zahl gemeint, nicht das Zeichen davor.
- **Keine neuen npm-Abhängigkeiten.** Der Fernzugriff kommt mit Bordmitteln aus; auf Windows wird ffmpeg vorausgesetzt, auf macOS gar nichts.
- **Kein `any`.** `npx tsc --noEmit` muss nach jeder Aufgabe fehlerfrei durchlaufen — aber nicht dadurch, dass ein Typfehler mit `any` zugedeckt wird. In Aufgabe 2 warf `Buffer.alloc()` unter `strict` einen `TS2322`; die richtige Antwort war eine ausdrückliche Annotation (`let carry: Buffer = …`), nicht `any`. Diese Regel gilt für jede Aufgabe.
- **UI-Texte deutsch.** Kommentare in der Sprache der Datei, die bearbeitet wird (`server/src` englisch, `season2`/Mockup deutsch).
- **Nie das Ja/Nein-Muster einer Berechtigungsabfrage wörtlich in Testnamen oder Fixtures schreiben.** Die Sitzung läuft im PTY des Servers; dessen Erkennung liest die eigene Ausgabe mit. Siehe `server/src/websocket/approval.util.test.ts` für das Ausweichmuster.
- **Der Server-Neustart erfolgt durch den Nutzer**, nie durch den Umsetzenden — ein Neustart beendet die laufende Sitzung auf dem PC.
- **Feste Werte aus der Spezifikation** (wörtlich zu übernehmen):
  - Stufen: `sparsam` 1280/24/800 · `auto` 1600/30/1500 · `scharf` 1920/30/3000 (maxWidth/fps/kbit-s)
  - Rückstau: >512 KB nur Vollbilder · >1 MB Bitrate halbieren, Untergrenze 300 kbit/s · 3 s unter 128 KB → +25 % bis zum Stufenwert
  - Helfer-Neustart: 0,5 s / 1 s / 2 s, danach `helper_crashed`
- **Falls Git hängt** (iCloud lagert den Desktop-Ordner gelegentlich aus): auf Plumbing ausweichen — `git hash-object -w`, `GIT_INDEX_FILE=/private/tmp/idx git read-tree HEAD`, `git update-index --add --cacheinfo`, `git write-tree`, `git commit-tree`, `git update-ref`. Zum Zeitpunkt der Planung antwortete Git in beiden Arbeitskopien in unter 3 s.

## Präzisierung gegenüber der Spezifikation

Beim Ausarbeiten von Aufgabe 2 ist ein Punkt aufgefallen, den die Spezifikation offenließ:

Ein H.264-Bild endet im Annex-B-Strom erst dort, wo der **nächste** Startcode beginnt. Wer streng darauf wartet, hält jedes Bild bis zum Eintreffen des folgenden fest — bei 30 fps sind das 33 ms zusätzliche Verzögerung, ein Viertel des gesamten Zeitbudgets. Der Zerteiler bekommt deshalb einen **Leerlauf-Abschluss**: kommen 6 ms lang keine neuen Bytes, gilt die offene Access Unit als vollständig. Die Zeit wird von außen hereingereicht, damit das ohne Warten testbar bleibt.

Beide Encoder werden auf **ein Slice pro Bild** festgelegt, damit „VCL-NAL gesehen“ zuverlässig „Bild fertig“ bedeutet.

Zwei weitere Abweichungen, bewusst und klein:

- Die Spezifikation nennt `remote.manager.ts` und `remote.socket.ts` als getrennte Module. Der Plan führt beides in `remote.socket.ts`: es gibt genau **eine** Sitzung pro Verbindung, und deren Lebenszyklus ist der Lebenszyklus der Verbindung. Ein eigenes Verwaltungsmodul hätte nichts zu verwalten. Wächst später eine zweite Sitzung je Server hinzu, ist das die Stelle zum Aufteilen.
- Die Spezifikation lässt offen, wie ein abgestürzter Helfer und ein Auflösungswechsel zusammenhängen. Der Plan behandelt beide gleich (Aufgabe 18): Aufnahme neu starten, neue Maße schicken. Beim Auflösungswechsel stirbt die laufende Aufnahme ohnehin.

---

### Task 1: Wegwerf-Test — läuft die Bildschirmaufnahme auf diesem Mac überhaupt?

Das ist der einzige echte Unbekannte des ganzen Vorhabens (Spezifikation Abschnitt 12.1). Ergebnis dieser Aufgabe ist **eine Antwort mit Zahlen**, kein Code, der bleibt. Alles hier Gebaute wird am Ende gelöscht oder ausdrücklich als Wegwerf markiert.

**Files:**
- Create (Wegwerf): `/private/tmp/tms-spike/Capture.swift`
- Create (Wegwerf): `/private/tmp/tms-spike/measure.sh`

**Interfaces:**
- Consumes: nichts
- Produces: nur eine Entscheidung — geht ScreenCaptureKit + VideoToolbox auf macOS 26, und mit welcher Verzögerung? Aufgabe 6 baut darauf auf.

- [ ] **Step 1: Wegwerf-Aufnahme schreiben**

`/private/tmp/tms-spike/Capture.swift`:

```swift
// WEGWERF — nur zum Messen, wandert nicht ins Projekt.
import Foundation
import ScreenCaptureKit
import VideoToolbox

final class Spike: NSObject, SCStreamOutput {
  var session: VTCompressionSession?
  var frames = 0
  var firstOut: Double = 0

  func run() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else {
      FileHandle.standardError.write("{\"error\":\"no display\"}\n".data(using: .utf8)!)
      exit(2)
    }
    FileHandle.standardError.write(
      "{\"display\":{\"w\":\(display.width),\"h\":\(display.height)}}\n".data(using: .utf8)!)

    let cfg = SCStreamConfiguration()
    cfg.width = 1600
    cfg.height = Int(Double(display.height) * (1600.0 / Double(display.width)))
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    cfg.showsCursor = true

    VTCompressionSessionCreate(
      allocator: nil, width: Int32(cfg.width), height: Int32(cfg.height),
      codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
      imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &session)
    guard let s = session else { exit(3) }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
                         value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         value: NSNumber(value: 60))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate,
                         value: NSNumber(value: 1_500_000))

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
    try stream.addStreamOutput(self, type: .screen,
                               sampleHandlerQueue: DispatchQueue(label: "spike"))
    try await stream.startCapture()
    try await Task.sleep(nanoseconds: 5_000_000_000)
    try await stream.stopCapture()
    FileHandle.standardError.write("{\"frames\":\(frames)}\n".data(using: .utf8)!)
  }

  func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, CMSampleBufferIsValid(buf),
          let px = CMSampleBufferGetImageBuffer(buf), let sess = session else { return }
    let arrived = CFAbsoluteTimeGetCurrent()
    VTCompressionSessionEncodeFrame(
      sess, imageBuffer: px, presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(buf),
      duration: .invalid, frameProperties: nil, infoFlagsOut: nil
    ) { [weak self] _, _, sample in
      guard let self, sample != nil else { return }
      self.frames += 1
      if self.frames == 1 { self.firstOut = CFAbsoluteTimeGetCurrent() - arrived }
      if self.frames % 30 == 0 {
        let ms = Int((CFAbsoluteTimeGetCurrent() - arrived) * 1000)
        FileHandle.standardError.write("{\"encodeMs\":\(ms)}\n".data(using: .utf8)!)
      }
    }
  }
}

let spike = Spike()
Task { try await spike.run(); exit(0) }
RunLoop.main.run()
```

- [ ] **Step 2: Übersetzen und laufen lassen**

```bash
mkdir -p /private/tmp/tms-spike && cd /private/tmp/tms-spike
swiftc -O -framework ScreenCaptureKit -framework VideoToolbox -o spike Capture.swift
./spike
```

Erwartung beim **ersten** Lauf: macOS fragt nach der Bildschirmaufnahme-Berechtigung, oder die Ausgabe ist `{"error":"no display"}` bzw. `frames: 0`. Beides ist ein gültiges Zwischenergebnis — dann in *Systemeinstellungen → Datenschutz & Sicherheit → Bildschirmaufnahme* das Terminal freigeben und erneut starten.

- [ ] **Step 3: Die drei Zahlen festhalten**

Notiere aus der Ausgabe:
1. **Bilder in 5 Sekunden** — bei 30 fps sind ~150 zu erwarten, alles unter 120 ist ein Problem
2. **`encodeMs`** — Aufnahme bis kodiertes Bild; über 30 ms wäre zu langsam
3. **Auflösung** des gefundenen Bildschirms

- [ ] **Step 4: Entscheidung treffen und festhalten**

- Zahlen in Ordnung → weiter mit Aufgabe 2; Aufgabe 6 baut den echten Helfer auf diesem Gerüst auf.
- ScreenCaptureKit liefert gar nichts → **anhalten und den Nutzer fragen.** Ersatzweg wäre `-f avfoundation` in ffmpeg nach erteilter Berechtigung; das ändert Aufgabe 6 grundlegend und ist keine Entscheidung, die nebenbei getroffen wird.

- [ ] **Step 5: Aufräumen**

```bash
rm -rf /private/tmp/tms-spike
```

Kein Commit — hier entsteht bewusst nichts Bleibendes.

---

### Task 2: `annexb.ts` — H.264-Strom in Access Units zerteilen

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/annexb.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/annexb.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  ```ts
  export interface AccessUnit { data: Buffer; keyframe: boolean }
  export interface AnnexBSplitter {
    push(chunk: Buffer, nowMs: number): AccessUnit[];
    tick(nowMs: number): AccessUnit[];
  }
  export function createAnnexBSplitter(idleMs?: number): AnnexBSplitter;
  ```
  Aufgabe 10 benutzt beide Methoden; Aufgaben 6 und 8 liefern die rohen Bytes.

- [ ] **Step 1: Write the failing test**

`server/src/remote/annexb.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnexBSplitter } from './annexb';

/** Baut eine NAL mit 4-Byte-Startcode: 00 00 00 01 <header> <payload…> */
function nal(type: number, payloadLen = 4): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0x60 | type]),
    Buffer.alloc(payloadLen, 0xaa),
  ]);
}

const SPS = () => nal(7);
const PPS = () => nal(8);
const IDR = () => nal(5);
const SLICE = () => nal(1);

test('ein Vollbild wird nach der VCL-NAL abgeschlossen', () => {
  const s = createAnnexBSplitter();
  assert.deepEqual(s.push(Buffer.concat([SPS(), PPS(), IDR()]), 0), []);
  const units = s.push(SLICE(), 40);
  assert.equal(units.length, 1, 'die erste Access Unit wird beim nächsten Startcode fertig');
  assert.equal(units[0].keyframe, true, 'SPS/PPS/IDR ist ein Vollbild');
});

test('Zwischenbilder sind keine Vollbilder', () => {
  const s = createAnnexBSplitter();
  s.push(Buffer.concat([SPS(), PPS(), IDR()]), 0);
  s.push(SLICE(), 40);
  const units = s.push(SLICE(), 80);
  assert.equal(units.length, 1);
  assert.equal(units[0].keyframe, false);
});

test('Leerlauf schliesst die offene Access Unit ab', () => {
  const s = createAnnexBSplitter(6);
  assert.deepEqual(s.push(Buffer.concat([SPS(), PPS(), IDR()]), 100), []);
  assert.deepEqual(s.tick(104), [], 'vor Ablauf der Leerlaufzeit passiert nichts');
  const units = s.tick(107);
  assert.equal(units.length, 1, 'nach 6 ms ohne neue Bytes gilt das Bild als fertig');
  assert.equal(units[0].keyframe, true);
});

test('an beliebiger Stelle zerschnittene Eingaben ergeben dasselbe', () => {
  const whole = Buffer.concat([SPS(), PPS(), IDR(), SLICE(), SLICE()]);
  const ganz = createAnnexBSplitter();
  const erwartet = ganz.push(whole, 0).concat(ganz.tick(999));

  const stueckweise = createAnnexBSplitter();
  const got: ReturnType<typeof ganz.push> = [];
  for (let i = 0; i < whole.length; i += 3) {
    got.push(...stueckweise.push(whole.subarray(i, i + 3), i));
  }
  got.push(...stueckweise.tick(9999));

  assert.equal(got.length, erwartet.length);
  got.forEach((au, i) => {
    assert.equal(au.keyframe, erwartet[i].keyframe, `Vollbild-Kennzeichen bei ${i}`);
    assert.deepEqual(au.data, erwartet[i].data, `Nutzdaten bei ${i}`);
  });
});

test('3-Byte- und 4-Byte-Startcodes werden beide erkannt', () => {
  const s = createAnnexBSplitter();
  const dreiByte = Buffer.concat([Buffer.from([0, 0, 1, 0x65]), Buffer.alloc(4, 0xaa)]);
  s.push(Buffer.concat([SPS(), PPS()]), 0);
  s.push(dreiByte, 1);
  const units = s.tick(99);
  assert.equal(units.length, 1);
  assert.equal(units[0].keyframe, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/annexb.test.ts
```

Erwartet: FAIL — `Cannot find module './annexb'`.

- [ ] **Step 3: Write minimal implementation**

`server/src/remote/annexb.ts`:

```ts
/**
 * Splits a raw H.264 Annex-B byte stream into access units (one per frame).
 *
 * A frame's last NAL only ends where the next start code begins, so a strict
 * splitter would hold every frame until the following one arrives — 33 ms of
 * pure latency at 30 fps. Hence the idle flush: if no new bytes arrive for
 * `idleMs`, the open access unit is considered complete. Time is passed in so
 * this stays testable without waiting.
 *
 * Both platform encoders are configured for a single slice per frame, which is
 * what makes "VCL NAL seen" equal "frame complete".
 */
export interface AccessUnit { data: Buffer; keyframe: boolean }

export interface AnnexBSplitter {
  push(chunk: Buffer, nowMs: number): AccessUnit[];
  tick(nowMs: number): AccessUnit[];
}

const IDR = 5;
const NON_IDR = 1;
const SPS = 7;

/** Index of the next 00 00 01 at or after `from`, or -1. */
function indexOfStart(buf: Buffer, from: number): number {
  for (let i = from; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
  }
  return -1;
}

export function createAnnexBSplitter(idleMs = 6): AnnexBSplitter {
  let carry = Buffer.alloc(0);
  let pending: Buffer[] = [];
  let keyframe = false;
  let lastByteAt = 0;

  function flush(): AccessUnit | null {
    if (!pending.length) return null;
    const au: AccessUnit = { data: Buffer.concat(pending), keyframe };
    pending = [];
    keyframe = false;
    return au;
  }

  /** Adds one complete NAL (start code included) and reports a finished unit. */
  function consume(nalUnit: Buffer): AccessUnit | null {
    const start = nalUnit[2] === 1 ? 3 : 4; // 00 00 01 vs 00 00 00 01
    const type = nalUnit[start] & 0x1f;

    // A new parameter set begins the next frame — close the current one first.
    const out = type === SPS && pending.length ? flush() : null;

    pending.push(nalUnit);
    if (type === IDR) keyframe = true;

    // Single slice per frame: the VCL NAL is the last one of its access unit.
    if (type === IDR || type === NON_IDR) return out ?? flush();
    return out;
  }

  return {
    push(chunk, nowMs) {
      lastByteAt = nowMs;
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;

      const out: AccessUnit[] = [];
      let i = indexOfStart(carry, 0);
      if (i < 0) return out;
      // Ein 4-Byte-Startcode (00 00 00 01) wird als 00 00 01 an Position i+1
      // gefunden. Steht er am Anfang des Restpuffers, ginge sein fuehrendes
      // Null-Byte sonst verloren — bei haeppchenweiser Zufuhr liegen die
      // NAL-Grenzen anders als beim Einmal-Push, und die Nutzdaten weichen ab.
      if (i > 0 && carry[i - 1] === 0) i--;

      let next = indexOfStart(carry, i + 3);
      while (next >= 0) {
        // A 4-byte start code shows up as 00 00 01 preceded by a zero byte.
        const end = next > i && carry[next - 1] === 0 ? next - 1 : next;
        const au = consume(carry.subarray(i, end));
        if (au) out.push(au);
        i = end;
        next = indexOfStart(carry, i + 3);
      }
      carry = carry.subarray(i);
      return out;
    },

    tick(nowMs) {
      if (!carry.length && !pending.length) return [];
      if (nowMs - lastByteAt < idleMs) return [];
      if (carry.length) {
        const au = consume(carry);
        carry = Buffer.alloc(0);
        if (au) return [au];
      }
      const rest = flush();
      return rest ? [rest] : [];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/annexb.test.ts
```

Erwartet: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote/annexb.ts server/src/remote/annexb.test.ts
git commit -m "feat(remote): H.264-Annex-B-Zerteiler mit Leerlauf-Abschluss"
```

---

### Task 3: `bitrate.ts` — Rückstau-Regelung

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/bitrate.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/bitrate.test.ts`

**Interfaces:**
- Consumes: `AccessUnit` aus Aufgabe 2 (nur das Feld `keyframe`)
- Produces:
  ```ts
  export interface GovernorDecision { send: boolean; bitrateKbps: number | null }
  export interface BitrateGovernor {
    decide(au: { keyframe: boolean }, bufferedBytes: number, nowMs: number): GovernorDecision;
    setTarget(kbps: number): void;
  }
  export function createBitrateGovernor(targetKbps: number): BitrateGovernor;
  ```
  `bitrateKbps` ist `null`, wenn sich nichts ändert — nur bei einem Wert ruft Aufgabe 10 `capture.setBitrate()`.

- [ ] **Step 1: Write the failing test**

`server/src/remote/bitrate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitrateGovernor } from './bitrate';

const KB = 1024;
const zwischenbild = { keyframe: false };
const vollbild = { keyframe: true };

test('bei leerem Puffer geht alles durch und nichts wird geregelt', () => {
  const g = createBitrateGovernor(1500);
  assert.deepEqual(g.decide(zwischenbild, 10 * KB, 0), { send: true, bitrateKbps: null });
});

test('ueber 512 KB kommen nur noch Vollbilder durch', () => {
  const g = createBitrateGovernor(1500);
  assert.equal(g.decide(zwischenbild, 600 * KB, 0).send, false, 'Zwischenbild faellt weg');
  assert.equal(g.decide(vollbild, 600 * KB, 0).send, true, 'Vollbild kommt durch');
});

test('ueber 1 MB wird die Bitrate halbiert', () => {
  const g = createBitrateGovernor(1500);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 750);
});

test('die Bitrate faellt nie unter 300', () => {
  const g = createBitrateGovernor(1500);
  let now = 0;
  for (let i = 0; i < 8; i++) g.decide(vollbild, 1100 * KB, (now += 1000));
  const letzte = g.decide(vollbild, 1100 * KB, (now += 1000));
  assert.equal(letzte.bitrateKbps, null, 'an der Untergrenze wird nicht weiter gesenkt');
});

test('nach 3 s unter 128 KB steigt die Bitrate um 25 %, hoechstens bis zum Sollwert', () => {
  const g = createBitrateGovernor(1000);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 500, 'erst halbieren');
  assert.equal(g.decide(zwischenbild, 50 * KB, 1000).bitrateKbps, null,
               'die ruhige Phase beginnt hier erst zu zaehlen');
  assert.equal(g.decide(zwischenbild, 50 * KB, 3900).bitrateKbps, null,
               '2,9 s sind noch nicht 3 s');
  assert.equal(g.decide(zwischenbild, 50 * KB, 4100).bitrateKbps, 625, '+25 % nach 3,1 s');
  assert.equal(g.decide(zwischenbild, 50 * KB, 7300).bitrateKbps, 781, 'weiter hoch');
  let now = 7300;
  for (let i = 0; i < 3; i++) g.decide(zwischenbild, 50 * KB, (now += 3100));
  assert.equal(g.decide(zwischenbild, 50 * KB, (now += 3100)).bitrateKbps, null,
               'am Sollwert ist Schluss');
});

test('ein neuer Sollwert hebt die Obergrenze wieder an', () => {
  const g = createBitrateGovernor(800);
  assert.equal(g.decide(vollbild, 1100 * KB, 0).bitrateKbps, 400, 'erst halbieren');
  g.setTarget(3000);
  g.decide(zwischenbild, 50 * KB, 100);                          // ruhige Phase beginnt
  assert.equal(g.decide(zwischenbild, 50 * KB, 3200).bitrateKbps, 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/bitrate.test.ts
```

Erwartet: FAIL — `Cannot find module './bitrate'`.

- [ ] **Step 3: Write minimal implementation**

`server/src/remote/bitrate.ts`:

```ts
/**
 * Backpressure governor for the remote screen stream.
 *
 * When the network stalls, the socket's send buffer grows. Piling more frames
 * on top would show seconds-old images; instead we drop inter frames, then step
 * the bitrate down, and creep back up once the buffer stays empty.
 *
 * Pure state machine — no socket, no timers — so every branch is testable.
 */
const DROP_ABOVE = 512 * 1024;
const HALVE_ABOVE = 1024 * 1024;
const CALM_BELOW = 128 * 1024;
const CALM_MS = 3000;
const MIN_KBPS = 300;

export interface GovernorDecision { send: boolean; bitrateKbps: number | null }

export interface BitrateGovernor {
  decide(au: { keyframe: boolean }, bufferedBytes: number, nowMs: number): GovernorDecision;
  setTarget(kbps: number): void;
}

export function createBitrateGovernor(targetKbps: number): BitrateGovernor {
  let target = targetKbps;
  let current = targetKbps;
  let calmSince: number | null = null;

  return {
    setTarget(kbps) { target = kbps; },

    decide(au, bufferedBytes, nowMs) {
      let bitrateKbps: number | null = null;

      if (bufferedBytes > HALVE_ABOVE) {
        calmSince = null;
        const next = Math.max(MIN_KBPS, Math.floor(current / 2));
        if (next !== current) { current = next; bitrateKbps = current; }
      } else if (bufferedBytes < CALM_BELOW) {
        if (calmSince === null) calmSince = nowMs;
        else if (nowMs - calmSince >= CALM_MS) {
          calmSince = nowMs;
          const next = Math.min(target, Math.floor(current * 1.25));
          if (next !== current) { current = next; bitrateKbps = current; }
        }
      } else {
        calmSince = null;
      }

      const send = bufferedBytes <= DROP_ABOVE || au.keyframe;
      return { send, bitrateKbps };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/bitrate.test.ts
```

Erwartet: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote/bitrate.ts server/src/remote/bitrate.test.ts
git commit -m "feat(remote): Rueckstau-Regelung fuer den Bildstrom"
```

---

### Task 4: `geometry.ts` — Koordinaten umrechnen

Der Punkt, an dem es sonst still schiefgeht: die Aufnahme läuft in **Pixeln**, `CGEvent` auf dem Mac erwartet **logische Punkte** (auf Retina-Geräten die Hälfte), und `SendInput` auf Windows will 0…65535 über den virtuellen Bildschirm. Deshalb steht `scale` im Protokoll.

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/geometry.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/geometry.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  ```ts
  export interface CaptureGeometry { width: number; height: number; scale: number }
  export function clamp01(v: number): number;
  export function toLogicalPoint(nx: number, ny: number, g: CaptureGeometry): { x: number; y: number };
  export function toWindowsAbsolute(nx: number, ny: number): { x: number; y: number };
  ```
  Aufgabe 7 nutzt `toLogicalPoint`, Aufgabe 9 `toWindowsAbsolute`, Aufgabe 10 `clamp01`.

- [ ] **Step 1: Write the failing test**

`server/src/remote/geometry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp01, toLogicalPoint, toWindowsAbsolute } from './geometry';

test('clamp01 haelt Werte im gueltigen Bereich', () => {
  assert.equal(clamp01(-0.4), 0);
  assert.equal(clamp01(1.7), 1);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01(Number.NaN), 0, 'kaputte Eingaben landen links oben, nicht irgendwo');
});

test('toLogicalPoint rechnet Retina-Pixel in Punkte um', () => {
  const retina = { width: 3024, height: 1964, scale: 2 };
  assert.deepEqual(toLogicalPoint(0, 0, retina), { x: 0, y: 0 });
  assert.deepEqual(toLogicalPoint(1, 1, retina), { x: 1512, y: 982 });
  assert.deepEqual(toLogicalPoint(0.5, 0.5, retina), { x: 756, y: 491 });
});

test('toLogicalPoint laesst Bildschirme ohne Skalierung unveraendert', () => {
  assert.deepEqual(toLogicalPoint(0.5, 0.25, { width: 1920, height: 1080, scale: 1 }),
                   { x: 960, y: 270 });
});

test('toLogicalPoint faengt Werte ausserhalb ab', () => {
  const g = { width: 1920, height: 1080, scale: 1 };
  assert.deepEqual(toLogicalPoint(-1, 2, g), { x: 0, y: 1080 });
});

test('toWindowsAbsolute spannt auf 0..65535 auf', () => {
  assert.deepEqual(toWindowsAbsolute(0, 0), { x: 0, y: 0 });
  assert.deepEqual(toWindowsAbsolute(1, 1), { x: 65535, y: 65535 });
  assert.deepEqual(toWindowsAbsolute(0.5, 0.5), { x: 32768, y: 32768 });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/geometry.test.ts
```

Erwartet: FAIL — `Cannot find module './geometry'`.

- [ ] **Step 3: Write minimal implementation**

`server/src/remote/geometry.ts`:

```ts
/**
 * Coordinate conversion between the captured image and the two input APIs.
 *
 * Capture happens in pixels. macOS CGEvent wants logical points (half of that
 * on Retina displays), Windows SendInput wants 0..65535 across the virtual
 * screen. Getting this wrong puts the pointer at half or double the distance,
 * which looks like a broken trackpad rather than a unit bug — hence the tests.
 */
export interface CaptureGeometry { width: number; height: number; scale: number }

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function toLogicalPoint(nx: number, ny: number, g: CaptureGeometry): { x: number; y: number } {
  const scale = g.scale > 0 ? g.scale : 1;
  return {
    x: Math.round((clamp01(nx) * g.width) / scale),
    y: Math.round((clamp01(ny) * g.height) / scale),
  };
}

export function toWindowsAbsolute(nx: number, ny: number): { x: number; y: number } {
  return { x: Math.round(clamp01(nx) * 65535), y: Math.round(clamp01(ny) * 65535) };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/geometry.test.ts
```

Erwartet: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote/geometry.ts server/src/remote/geometry.test.ts
git commit -m "feat(remote): Koordinaten-Umrechnung fuer Zeigereingaben"
```

---

### Task 5: Protokoll, `/remote`-Weiche und Steuer-Handschlag

Ab hier gibt es einen Endpunkt, mit dem man reden kann — noch ohne Bild, aber mit vollständigem Start/Stopp/Fehler-Verhalten. Aufnahme und Eingabe werden als Fabriken hereingereicht, damit der Test ohne echten Bildschirm läuft.

**Files:**
- Modify: `~/Desktop/tms-terminal/shared/protocol.ts` (ans Ende anfügen)
- Create: `~/Desktop/tms-terminal/server/src/remote/capture/capture.types.ts`
- Create: `~/Desktop/tms-terminal/server/src/remote/input/input.types.ts`
- Create: `~/Desktop/tms-terminal/server/src/remote/remote.socket.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/remote.socket.test.ts`
- Modify: `~/Desktop/tms-terminal/server/src/config.ts` (ServerConfig + neue Funktion)
- Modify: `~/Desktop/tms-terminal/server/src/websocket/ws.server.ts:31-40` (Pfad-Weiche im `upgrade`-Ereignis)

**Interfaces:**
- Consumes: nichts aus früheren Aufgaben
- Produces:
  ```ts
  // capture.types.ts
  export interface CaptureOptions { fps: number; maxWidth: number; bitrateKbps: number }
  export interface CaptureInfo { width: number; height: number; scale: number }
  export interface ScreenCapture {
    start(opts: CaptureOptions): Promise<CaptureInfo>;
    onData(cb: (chunk: Buffer) => void): void;
    onError(cb: (code: RemoteErrorCode, message: string) => void): void;
    requestKeyframe(): void;
    setBitrate(kbps: number): void;
    stop(): Promise<void>;
  }
  // input.types.ts
  export interface Mods { s: boolean; c: boolean; a: boolean; m: boolean }
  export interface InputInjector {
    moveRelative(dx: number, dy: number): void;
    moveAbsolute(nx: number, ny: number): void;
    button(which: 'left' | 'right' | 'middle', down: boolean): void;
    scroll(dx: number, dy: number): void;
    key(code: string, down: boolean, mods: Mods): void;
    text(s: string): void;
    stop(): Promise<void>;
  }
  // remote.socket.ts
  export const QUALITY_PRESETS: Record<'sparsam' | 'auto' | 'scharf', CaptureOptions>;
  export function isRemotePath(url: string | undefined): boolean;
  export interface RemoteDeps {
    makeCapture: () => ScreenCapture;
    makeInput: () => InputInjector;
    isEnabled: () => boolean;
  }
  export function handleRemoteConnection(ws: RemoteWs, deps: RemoteDeps): void;
  ```
  Aufgabe 6 und 8 liefern `makeCapture`, Aufgabe 7 und 9 `makeInput`, Aufgabe 10 füllt den Video- und Eingabeweg.

- [ ] **Step 1: Protokolltypen anfügen**

Ans Ende von `shared/protocol.ts` (ausdrücklich **nicht** in `ClientMessage`/`ServerMessage` aufnehmen — das ist eine eigene Verbindung):

```ts
// ── Remote desktop (its own WebSocket connection on /remote) ─────────
// Deliberately not part of ClientMessage/ServerMessage: video and input travel
// over a second connection the WebView page opens for itself.

export type RemoteErrorCode =
  | 'permission_screen'
  | 'permission_input'
  | 'capture_unavailable'
  | 'helper_crashed'
  | 'disabled'
  | 'unsupported_platform'
  /** The display was asleep — ScreenCaptureKit then reports no display at all.
   *  Its own code, because otherwise this looks exactly like a missing permission
   *  and sends the user hunting for a checkbox that has long been ticked. */
  | 'display_asleep';

export type RemoteQualityPreset = 'sparsam' | 'auto' | 'scharf';

export interface RemoteStartMessage {
  type: 'remote:start';
  payload: { maxWidth: number; fps: number; bitrateKbps: number };
}
export interface RemoteStopMessage { type: 'remote:stop' }
export interface RemoteQualityMessage {
  type: 'remote:quality';
  payload: { preset: RemoteQualityPreset };
}
export interface RemoteKeyframeMessage { type: 'remote:keyframe' }

export type RemoteClientMessage =
  | RemoteStartMessage | RemoteStopMessage | RemoteQualityMessage | RemoteKeyframeMessage;

export interface RemoteStartedMessage {
  type: 'remote:started';
  payload: { width: number; height: number; scale: number; fps: number; codec: 'avc1' };
}
export interface RemoteStoppedMessage {
  type: 'remote:stopped';
  payload: { reason: string };
}
export interface RemoteErrorMessage {
  type: 'remote:error';
  payload: { code: RemoteErrorCode; message: string };
}
export interface RemoteStatusMessage {
  type: 'remote:status';
  payload: { fps: number; kbps: number; rttMs: number; dropped: number };
}

export type RemoteServerMessage =
  | RemoteStartedMessage | RemoteStoppedMessage | RemoteErrorMessage | RemoteStatusMessage;

/** Input events: short keys, because up to 60 of these travel per second. */
export type RemoteInputEvent =
  | { t: 'd'; dx: number; dy: number }
  | { t: 'm'; x: number; y: number }
  | { t: 'b'; b: 'l' | 'r' | 'm'; d: boolean }
  | { t: 's'; dx: number; dy: number }
  | { t: 'k'; c: string; d: boolean; mods: { s: boolean; c: boolean; a: boolean; m: boolean } }
  | { t: 'x'; s: string };
```

- [ ] **Step 2: Die beiden Schnittstellen-Dateien anlegen**

`server/src/remote/capture/capture.types.ts`:

```ts
import type { RemoteErrorCode } from '../../../../shared/protocol';

export interface CaptureOptions { fps: number; maxWidth: number; bitrateKbps: number }
export interface CaptureInfo { width: number; height: number; scale: number }

/** One screen capture, encoding straight to H.264. Platform backends implement this. */
export interface ScreenCapture {
  start(opts: CaptureOptions): Promise<CaptureInfo>;
  onData(cb: (chunk: Buffer) => void): void;
  onError(cb: (code: RemoteErrorCode, message: string) => void): void;
  requestKeyframe(): void;
  setBitrate(kbps: number): void;
  stop(): Promise<void>;
}
```

`server/src/remote/input/input.types.ts`:

```ts
export interface Mods { s: boolean; c: boolean; a: boolean; m: boolean }

/** Turns remote input events into real system input. Platform backends implement this. */
export interface InputInjector {
  moveRelative(dx: number, dy: number): void;
  /** Normalised 0..1 across the captured screen. */
  moveAbsolute(nx: number, ny: number): void;
  button(which: 'left' | 'right' | 'middle', down: boolean): void;
  scroll(dx: number, dy: number): void;
  /** `code` is a DOM KeyboardEvent.code — the key's position, not its character. */
  key(code: string, down: boolean, mods: Mods): void;
  text(s: string): void;
  stop(): Promise<void>;
}
```

Prüfen, dass der relative Importpfad zu `shared/protocol` stimmt:

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit
```

Erwartet: keine Fehler zu `capture.types.ts`.

- [ ] **Step 3: Write the failing test**

`server/src/remote/remote.socket.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isRemotePath, handleRemoteConnection, QUALITY_PRESETS } from './remote.socket';
import type { ScreenCapture, CaptureOptions } from './capture/capture.types';
import type { InputInjector } from './input/input.types';

/** Minimaler Ersatz fuer den WebSocket: merkt sich, was gesendet wurde. */
class FakeWs extends EventEmitter {
  sent: any[] = [];
  bufferedAmount = 0;
  readyState = 1;
  send(data: any) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close() { this.readyState = 3; this.emit('close'); }
  typed(type: string) { return this.sent.filter((m) => m && m.type === type); }
}

function fakeCapture() {
  const c = {
    started: null as CaptureOptions | null,
    stopped: false,
    keyframes: 0,
    bitrates: [] as number[],
    dataCb: (_: Buffer) => {},
    errCb: (_c: string, _m: string) => {},
    async start(o: CaptureOptions) { c.started = o; return { width: 3024, height: 1964, scale: 2 }; },
    onData(cb: (b: Buffer) => void) { c.dataCb = cb; },
    onError(cb: (code: any, m: string) => void) { c.errCb = cb; },
    requestKeyframe() { c.keyframes++; },
    setBitrate(k: number) { c.bitrates.push(k); },
    async stop() { c.stopped = true; },
  };
  return c as typeof c & ScreenCapture;
}

function fakeInput() {
  const calls: string[] = [];
  const i: any = {
    calls,
    moveRelative: (dx: number, dy: number) => calls.push(`rel ${dx} ${dy}`),
    moveAbsolute: (x: number, y: number) => calls.push(`abs ${x} ${y}`),
    button: (w: string, d: boolean) => calls.push(`btn ${w} ${d}`),
    scroll: (dx: number, dy: number) => calls.push(`scroll ${dx} ${dy}`),
    key: (c: string, d: boolean) => calls.push(`key ${c} ${d}`),
    text: (s: string) => calls.push(`text ${s}`),
    stop: async () => { calls.push('stop'); },
  };
  return i as typeof i & InputInjector;
}

function wire(overrides: Partial<{ enabled: boolean }> = {}) {
  const ws = new FakeWs();
  const capture = fakeCapture();
  const input = fakeInput();
  handleRemoteConnection(ws as any, {
    makeCapture: () => capture,
    makeInput: () => input,
    isEnabled: () => overrides.enabled ?? true,
  });
  return { ws, capture, input };
}

const send = (ws: FakeWs, msg: unknown) => ws.emit('message', Buffer.from(JSON.stringify(msg)), false);

test('isRemotePath erkennt nur den Fernzugriffs-Pfad', () => {
  assert.equal(isRemotePath('/remote?token=abc'), true);
  assert.equal(isRemotePath('/remote'), true);
  assert.equal(isRemotePath('/?token=abc'), false);
  assert.equal(isRemotePath('/remotely'), false);
  assert.equal(isRemotePath(undefined), false);
});

test('remote:start meldet die Bildschirmmasse zurueck', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: { maxWidth: 1600, fps: 30, bitrateKbps: 1500 } });
  await new Promise((r) => setImmediate(r));

  const started = ws.typed('remote:started');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].payload,
    { width: 3024, height: 1964, scale: 2, fps: 30, codec: 'avc1' });
  assert.deepEqual(capture.started, { maxWidth: 1600, fps: 30, bitrateKbps: 1500 });
});

test('ist der Fernzugriff abgeschaltet, kommt ein Fehler statt einer Aufnahme', async () => {
  const { ws, capture } = wire({ enabled: false });
  send(ws, { type: 'remote:start', payload: { maxWidth: 1600, fps: 30, bitrateKbps: 1500 } });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:started').length, 0);
  assert.equal(ws.typed('remote:error')[0].payload.code, 'disabled');
  assert.equal(capture.started, null, 'die Aufnahme darf gar nicht erst anlaufen');
});

test('remote:quality setzt die Stufe und die Bitrate', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  send(ws, { type: 'remote:quality', payload: { preset: 'scharf' } });

  assert.deepEqual(capture.bitrates.at(-1), QUALITY_PRESETS.scharf.bitrateKbps);
});

test('remote:keyframe fordert ein Vollbild an', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  send(ws, { type: 'remote:keyframe' });

  assert.equal(capture.keyframes, 1);
});

test('remote:stop haelt Aufnahme und Eingabe an', async () => {
  const { ws, capture, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  send(ws, { type: 'remote:stop' });
  await new Promise((r) => setImmediate(r));

  assert.equal(capture.stopped, true);
  assert.ok(input.calls.includes('stop'));
  assert.equal(ws.typed('remote:stopped').length, 1);
});

test('faellt die Verbindung weg, bleibt kein Helfer zurueck', async () => {
  const { ws, capture, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  ws.close();
  await new Promise((r) => setImmediate(r));

  assert.equal(capture.stopped, true, 'kein verwaister Aufnahmeprozess');
  assert.ok(input.calls.includes('stop'));
});

test('ein Aufnahmefehler wird als remote:error weitergereicht', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  capture.errCb('permission_screen', 'Bildschirmaufnahme nicht freigegeben');

  const err = ws.typed('remote:error')[0];
  assert.equal(err.payload.code, 'permission_screen');
});

test('kaputte Nachrichten legen die Verbindung nicht lahm', async () => {
  const { ws } = wire();
  ws.emit('message', Buffer.from('kein json'), false);
  ws.emit('message', Buffer.from('{"type":"gibtsnicht"}'), false);
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.typed('remote:started').length, 1, 'danach geht es normal weiter');
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/remote.socket.test.ts
```

Erwartet: FAIL — `Cannot find module './remote.socket'`.

- [ ] **Step 5: `remote.socket.ts` schreiben**

```ts
import type {
  RemoteClientMessage, RemoteServerMessage, RemoteErrorCode, RemoteQualityPreset,
} from '../../../shared/protocol';
import type { ScreenCapture, CaptureOptions } from './capture/capture.types';
import type { InputInjector } from './input/input.types';
import { logger } from '../utils/logger';

/** Fixed rungs from the design doc. `auto` is the default. */
export const QUALITY_PRESETS: Record<RemoteQualityPreset, CaptureOptions> = {
  sparsam: { maxWidth: 1280, fps: 24, bitrateKbps: 800 },
  auto:    { maxWidth: 1600, fps: 30, bitrateKbps: 1500 },
  scharf:  { maxWidth: 1920, fps: 30, bitrateKbps: 3000 },
};

/** The upgrade handler routes every path to the terminal handler — this splits it off. */
export function isRemotePath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0];
  return path === '/remote' || path === '/remote/';
}

export interface RemoteWs {
  send(data: string | Buffer, opts?: { compress?: boolean }): void;
  close(): void;
  readyState: number;
  bufferedAmount: number;
  on(event: 'message', cb: (raw: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface RemoteDeps {
  makeCapture: () => ScreenCapture;
  makeInput: () => InputInjector;
  isEnabled: () => boolean;
}

export function handleRemoteConnection(ws: RemoteWs, deps: RemoteDeps): void {
  let capture: ScreenCapture | null = null;
  let input: InputInjector | null = null;

  // Session-changing messages run one at a time, in order. Two `remote:start`
  // frames can arrive in a single TCP read; started concurrently, the first
  // capture is overwritten and never stopped — an orphaned recording that keeps
  // reading the screen. The queue also preserves the stop→start order the app
  // uses when switching quality.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => { queue = queue.then(fn, fn); };

  const reply = (msg: RemoteServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const fail = (code: RemoteErrorCode, message: string) => reply({
    type: 'remote:error', payload: { code, message },
  });

  async function stop(reason: string, tell = true) {
    const c = capture, i = input;
    capture = null; input = null;
    if (c) await c.stop().catch(() => {});
    if (i) await i.stop().catch(() => {});
    if (tell && (c || i)) reply({ type: 'remote:stopped', payload: { reason } });
  }

  async function start(opts: CaptureOptions) {
    if (!deps.isEnabled()) {
      fail('disabled', 'Fernzugriff ist auf diesem Server abgeschaltet.');
      return;
    }
    await stop('neustart', false);

    // Everything that can throw belongs inside the try — including the factory
    // itself. Outside it, a throwing factory leaves the client with neither
    // `remote:started` nor `remote:error`: the connection just goes quiet.
    try {
      const c = deps.makeCapture();
      // Guard by instance identity, not just queue order. Real backends report
      // crashes asynchronously, so an error from a capture that has since been
      // replaced can land behind a fresh `remote:start` in the queue and tear
      // the new session down — silently, because `tell` is false. Reproduced
      // before this guard existed: A.start → A.stop → B.start → B.stop.
      c.onError((code, message) => {
        if (capture !== null && capture !== c) return;   // stale: capture was replaced
        fail(code, message);
        enqueue(async () => { if (capture === c) await stop('error', false); });
      });
      const info = await c.start(opts);
      capture = c;
      input = deps.makeInput();
      reply({
        type: 'remote:started',
        payload: { ...info, fps: opts.fps, codec: 'avc1' },
      });
      logger.info(`Remote: Sitzung gestartet (${info.width}x${info.height} @${opts.fps})`);
    } catch (e) {
      fail('capture_unavailable', e instanceof Error ? e.message : String(e));
    }
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;                       // die App sendet nur Text hoch
    let msg: RemoteClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof (msg as any).type !== 'string') return;

    switch (msg.type) {
      case 'remote:start':
        enqueue(() => start(msg.payload));
        break;
      case 'remote:stop':
        enqueue(() => stop('stopped by user'));
        break;
      case 'remote:quality': {
        const preset = QUALITY_PRESETS[msg.payload?.preset];
        if (preset && capture) capture.setBitrate(preset.bitrateKbps);
        break;
      }
      case 'remote:keyframe':
        capture?.requestKeyframe();
        break;
      default:
        break;                                   // unbekannte Typen still verwerfen
    }
  });

  ws.on('close', () => { enqueue(() => stop('connection closed', false)); });

  // An EventEmitter whose 'error' fires with no listener throws synchronously.
  // That reaches the global uncaughtException handler in index.ts, which calls
  // process.exit(1) — one dropped mobile connection on /remote would take the
  // whole server down and every terminal session with it. Same pattern as
  // ws.handler.ts.
  ws.on('error', (err) => {
    logger.warn(`Remote: socket error — ${err.message}`);
    enqueue(() => stop('socket error', false));
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/remote.socket.test.ts
```

Erwartet: `# pass 9`, `# fail 0`.

- [ ] **Step 7: Konfigurationsschalter ergänzen**

In `server/src/config.ts` das Feld an `ServerConfig` anfügen und eine Leseabfrage hinzufügen:

```ts
export interface ServerConfig {
  passwordHash?: string;
  jwtSecret: string;
  port: number;
  certFingerprint?: string;
  jwtExpiry?: string;
  /** Fernzugriff (Bildschirm spiegeln und steuern). Vorgabe: an. */
  remoteEnabled?: boolean;
}

/** Remote control is the most powerful thing this server does — one switch to kill it. */
export function isRemoteEnabled(): boolean {
  return loadServerConfig().remoteEnabled !== false;
}
```

- [ ] **Step 8: Pfad-Weiche in `ws.server.ts` einbauen**

In `server/src/websocket/ws.server.ts` importieren und im `upgrade`-Ereignis (Zeile ~31) vor `handleConnection` verzweigen:

```ts
import { isRemotePath, handleRemoteConnection } from '../remote/remote.socket';
import { isRemoteEnabled } from '../config';
import { createScreenCapture } from '../remote/capture';
import { createInputInjector } from '../remote/input';
```

```ts
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const ip = req.socket.remoteAddress || 'unknown';
      if (isRemotePath(req.url)) {
        handleRemoteConnection(ws as any, {
          makeCapture: createScreenCapture,
          makeInput: createInputInjector,
          isEnabled: isRemoteEnabled,
        });
        return;
      }
      handleConnection(ws, ip);
    });
```

`createScreenCapture` und `createInputInjector` entstehen erst in Aufgabe 6 bis 9. Damit dieser Schritt für sich übersetzbar bleibt, zuerst die beiden Auswahl-Dateien mit dem Platzhalter für noch fehlende Plattformen anlegen:

`server/src/remote/capture/index.ts`:

```ts
import { getPlatform } from '../../utils/platform';
import type { ScreenCapture } from './capture.types';

export function createScreenCapture(): ScreenCapture {
  switch (getPlatform()) {
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
```

`server/src/remote/input/index.ts`:

```ts
import { getPlatform } from '../../utils/platform';
import type { InputInjector } from './input.types';

export function createInputInjector(): InputInjector {
  switch (getPlatform()) {
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
```

Aufgabe 6 trägt hier den Fall `darwin` nach, Aufgabe 8 den Fall `win32`. Bis dahin wirft die Auswahl bewusst einen verständlichen Fehler statt still nichts zu tun.

- [ ] **Step 9: Gesamtlauf und Übersetzung prüfen**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit && npm test
```

Erwartet: keine Übersetzungsfehler, alle Tests grün.

- [ ] **Step 10: Commit**

```bash
cd ~/Desktop/tms-terminal
git add shared/protocol.ts server/src/remote server/src/config.ts server/src/websocket/ws.server.ts
git commit -m "feat(remote): /remote-Endpunkt mit Start-, Stopp- und Fehlerbehandlung"
```

---

### Task 6: macOS — Aufnahme über ScreenCaptureKit

Baut auf den Messwerten aus Aufgabe 1 auf. Der Helfer bekommt hier beide Betriebsarten (`--capture` jetzt, `--input` in Aufgabe 7), weil macOS Berechtigungen **pro Binärdatei** vergibt — zwei getrennte Programme hießen zwei getrennte Freigaben.

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/helpers/mac/TmsRemoteHelper.swift`
- Create: `~/Desktop/tms-terminal/server/src/remote/helpers/mac/build.sh`
- Create: `~/Desktop/tms-terminal/server/src/remote/capture/capture.darwin.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/capture/capture.darwin.test.ts`
- Modify: `~/Desktop/tms-terminal/server/src/remote/capture/index.ts`
- Modify: `~/Desktop/tms-terminal/server/src/setup.ts`

**Interfaces:**
- Consumes: `ScreenCapture`, `CaptureOptions`, `CaptureInfo` (Aufgabe 5)
- Produces:
  ```ts
  export function buildHelperArgs(opts: CaptureOptions): string[];
  export function parseHelperLine(line: string):
    | { kind: 'ready'; info: CaptureInfo }
    | { kind: 'error'; code: RemoteErrorCode; message: string }
    | null;
  export function helperBinaryPath(): string;
  export function createDarwinCapture(): ScreenCapture;
  ```
  Aufgabe 7 benutzt `helperBinaryPath()` für dieselbe Binärdatei.

- [ ] **Step 1: Write the failing test**

`server/src/remote/capture/capture.darwin.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { buildHelperArgs, parseHelperLine, helperBinaryPath } from './capture.darwin';

test('buildHelperArgs uebersetzt die Stufe in Helfer-Argumente', () => {
  assert.deepEqual(
    buildHelperArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }),
    ['--capture', '--max-width', '1600', '--fps', '30', '--bitrate', '1500'],
  );
});

test('parseHelperLine liest die Bildschirmmasse', () => {
  const got = parseHelperLine('{"ready":{"width":3024,"height":1964,"scale":2}}');
  assert.deepEqual(got, { kind: 'ready', info: { width: 3024, height: 1964, scale: 2 } });
});

test('parseHelperLine erkennt die fehlende Bildschirmaufnahme-Freigabe', () => {
  const got = parseHelperLine('{"error":{"code":"permission_screen","message":"nicht erlaubt"}}');
  assert.equal(got?.kind, 'error');
  assert.equal((got as any).code, 'permission_screen');
});

test('parseHelperLine verschluckt sich nicht an Zwischenausgaben', () => {
  assert.equal(parseHelperLine(''), null);
  assert.equal(parseHelperLine('irgendein Geschwaetz vom Linker'), null);
  assert.equal(parseHelperLine('{"encodeMs":12}'), null, 'Messwerte sind kein Ereignis');
});

test('unbekannte Fehlercodes werden nicht durchgereicht', () => {
  const got = parseHelperLine('{"error":{"code":"quatsch","message":"x"}}');
  assert.equal(got?.kind, 'error');
  assert.equal((got as any).code, 'capture_unavailable', 'faellt auf einen bekannten Code zurueck');
});

test('der uebersetzte Helfer liegt dort, wo der Server ihn sucht', { skip: process.platform !== 'darwin' }, () => {
  assert.ok(fs.existsSync(helperBinaryPath()),
    `Helfer fehlt unter ${helperBinaryPath()} — "npm run build:helper" ausfuehren`);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/capture/capture.darwin.test.ts
```

Erwartet: FAIL — `Cannot find module './capture.darwin'`.

- [ ] **Step 3: Den Swift-Helfer schreiben**

`server/src/remote/helpers/mac/TmsRemoteHelper.swift` — die Aufnahmehälfte (die Eingabehälfte kommt in Aufgabe 7 in dieselbe Datei):

```swift
// TMS Terminal remote helper.
//
// Two modes, one binary — macOS grants privacy permissions per executable, so
// splitting capture and input into separate programs would mean two separate
// grants for the user to hunt down.
//
//   --capture --max-width 1600 --fps 30 --bitrate 1500
//        stdout: raw H.264 Annex-B
//        stderr: one JSON object per line ({"ready":…} / {"error":…})
//   --input
//        stdin:  one JSON command per line
import Foundation
import ScreenCaptureKit
import VideoToolbox
import CoreMedia
import IOKit.pwr_mgt

func emit(_ json: String) {
  FileHandle.standardError.write((json + "\n").data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
  emit("{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\"}}")
  exit(1)
}

// ── Aufnahme ────────────────────────────────────────────────────────────
final class Capture: NSObject, SCStreamOutput {
  private var session: VTCompressionSession?
  private var stream: SCStream?
  private let out = FileHandle.standardOutput
  private var wantKeyframe = false
  var assertion: IOPMAssertionID = 0

  // ScreenCaptureKit liefert aenderungsgetrieben: bei stillem Bildschirm kommen
  // nur ~6 Bilder pro Sekunde, manchmal sekundenlang keins. Wer dann eine Sitzung
  // oeffnet, sieht nichts, bis sich etwas ruehrt. Deshalb wird der zuletzt
  // aufgenommene Puffer nachgeschlagen — gemessen in Aufgabe 1.
  private var lastPixelBuffer: CVPixelBuffer?
  private var lastFrameAt = Date.distantPast
  private var heartbeat: Timer?

  func start(maxWidth: Int, fps: Int, bitrateKbps: Int) async {
    // Den Bildschirm wachhalten, SOLANGE die Sitzung laeuft. Ein schlafendes
    // Display meldet ScreenCaptureKit als "gar kein Bildschirm" — der Fernzugriff
    // zeigte sonst genau dann nichts, wenn der Rechner unbeaufsichtigt steht.
    // Die Assertion endet mit dem Prozess, also mit der Sitzung.
    var sleepAssertion: IOPMAssertionID = 0
    // Die Konstante heisst in Swift `kIOPMAssertionTypeNoDisplaySleep` — die
    // laengere C-Schreibweise mit "…Assertion" am Ende gibt es hier nicht und
    // bricht die Uebersetzung. Vorab gegen swiftc 6.3.1 geprueft.
    IOPMAssertionCreateWithName(
      kIOPMAssertionTypeNoDisplaySleep as CFString,
      IOPMAssertionLevel(kIOPMAssertionLevelOn),
      "TMS Terminal Fernzugriff" as CFString,
      &sleepAssertion)
    self.assertion = sleepAssertion

    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      fail("permission_screen", "Bildschirmaufnahme ist nicht freigegeben")
    }
    guard let display = content.displays.first else {
      // Nicht als Berechtigungsproblem melden: der Haken ist gesetzt, das
      // Display schlief nur. (Im Wegwerf-Test von Aufgabe 1 genau so passiert.)
      fail("display_asleep", "Der Bildschirm ist eingeschlafen und wacht gerade auf")
    }

    // ScreenCaptureKit liefert Pixel; die logische Aufloesung braucht die App
    // fuer die Zeigerkoordinaten. Der Faktor ist ihr Verhaeltnis.
    let mode = CGDisplayCopyDisplayMode(display.displayID)
    let scale = mode.map { Double(display.width) / Double($0.width) } ?? 1.0

    let width = min(maxWidth, display.width)
    let height = Int((Double(display.height) * Double(width) / Double(display.width)).rounded(.down)) & ~1

    let cfg = SCStreamConfiguration()
    cfg.width = width
    cfg.height = height
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    cfg.showsCursor = true
    cfg.queueDepth = 3

    VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height),
      codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
      imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &session)
    guard let s = session else { fail("capture_unavailable", "VideoToolbox nicht verfuegbar") }

    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
                         value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         value: NSNumber(value: fps * 2))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate,
                         value: NSNumber(value: bitrateKbps * 1000))
    VTCompressionSessionPrepareToEncodeFrames(s)

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
    do {
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "tms.capture"))
      try await stream.startCapture()
    } catch {
      fail("permission_screen", "Aufnahme konnte nicht gestartet werden")
    }
    self.stream = stream

    emit("{\"ready\":{\"width\":\(width),\"height\":\(height),\"scale\":\(scale)}}")
    startHeartbeat()
    listenForCommands(session: s)
  }

  /// stdin carries live adjustments while capturing: `keyframe`, `bitrate <kbps>`.
  private func listenForCommands(session: VTCompressionSession) {
    DispatchQueue.global().async {
      while let line = readLine(strippingNewline: true) {
        if line == "keyframe" {
          self.wantKeyframe = true
        } else if line.hasPrefix("bitrate ") {
          let kbps = Int(line.dropFirst(8)) ?? 0
          if kbps > 0 {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
                                 value: NSNumber(value: kbps * 1000))
          }
        } else if line == "quit" {
          exit(0)
        }
      }
    }
  }

  func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, CMSampleBufferIsValid(buf),
          let px = CMSampleBufferGetImageBuffer(buf) else { return }
    lastPixelBuffer = px
    lastFrameAt = Date()
    encode(px, forceKey: consumeKeyframeWish())
  }

  private func consumeKeyframeWish() -> Bool {
    guard wantKeyframe else { return false }
    wantKeyframe = false
    return true
  }

  private func encode(_ px: CVPixelBuffer, forceKey: Bool) {
    guard let sess = session else { return }
    let props: CFDictionary? = forceKey
      ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
      : nil
    VTCompressionSessionEncodeFrame(
      sess, imageBuffer: px,
      presentationTimeStamp: CMTime(value: Int64(Date().timeIntervalSince1970 * 1000), timescale: 1000),
      duration: .invalid, frameProperties: props, infoFlagsOut: nil
    ) { [weak self] status, _, sample in
      guard let self, status == noErr, let sample else { return }
      self.writeAnnexB(sample)
    }
  }

  /// Schlaegt das letzte Bild nach, wenn der Bildschirm still steht: ein
  /// angefordertes Vollbild darf nicht auf die naechste Mausbewegung warten.
  private func startHeartbeat() {
    heartbeat = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      guard let self, let px = self.lastPixelBuffer else { return }
      let still = Date().timeIntervalSince(self.lastFrameAt)
      if self.wantKeyframe && still > 0.1 {
        self.wantKeyframe = false
        self.encode(px, forceKey: true)
        self.lastFrameAt = Date()
      } else if still > 1.0 {
        self.encode(px, forceKey: false)
        self.lastFrameAt = Date()
      }
    }
  }

  /// VideoToolbox hands out length-prefixed NALs; the wire format is Annex-B.
  /// Parameter sets are repeated before every keyframe so the app can join the
  /// stream at any point without extra negotiation.
  private func writeAnnexB(_ sample: CMSampleBuffer) {
    let startCode = Data([0, 0, 0, 1])
    var payload = Data()

    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
    if !notSync, let fmt = CMSampleBufferGetFormatDescription(sample) {
      for i in 0..<2 {
        var ptr: UnsafePointer<UInt8>? = nil
        var size = 0
        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
             fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
             parameterSetSizeOut: &size, parameterSetCountOut: nil,
             nalUnitHeaderLengthOut: nil) == noErr, let p = ptr {
          payload.append(startCode)
          payload.append(Data(bytes: p, count: size))
        }
      }
    }

    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    var length = 0
    var raw: UnsafeMutablePointer<Int8>? = nil
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                      totalLengthOut: &length, dataPointerOut: &raw) == noErr,
          let base = raw else { return }

    var offset = 0
    while offset < length - 4 {
      var nalLength: UInt32 = 0
      memcpy(&nalLength, base + offset, 4)
      nalLength = CFSwapInt32BigToHost(nalLength)
      payload.append(startCode)
      payload.append(Data(bytes: base + offset + 4, count: Int(nalLength)))
      offset += 4 + Int(nalLength)
    }

    out.write(payload)
  }
}

// ── Einstieg ────────────────────────────────────────────────────────────
let args = CommandLine.arguments
func intArg(_ name: String, _ fallback: Int) -> Int {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return fallback }
  return Int(args[i + 1]) ?? fallback
}

if args.contains("--capture") {
  let c = Capture()
  Task {
    await c.start(maxWidth: intArg("--max-width", 1600),
                  fps: intArg("--fps", 30),
                  bitrateKbps: intArg("--bitrate", 1500))
  }
  RunLoop.main.run()
} else if args.contains("--input") {
  runInputLoop()          // Aufgabe 7
} else {
  fail("capture_unavailable", "Betriebsart fehlt: --capture oder --input")
}
```

**Wichtig:** Bis Aufgabe 7 existiert `runInputLoop()` noch nicht. Damit dieser Schritt übersetzbar bleibt, vorerst diese Zeile ans Dateiende setzen und in Aufgabe 7 durch die echte Fassung ersetzen:

```swift
func runInputLoop() { fail("capture_unavailable", "Eingabe folgt in Aufgabe 7") }
```

- [ ] **Step 4: Bauskript schreiben**

`server/src/remote/helpers/mac/build.sh`:

```bash
#!/usr/bin/env bash
# Uebersetzt den Fernzugriffs-Helfer. Laeuft beim Einrichten und ist gutmuetig:
# schlaegt es fehl, funktioniert alles ausser dem Fernzugriff weiterhin.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(cd ../../../.. && pwd)/bin/tms-remote-helper"
mkdir -p "$(dirname "$OUT")"
swiftc -O -framework ScreenCaptureKit -framework VideoToolbox -framework CoreGraphics \
       -framework IOKit \
       -o "$OUT" TmsRemoteHelper.swift
echo "Helfer gebaut: $OUT"
```

```bash
chmod +x ~/Desktop/tms-terminal/server/src/remote/helpers/mac/build.sh
cd ~/Desktop/tms-terminal/server && ./src/remote/helpers/mac/build.sh
```

Erwartet: `Helfer gebaut: …/server/bin/tms-remote-helper`.

- [ ] **Step 5: `capture.darwin.ts` schreiben**

```ts
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';

const KNOWN_CODES: RemoteErrorCode[] = [
  'permission_screen', 'permission_input', 'capture_unavailable',
  'helper_crashed', 'disabled', 'unsupported_platform', 'display_asleep',
];

/** `server/bin/tms-remote-helper`, next to the compiled output. */
export function helperBinaryPath(): string {
  return path.resolve(__dirname, '../../../bin/tms-remote-helper');
}

export function buildHelperArgs(opts: CaptureOptions): string[] {
  return [
    '--capture',
    '--max-width', String(opts.maxWidth),
    '--fps', String(opts.fps),
    '--bitrate', String(opts.bitrateKbps),
  ];
}

export type HelperLine =
  | { kind: 'ready'; info: CaptureInfo }
  | { kind: 'error'; code: RemoteErrorCode; message: string };

/** The helper writes one JSON object per stderr line; everything else is noise. */
export function parseHelperLine(line: string): HelperLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: any;
  try { obj = JSON.parse(trimmed); } catch { return null; }

  if (obj.ready && typeof obj.ready.width === 'number') {
    return {
      kind: 'ready',
      info: {
        width: obj.ready.width,
        height: obj.ready.height,
        scale: obj.ready.scale > 0 ? obj.ready.scale : 1,
      },
    };
  }
  if (obj.error && typeof obj.error.code === 'string') {
    const code = KNOWN_CODES.includes(obj.error.code) ? obj.error.code : 'capture_unavailable';
    return { kind: 'error', code, message: String(obj.error.message ?? '') };
  }
  return null;
}

export function createDarwinCapture(): ScreenCapture {
  let child: ChildProcess | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  // Ohne dieses Merkmal meldet das planmaessige Beenden sich als Absturz — und
  // die Neustart-Logik aus Aufgabe 18 startet die gerade beendete Sitzung wieder.
  let stopping = false;

  return {
    start(opts) {
      return new Promise<CaptureInfo>((resolve, reject) => {
        const proc = spawn(helperBinaryPath(), buildHelperArgs(opts), { stdio: ['pipe', 'pipe', 'pipe'] });
        child = proc;
        let settled = false;
        let stderrTail = '';

        proc.stdout.on('data', (b: Buffer) => onData(b));

        proc.stderr.on('data', (b: Buffer) => {
          stderrTail = (stderrTail + b.toString()).slice(-4096);
          for (const line of b.toString().split('\n')) {
            const evt = parseHelperLine(line);
            if (!evt) continue;
            if (evt.kind === 'ready' && !settled) { settled = true; resolve(evt.info); }
            else if (evt.kind === 'error') {
              if (!settled) { settled = true; reject(new Error(evt.message)); }
              else onError(evt.code, evt.message);
            }
          }
        });

        proc.on('exit', (code) => {
          child = null;
          if (stopping) return;                      // planmaessig beendet
          if (!settled) {
            settled = true;
            reject(new Error(`Helfer beendet (${code}): ${stderrTail.slice(-200)}`));
          } else {
            onError('helper_crashed', `Helfer beendet (${code})`);
          }
        });

        proc.on('error', (e) => {
          if (!settled) { settled = true; reject(e); }
        });
      });
    },

    onData(cb) { onData = cb; },
    onError(cb) { onError = cb; },
    requestKeyframe() { child?.stdin?.write('keyframe\n'); },
    setBitrate(kbps) { child?.stdin?.write(`bitrate ${Math.round(kbps)}\n`); },

    async stop() {
      const proc = child;
      stopping = true;
      child = null;
      if (!proc) return;
      proc.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 500);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
```

- [ ] **Step 6: In die Plattform-Auswahl eintragen**

`server/src/remote/capture/index.ts`:

```ts
import { getPlatform } from '../../utils/platform';
import type { ScreenCapture } from './capture.types';
import { createDarwinCapture } from './capture.darwin';

export function createScreenCapture(): ScreenCapture {
  switch (getPlatform()) {
    case 'darwin':
      return createDarwinCapture();
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/capture/capture.darwin.test.ts
```

Erwartet: `# pass 6`, `# fail 0`.

- [ ] **Step 8: Den Helfer beim Einrichten mitbauen**

In `server/src/setup.ts` am Ende des Einrichtungsablaufs ergänzen — gutmütig, damit ein fehlender Swift-Compiler nicht die ganze Einrichtung kippt:

```ts
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** Builds the macOS remote helper. Failing here costs remote access, nothing else. */
function buildRemoteHelper(): void {
  if (process.platform !== 'darwin') return;
  const script = path.resolve(__dirname, 'remote/helpers/mac/build.sh');
  try {
    execFileSync('bash', [script], { stdio: 'inherit' });
  } catch {
    console.warn(
      'Fernzugriffs-Helfer konnte nicht gebaut werden. Der Server laeuft normal weiter;\n' +
      'fuer den Fernzugriff spaeter nachholen mit:\n' +
      `  bash ${script}`,
    );
  }
}
```

Den Aufruf `buildRemoteHelper();` in den Einrichtungsablauf einhängen.

- [ ] **Step 9: Am echten Bildschirm nachweisen**

```bash
cd ~/Desktop/tms-terminal/server
timeout 3 ./bin/tms-remote-helper --capture --max-width 1280 --fps 30 --bitrate 800 > /tmp/tms-cap.h264 2>/tmp/tms-cap.log
echo "Bytes: $(wc -c < /tmp/tms-cap.h264)"; cat /tmp/tms-cap.log
```

Erwartet: eine `{"ready":…}`-Zeile mit plausiblen Maßen und **deutlich mehr als 0 Bytes** Video. Bei `{"error":{"code":"permission_screen"…}}` in *Systemeinstellungen → Datenschutz & Sicherheit → Bildschirmaufnahme* das Terminal freigeben und wiederholen.

- [ ] **Step 10: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote server/src/setup.ts
git commit -m "feat(remote): macOS-Bildschirmaufnahme ueber ScreenCaptureKit"
```

---

### Task 7: Tastenzuordnung und macOS-Eingabe

Die App schickt `KeyboardEvent.code` — also die **Position** der Taste, nicht das Zeichen. Beide Betriebssysteme wollen ihre eigenen Zahlencodes. Diese Übersetzung ist reine Nachschlagerei und wird hier für beide Plattformen auf einmal erledigt, damit Aufgabe 9 sie nur noch benutzt.

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/keymap.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/keymap.test.ts`
- Create: `~/Desktop/tms-terminal/server/src/remote/input/input.darwin.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/input/input.darwin.test.ts`
- Modify: `~/Desktop/tms-terminal/server/src/remote/helpers/mac/TmsRemoteHelper.swift` (`runInputLoop` ersetzen)
- Modify: `~/Desktop/tms-terminal/server/src/remote/input/index.ts`

**Interfaces:**
- Consumes: `InputInjector`, `Mods` (Aufgabe 5) · `helperBinaryPath()` (Aufgabe 6)
- Produces:
  ```ts
  export function toMacKeyCode(code: string): number | null;
  export function toWinVirtualKey(code: string): number | null;
  export function toHelperLine(ev: RemoteInputEvent, scale: number): string | null;
  export function createDarwinInput(): InputInjector;
  ```
  Aufgabe 9 benutzt `toWinVirtualKey`, Aufgabe 10 reicht `RemoteInputEvent` herein.

- [ ] **Step 1: Write the failing test für die Tastenzuordnung**

`server/src/remote/keymap.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMacKeyCode, toWinVirtualKey } from './keymap';

test('Buchstaben liegen auf den richtigen macOS-Codes', () => {
  assert.equal(toMacKeyCode('KeyA'), 0);
  assert.equal(toMacKeyCode('KeyZ'), 6, 'auf ANSI-Tastaturen liegt Z nicht bei Y');
  assert.equal(toMacKeyCode('KeyQ'), 12);
});

test('Sondertasten und Pfeile stimmen auf macOS', () => {
  assert.equal(toMacKeyCode('Enter'), 36);
  assert.equal(toMacKeyCode('Backspace'), 51);
  assert.equal(toMacKeyCode('Tab'), 48);
  assert.equal(toMacKeyCode('Escape'), 53);
  assert.equal(toMacKeyCode('Space'), 49);
  assert.equal(toMacKeyCode('ArrowLeft'), 123);
  assert.equal(toMacKeyCode('ArrowUp'), 126);
});

test('Windows bekommt seine virtuellen Tastencodes', () => {
  assert.equal(toWinVirtualKey('KeyA'), 0x41);
  assert.equal(toWinVirtualKey('Digit7'), 0x37);
  assert.equal(toWinVirtualKey('Enter'), 0x0d);
  assert.equal(toWinVirtualKey('ArrowDown'), 0x28);
  assert.equal(toWinVirtualKey('F5'), 0x74);
});

test('unbekannte Tasten liefern null statt einer falschen Taste', () => {
  assert.equal(toMacKeyCode('Kaugummi'), null);
  assert.equal(toWinVirtualKey(''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/keymap.test.ts
```

Erwartet: FAIL — `Cannot find module './keymap'`.

- [ ] **Step 3: `keymap.ts` schreiben**

```ts
/**
 * DOM KeyboardEvent.code → platform key codes.
 *
 * The app sends the key's *position*, never its character: the target system
 * applies its own layout. Sending characters would make a German keyboard on the
 * phone type Y where the Mac expects Z.
 */
const MAC: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23,
  Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29,
  BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35,
  Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42,
  Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49,
  Backquote: 50, Backspace: 51, Escape: 53,
  MetaLeft: 55, MetaRight: 55, ShiftLeft: 56, ShiftRight: 56, CapsLock: 57,
  AltLeft: 58, AltRight: 58, ControlLeft: 59, ControlRight: 59,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,
  Home: 115, PageUp: 116, Delete: 117, End: 119, PageDown: 121,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

const WIN_NAMED: Record<string, number> = {
  Enter: 0x0d, Backspace: 0x08, Tab: 0x09, Escape: 0x1b, Space: 0x20,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5b, MetaRight: 0x5c, CapsLock: 0x14,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Delete: 0x2e, Insert: 0x2d,
  Minus: 0xbd, Equal: 0xbb, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
  Semicolon: 0xba, Quote: 0xde, BracketLeft: 0xdb, BracketRight: 0xdd,
  Backslash: 0xdc, Backquote: 0xc0,
};

export function toMacKeyCode(code: string): number | null {
  return code in MAC ? MAC[code] : null;
}

export function toWinVirtualKey(code: string): number | null {
  if (!code) return null;
  if (code in WIN_NAMED) return WIN_NAMED[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].charCodeAt(0);            // 'A' = 0x41
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return 0x30 + Number(digit[1]);
  const fkey = /^F([1-9]|1[0-2])$/.exec(code);
  if (fkey) return 0x6f + Number(fkey[1]);               // F1 = 0x70
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/keymap.test.ts
```

Erwartet: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Write the failing test für die macOS-Eingabe**

`server/src/remote/input/input.darwin.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHelperLine } from './input.darwin';

const mods = { s: false, c: false, a: false, m: false };

test('relative Bewegung wird in logische Punkte umgerechnet', () => {
  assert.equal(toHelperLine({ t: 'd', dx: 20, dy: -10 }, 2), 'rel 10 -5',
    'auf Retina sind Bildpixel doppelt so fein wie Zeigerpunkte');
  assert.equal(toHelperLine({ t: 'd', dx: 20, dy: -10 }, 1), 'rel 20 -10');
});

test('absolute Bewegung bleibt normiert', () => {
  assert.equal(toHelperLine({ t: 'm', x: 0.25, y: 0.5 }, 2), 'abs 0.25 0.5');
  assert.equal(toHelperLine({ t: 'm', x: -3, y: 9 }, 1), 'abs 0 1', 'Ausreisser werden gekappt');
});

test('Maustasten und Scrollen', () => {
  assert.equal(toHelperLine({ t: 'b', b: 'r', d: true }, 1), 'btn r 1');
  assert.equal(toHelperLine({ t: 'b', b: 'l', d: false }, 1), 'btn l 0');
  assert.equal(toHelperLine({ t: 's', dx: 0, dy: -3 }, 1), 'scroll 0 -3');
});

test('Tasten werden mit Zahlencode und Zustandsflags gesendet', () => {
  assert.equal(toHelperLine({ t: 'k', c: 'KeyA', d: true, mods }, 1), 'key 0 1 0');
  assert.equal(
    toHelperLine({ t: 'k', c: 'KeyC', d: true, mods: { s: false, c: false, a: false, m: true } }, 1),
    'key 8 1 8', 'Befehlstaste setzt Bit 8');
});

test('unbekannte Tasten und Unfug ergeben keine Zeile', () => {
  assert.equal(toHelperLine({ t: 'k', c: 'Kaugummi', d: true, mods }, 1), null);
  assert.equal(toHelperLine({ t: 'zz' } as any, 1), null);
});

test('Text wird als eine Zeile mit maskierten Zeilenumbruechen gesendet', () => {
  assert.equal(toHelperLine({ t: 'x', s: 'Hallo Welt' }, 1), 'text Hallo Welt');
  assert.equal(toHelperLine({ t: 'x', s: 'a\nb' }, 1), 'text a\\nb',
    'ein echter Umbruch wuerde die Zeilenstruktur des Protokolls sprengen');
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/input/input.darwin.test.ts
```

Erwartet: FAIL — `Cannot find module './input.darwin'`.

- [ ] **Step 7: `input.darwin.ts` schreiben**

```ts
import { spawn, ChildProcess } from 'node:child_process';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector, Mods } from './input.types';
import { helperBinaryPath } from '../capture/capture.darwin';
import { toMacKeyCode } from '../keymap';
import { clamp01 } from '../geometry';

/** Modifier bit field shared with the Swift side. */
const SHIFT = 1, CONTROL = 2, OPTION = 4, COMMAND = 8;

function modBits(m: Mods): number {
  return (m.s ? SHIFT : 0) | (m.c ? CONTROL : 0) | (m.a ? OPTION : 0) | (m.m ? COMMAND : 0);
}

/**
 * One remote input event → one helper command line, or null if it makes no sense.
 *
 * `scale` matters for relative motion only: the app computes deltas in captured
 * pixels, while CGEvent moves the pointer in logical points.
 */
export function toHelperLine(ev: RemoteInputEvent, scale: number): string | null {
  const s = scale > 0 ? scale : 1;
  switch (ev?.t) {
    case 'd':
      return `rel ${Math.round(ev.dx / s)} ${Math.round(ev.dy / s)}`;
    case 'm':
      return `abs ${clamp01(ev.x)} ${clamp01(ev.y)}`;
    case 'b':
      return `btn ${ev.b} ${ev.d ? 1 : 0}`;
    case 's':
      return `scroll ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'k': {
      const code = toMacKeyCode(ev.c);
      return code === null ? null : `key ${code} ${ev.d ? 1 : 0} ${modBits(ev.mods)}`;
    }
    case 'x':
      return `text ${ev.s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`;
    default:
      return null;
  }
}

export function createDarwinInput(): InputInjector {
  let child: ChildProcess | null = spawn(helperBinaryPath(), ['--input'], { stdio: ['pipe', 'ignore', 'pipe'] });
  child.on('exit', () => { child = null; });

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };

  return {
    moveRelative: (dx, dy) => write(`rel ${Math.round(dx)} ${Math.round(dy)}`),
    moveAbsolute: (nx, ny) => write(`abs ${clamp01(nx)} ${clamp01(ny)}`),
    button: (which, down) => write(`btn ${which[0]} ${down ? 1 : 0}`),
    scroll: (dx, dy) => write(`scroll ${Math.round(dx)} ${Math.round(dy)}`),
    key: (code, down, mods) => write(
      toMacKeyCode(code) === null ? null : `key ${toMacKeyCode(code)} ${down ? 1 : 0} ${modBits(mods)}`),
    text: (s) => write(`text ${s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`),

    async stop() {
      const proc = child;
      child = null;
      if (!proc) return;
      proc.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 300);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
```

- [ ] **Step 8: Die Eingabeschleife im Swift-Helfer ersetzen**

In `TmsRemoteHelper.swift` die Platzhalterzeile aus Aufgabe 6 löschen und stattdessen einsetzen:

```swift
// ── Eingabe ─────────────────────────────────────────────────────────────
import CoreGraphics

private let SHIFT = 1, CONTROL = 2, OPTION = 4, COMMAND = 8

private func flags(_ bits: Int) -> CGEventFlags {
  var f = CGEventFlags()
  if bits & SHIFT   != 0 { f.insert(.maskShift) }
  if bits & CONTROL != 0 { f.insert(.maskControl) }
  if bits & OPTION  != 0 { f.insert(.maskAlternate) }
  if bits & COMMAND != 0 { f.insert(.maskCommand) }
  return f
}

private func currentPoint() -> CGPoint {
  CGEvent(source: nil)?.location ?? .zero
}

private func warp(to p: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

func runInputLoop() {
  // Without the Accessibility grant every event below is silently swallowed —
  // report that instead of pretending to work.
  if !AXIsProcessTrusted() {
    fail("permission_input", "Bedienungshilfen sind nicht freigegeben")
  }
  emit("{\"ready\":{\"input\":true}}")

  let screen = CGDisplayBounds(CGMainDisplayID())

  while let line = readLine(strippingNewline: true) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    guard let cmd = parts.first else { continue }
    let rest = parts.count > 1 ? parts[1] : ""
    let nums = rest.split(separator: " ").map { Double($0) ?? 0 }

    switch cmd {
    case "rel":
      let p = currentPoint()
      warp(to: CGPoint(x: min(max(p.x + (nums.first ?? 0), screen.minX), screen.maxX - 1),
                       y: min(max(p.y + (nums.count > 1 ? nums[1] : 0), screen.minY), screen.maxY - 1)))
    case "abs":
      warp(to: CGPoint(x: screen.minX + (nums.first ?? 0) * screen.width,
                       y: screen.minY + (nums.count > 1 ? nums[1] : 0) * screen.height))
    case "btn":
      let which = rest.first ?? "l"
      let down = rest.hasSuffix("1")
      let button: CGMouseButton = which == "r" ? .right : which == "m" ? .center : .left
      let type: CGEventType = which == "r"
        ? (down ? .rightMouseDown : .rightMouseUp)
        : which == "m" ? (down ? .otherMouseDown : .otherMouseUp)
        : (down ? .leftMouseDown : .leftMouseUp)
      CGEvent(mouseEventSource: nil, mouseType: type,
              mouseCursorPosition: currentPoint(), mouseButton: button)?
        .post(tap: .cghidEventTap)
    case "scroll":
      CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
              wheel1: Int32(nums.count > 1 ? nums[1] : 0),
              wheel2: Int32(nums.first ?? 0), wheel3: 0)?
        .post(tap: .cghidEventTap)
    case "key":
      guard nums.count >= 3 else { break }
      let ev = CGEvent(keyboardEventSource: nil,
                       virtualKey: CGKeyCode(nums[0]), keyDown: nums[1] == 1)
      ev?.flags = flags(Int(nums[2]))
      ev?.post(tap: .cghidEventTap)
    case "text":
      let text = rest.replacingOccurrences(of: "\\n", with: "\n")
                     .replacingOccurrences(of: "\\\\", with: "\\")
      // Unicode direkt einspeisen: unabhaengig von der Tastaturbelegung des Macs.
      for chunk in text.unicodeScalars.map({ UniChar($0.value) }) {
        var c = chunk
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
        up?.post(tap: .cghidEventTap)
      }
    case "quit":
      exit(0)
    default:
      break
    }
  }
}
```

Neu übersetzen:

```bash
cd ~/Desktop/tms-terminal/server && ./src/remote/helpers/mac/build.sh
```

- [ ] **Step 9: In die Plattform-Auswahl eintragen**

`server/src/remote/input/index.ts`:

```ts
import { getPlatform } from '../../utils/platform';
import type { InputInjector } from './input.types';
import { createDarwinInput } from './input.darwin';

export function createInputInjector(): InputInjector {
  switch (getPlatform()) {
    case 'darwin':
      return createDarwinInput();
    default:
      throw new Error('Fernzugriff wird auf dieser Plattform nicht unterstuetzt.');
  }
}
```

- [ ] **Step 10: Run tests to verify they pass**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit && npm test
```

Erwartet: alles grün.

- [ ] **Step 11: Von Hand nachweisen, dass sich der Zeiger bewegt**

```bash
cd ~/Desktop/tms-terminal/server
printf 'abs 0.5 0.5\nrel 100 0\nquit\n' | ./bin/tms-remote-helper --input
```

Erwartet: der Mauszeiger springt in die Bildschirmmitte und dann 100 Punkte nach rechts. Kommt `{"error":{"code":"permission_input"…}}`, in *Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen* die Datei `server/bin/tms-remote-helper` freigeben.

- [ ] **Step 12: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote
git commit -m "feat(remote): Tastenzuordnung und macOS-Eingabe ueber CGEvent"
```

---

### Task 8: Windows — Aufnahme über ffmpeg und `ddagrab`

**Hinweis zur Prüfbarkeit:** Ohne erreichbare Windows-Maschine bleibt diese Aufgabe bei den reinen Anteilen getestet (Argumentbau, Encoder-Wahl, Fehlererkennung). Schritt 8 ist der Nachweis am echten Gerät und wird ausdrücklich als offen vermerkt, wenn er nicht ausgeführt werden kann.

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/capture/capture.win32.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/capture/capture.win32.test.ts`
- Modify: `~/Desktop/tms-terminal/server/src/remote/capture/index.ts`

**Interfaces:**
- Consumes: `ScreenCapture`, `CaptureOptions`, `CaptureInfo` (Aufgabe 5)
- Produces:
  ```ts
  export const ENCODER_PREFERENCE: readonly string[];
  export function pickEncoder(available: string[]): string | null;
  export function buildFfmpegArgs(opts: CaptureOptions, encoder: string): string[];
  export function parseCaptureSize(stderrLine: string): { width: number; height: number } | null;
  export function createWin32Capture(): ScreenCapture;
  ```

- [ ] **Step 1: Write the failing test**

`server/src/remote/capture/capture.win32.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEncoder, buildFfmpegArgs, parseCaptureSize, ENCODER_PREFERENCE } from './capture.win32';

test('die Grafikkarte wird der Rechenleistung vorgezogen', () => {
  assert.equal(pickEncoder(['libx264', 'h264_qsv', 'h264_nvenc']), 'h264_nvenc');
  assert.equal(pickEncoder(['libx264', 'h264_amf']), 'h264_amf');
  assert.equal(pickEncoder(['libx264']), 'libx264', 'zur Not rechnet der Prozessor');
  assert.equal(pickEncoder(['h264_videotoolbox']), null, 'nichts Brauchbares vorhanden');
});

test('die Reihenfolge steht fest und endet beim Prozessor', () => {
  assert.deepEqual([...ENCODER_PREFERENCE],
    ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
});

test('buildFfmpegArgs nimmt den Desktop und liefert rohes H.264', () => {
  const args = buildFfmpegArgs({ maxWidth: 1600, fps: 30, bitrateKbps: 1500 }, 'h264_nvenc');
  const joined = args.join(' ');

  assert.ok(joined.includes('ddagrab=output_idx=0:framerate=30'), 'Desktop-Duplication mit Bildrate');
  assert.ok(joined.includes('scale=1600:-2'), 'Breite begrenzt, Hoehe gerade');
  assert.ok(joined.includes('-c:v h264_nvenc'));
  assert.ok(joined.includes('-b:v 1500k'));
  assert.ok(joined.includes('-g 60'), 'alle zwei Sekunden ein Vollbild');
  assert.ok(joined.includes('-slices 1'), 'ein Slice pro Bild — sonst greift der Zerteiler daneben');
  assert.ok(joined.includes('-bsf:v dump_extra'), 'SPS/PPS vor jedem Vollbild wiederholen');
  assert.ok(joined.endsWith('-f h264 pipe:1'));
});

test('libx264 bekommt seine eigene Einstellung fuer niedrige Verzoegerung', () => {
  const joined = buildFfmpegArgs({ maxWidth: 1280, fps: 24, bitrateKbps: 800 }, 'libx264').join(' ');
  assert.ok(joined.includes('-tune zerolatency'));
  assert.ok(!joined.includes('-preset p1'), 'p1 ist eine nvenc-Stufe und wuerde libx264 abbrechen lassen');
});

test('parseCaptureSize liest die Masse aus der ffmpeg-Ausgabe', () => {
  const line = 'Stream #0:0: Video: wrapped_avframe, bgra, 2560x1440, 30 fps, 30 tbr';
  assert.deepEqual(parseCaptureSize(line), { width: 2560, height: 1440 });
  assert.equal(parseCaptureSize('irgendwas ohne Masse'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/capture/capture.win32.test.ts
```

Erwartet: FAIL — `Cannot find module './capture.win32'`.

- [ ] **Step 3: Write minimal implementation**

`server/src/remote/capture/capture.win32.ts`:

```ts
import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import type { RemoteErrorCode } from '../../../../shared/protocol';
import type { ScreenCapture, CaptureOptions, CaptureInfo } from './capture.types';

/** GPU encoders first — ddagrab already hands us frames on the graphics card. */
export const ENCODER_PREFERENCE = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as const;

export function pickEncoder(available: string[]): string | null {
  return ENCODER_PREFERENCE.find((e) => available.includes(e)) ?? null;
}

export function buildFfmpegArgs(opts: CaptureOptions, encoder: string): string[] {
  const quality = encoder === 'libx264'
    ? ['-preset', 'veryfast', '-tune', 'zerolatency']
    : ['-preset', 'p1', '-tune', 'll'];

  return [
    '-hide_banner', '-loglevel', 'info',
    '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${opts.fps}`,
    '-vf', `hwdownload,format=bgra,scale=${opts.maxWidth}:-2,format=nv12`,
    '-c:v', encoder,
    ...quality,
    '-b:v', `${opts.bitrateKbps}k`,
    '-g', String(opts.fps * 2),
    '-slices', '1',
    '-bsf:v', 'dump_extra',
    '-f', 'h264', 'pipe:1',
  ];
}

/** ffmpeg reports the real desktop size on stderr; we need it for the pointer maths. */
export function parseCaptureSize(stderrLine: string): { width: number; height: number } | null {
  const m = /,\s(\d{3,5})x(\d{3,5})[,\s]/.exec(stderrLine);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function availableEncoders(): string[] {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return ENCODER_PREFERENCE.filter((e) => out.includes(e));
  } catch {
    return [];
  }
}

export function createWin32Capture(): ScreenCapture {
  let child: ChildProcess | null = null;
  let onData: (b: Buffer) => void = () => {};
  let onError: (c: RemoteErrorCode, m: string) => void = () => {};
  // Wie auf dem Mac: planmaessiges Beenden darf nicht als Absturz durchgehen,
  // sonst startet die Neustart-Logik aus Aufgabe 18 die beendete Sitzung neu.
  let stopping = false;

  return {
    start(opts) {
      return new Promise<CaptureInfo>((resolve, reject) => {
        const encoder = pickEncoder(availableEncoders());
        if (!encoder) {
          reject(new Error(
            'ffmpeg mit H.264-Encoder nicht gefunden. Einmalig einrichten mit:  winget install ffmpeg'));
          return;
        }

        const proc = spawn('ffmpeg', buildFfmpegArgs(opts, encoder), { stdio: ['ignore', 'pipe', 'pipe'] });
        child = proc;
        let settled = false;
        let tail = '';

        proc.stdout.on('data', (b: Buffer) => onData(b));

        proc.stderr.on('data', (b: Buffer) => {
          const text = b.toString();
          tail = (tail + text).slice(-4096);
          if (settled) return;
          for (const line of text.split('\n')) {
            const size = parseCaptureSize(line);
            if (!size) continue;
            settled = true;
            // ddagrab captures physical pixels and Windows reports them as such,
            // so there is no Retina-style factor to undo here.
            resolve({ width: Math.min(opts.maxWidth, size.width), height: size.height, scale: 1 });
            return;
          }
        });

        proc.on('exit', (code) => {
          child = null;
          if (stopping) return;                      // planmaessig beendet
          if (!settled) { settled = true; reject(new Error(`ffmpeg beendet (${code}): ${tail.slice(-200)}`)); }
          else onError('helper_crashed', `ffmpeg beendet (${code})`);
        });

        proc.on('error', () => {
          if (!settled) {
            settled = true;
            reject(new Error('ffmpeg nicht gefunden. Einmalig einrichten mit:  winget install ffmpeg'));
          }
        });
      });
    },

    onData(cb) { onData = cb; },
    onError(cb) { onError = cb; },

    // ffmpeg kann im laufenden Betrieb weder Vollbild noch Bitrate umstellen —
    // beides steckt in den Startargumenten. Aufgabe 10 startet dafuer neu.
    requestKeyframe() { /* absichtlich leer: siehe Kommentar */ },
    setBitrate() { /* absichtlich leer: siehe Kommentar */ },

    async stop() {
      const proc = child;
      stopping = true;
      child = null;
      if (!proc) return;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 500);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/capture/capture.win32.test.ts
```

Erwartet: `# pass 5`, `# fail 0`.

- [ ] **Step 5: In die Plattform-Auswahl eintragen**

In `server/src/remote/capture/index.ts` den zweiten Fall ergänzen:

```ts
import { createWin32Capture } from './capture.win32';
// …
    case 'win32':
      return createWin32Capture();
```

- [ ] **Step 6: Übersetzung und Gesamtlauf**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit && npm test
```

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote/capture
git commit -m "feat(remote): Windows-Bildschirmaufnahme ueber ffmpeg/ddagrab"
```

- [ ] **Step 8: Nachweis am echten Windows-Rechner** *(nur mit Zugriff auf eine Windows-Maschine)*

```powershell
ffmpeg -hide_banner -f lavfi -i ddagrab=output_idx=0:framerate=30 `
  -vf "hwdownload,format=bgra,scale=1280:-2,format=nv12" `
  -c:v h264_nvenc -preset p1 -tune ll -b:v 800k -g 60 -slices 1 -bsf:v dump_extra `
  -t 3 -f h264 test.h264
```

Erwartet: `test.h264` deutlich größer als 0 Byte. Schlägt `ddagrab` fehl, ist ffmpeg zu alt (nötig ist Version 6 oder neuer) — dann `winget upgrade ffmpeg`.

**Kann dieser Schritt nicht ausgeführt werden, im Commit-Text und gegenüber dem Nutzer ausdrücklich festhalten, dass die Windows-Aufnahme ungetestet ausgeliefert wird.**

---

### Task 9: Windows — Eingabe über `SendInput`

Ohne Installation: Windows PowerShell übersetzt beim Start das mitgelieferte C# und ruft danach direkt `SendInput` auf. Ein Prozess pro Ereignis wäre 50–100 ms teuer, deshalb bleibt er dauerhaft am Leben und liest Befehle von der Standardeingabe.

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/helpers/win/input-helper.ps1`
- Create: `~/Desktop/tms-terminal/server/src/remote/input/input.win32.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/input/input.win32.test.ts`
- Modify: `~/Desktop/tms-terminal/server/src/remote/input/index.ts`

**Interfaces:**
- Consumes: `InputInjector`, `Mods` (Aufgabe 5) · `toWinVirtualKey` (Aufgabe 7) · `toWindowsAbsolute`, `clamp01` (Aufgabe 4)
- Produces:
  ```ts
  export function toWinLine(ev: RemoteInputEvent): string | null;
  export function createWin32Input(): InputInjector;
  ```

- [ ] **Step 1: Write the failing test**

`server/src/remote/input/input.win32.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWinLine } from './input.win32';

const mods = { s: false, c: false, a: false, m: false };

test('absolute Bewegung wird auf den Windows-Bereich 0..65535 gespreizt', () => {
  assert.equal(toWinLine({ t: 'm', x: 0.5, y: 0.5 }), 'abs 32768 32768');
  assert.equal(toWinLine({ t: 'm', x: 0, y: 1 }), 'abs 0 65535');
});

test('relative Bewegung geht in Pixeln durch — Windows kennt keine Punkte', () => {
  assert.equal(toWinLine({ t: 'd', dx: 12, dy: -4 }), 'rel 12 -4');
});

test('Maustasten und Rad', () => {
  assert.equal(toWinLine({ t: 'b', b: 'l', d: true }), 'btn l 1');
  assert.equal(toWinLine({ t: 'b', b: 'm', d: false }), 'btn m 0');
  assert.equal(toWinLine({ t: 's', dx: 0, dy: -3 }), 'scroll 0 -3');
});

test('Tasten kommen als virtueller Tastencode', () => {
  assert.equal(toWinLine({ t: 'k', c: 'KeyA', d: true, mods }), 'key 65 1');
  assert.equal(toWinLine({ t: 'k', c: 'F5', d: false, mods }), 'key 116 0');
  assert.equal(toWinLine({ t: 'k', c: 'Kaugummi', d: true, mods }), null);
});

test('Sondertasten reisen als eigene Ereignisse, nicht als Flags', () => {
  assert.equal(toWinLine({ t: 'k', c: 'ShiftLeft', d: true, mods }), 'key 16 1',
    'SendInput kennt keine Zustandsflags — die App schickt Druecken und Loslassen selbst');
});

test('Text wird zeilensicher gesendet', () => {
  assert.equal(toWinLine({ t: 'x', s: 'Hallo' }), 'text Hallo');
  assert.equal(toWinLine({ t: 'x', s: 'a\nb' }), 'text a\\nb');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/input/input.win32.test.ts
```

Erwartet: FAIL — `Cannot find module './input.win32'`.

- [ ] **Step 3: `input.win32.ts` schreiben**

```ts
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { RemoteInputEvent } from '../../../../shared/protocol';
import type { InputInjector } from './input.types';
import { toWinVirtualKey } from '../keymap';
import { toWindowsAbsolute } from '../geometry';

/**
 * One remote input event → one helper line.
 *
 * Unlike macOS, SendInput carries no modifier flag field: Shift and friends are
 * ordinary key events. The app already sends press and release for its sticky
 * modifiers, so nothing extra is needed here.
 */
export function toWinLine(ev: RemoteInputEvent): string | null {
  switch (ev?.t) {
    case 'm': {
      const p = toWindowsAbsolute(ev.x, ev.y);
      return `abs ${p.x} ${p.y}`;
    }
    case 'd':
      return `rel ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'b':
      return `btn ${ev.b} ${ev.d ? 1 : 0}`;
    case 's':
      return `scroll ${Math.round(ev.dx)} ${Math.round(ev.dy)}`;
    case 'k': {
      const vk = toWinVirtualKey(ev.c);
      return vk === null ? null : `key ${vk} ${ev.d ? 1 : 0}`;
    }
    case 'x':
      return `text ${ev.s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`;
    default:
      return null;
  }
}

function helperScriptPath(): string {
  return path.resolve(__dirname, '../helpers/win/input-helper.ps1');
}

export function createWin32Input(): InputInjector {
  let child: ChildProcess | null = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperScriptPath()],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  child.on('exit', () => { child = null; });

  const write = (line: string | null) => {
    if (line && child?.stdin?.writable) child.stdin.write(line + '\n');
  };
  const send = (ev: RemoteInputEvent) => write(toWinLine(ev));

  return {
    moveRelative: (dx, dy) => send({ t: 'd', dx, dy }),
    moveAbsolute: (nx, ny) => send({ t: 'm', x: nx, y: ny }),
    button: (which, down) => send({ t: 'b', b: which[0] as 'l' | 'r' | 'm', d: down }),
    scroll: (dx, dy) => send({ t: 's', dx, dy }),
    key: (code, down, mods) => send({ t: 'k', c: code, d: down, mods }),
    text: (s) => send({ t: 'x', s }),

    async stop() {
      const proc = child;
      child = null;
      if (!proc) return;
      proc.stdin?.write('quit\n');
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { proc.kill(); resolve(); }, 300);
        proc.on('exit', () => { clearTimeout(kill); resolve(); });
      });
    },
  };
}
```

- [ ] **Step 4: Das PowerShell-Helferskript schreiben**

`server/src/remote/helpers/win/input-helper.ps1`:

```powershell
# TMS Terminal — Eingabe-Helfer fuer Windows.
#
# Bleibt am Leben und liest Befehle von der Standardeingabe: ein Prozessstart je
# Tastendruck wuerde 50-100 ms kosten und die ganze Verzoegerungsrechnung kippen.
# Add-Type uebersetzt das C# einmal beim Start mit Bordmitteln — nichts zu installieren.

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TmsInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mi;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  const uint MOUSE = 0, KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;

  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }

  public static void MoveAbsolute(int x, int y) {
    INPUT i = new INPUT(); i.type = MOUSE;
    i.mi.dx = x; i.mi.dy = y; i.mi.dwFlags = MOVE | ABSOLUTE; Send(i);
  }
  public static void MoveRelative(int dx, int dy) {
    INPUT i = new INPUT(); i.type = MOUSE;
    i.mi.dx = dx; i.mi.dy = dy; i.mi.dwFlags = MOVE; Send(i);
  }
  public static void Button(string which, bool down) {
    INPUT i = new INPUT(); i.type = MOUSE;
    if (which == "r") i.mi.dwFlags = down ? RDOWN : RUP;
    else if (which == "m") i.mi.dwFlags = down ? MDOWN : MUP;
    else i.mi.dwFlags = down ? LDOWN : LUP;
    Send(i);
  }
  public static void Scroll(int dx, int dy) {
    if (dy != 0) { INPUT i = new INPUT(); i.type = MOUSE;
      i.mi.mouseData = unchecked((uint)(dy * 120)); i.mi.dwFlags = WHEEL; Send(i); }
    if (dx != 0) { INPUT i = new INPUT(); i.type = MOUSE;
      i.mi.mouseData = unchecked((uint)(dx * 120)); i.mi.dwFlags = HWHEEL; Send(i); }
  }
  public static void Key(ushort vk, bool down) {
    INPUT i = new INPUT(); i.type = KEYBOARD;
    i.ki.wVk = vk; i.ki.dwFlags = down ? 0 : KEYUP; Send(i);
  }
  // Unicode direkt: unabhaengig von der Tastaturbelegung des Zielrechners.
  public static void Text(string s) {
    foreach (char c in s) {
      INPUT d = new INPUT(); d.type = KEYBOARD; d.ki.wScan = c; d.ki.dwFlags = UNICODE; Send(d);
      INPUT u = new INPUT(); u.type = KEYBOARD; u.ki.wScan = c; u.ki.dwFlags = UNICODE | KEYUP; Send(u);
    }
  }
}
"@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ', 2)
  $cmd = $parts[0]
  $rest = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  $n = $rest.Split(' ')

  switch ($cmd) {
    'abs'    { [TmsInput]::MoveAbsolute([int]$n[0], [int]$n[1]) }
    'rel'    { [TmsInput]::MoveRelative([int]$n[0], [int]$n[1]) }
    'btn'    { [TmsInput]::Button($n[0], $n[1] -eq '1') }
    'scroll' { [TmsInput]::Scroll([int]$n[0], [int]$n[1]) }
    'key'    { [TmsInput]::Key([uint16]$n[0], $n[1] -eq '1') }
    'text'   { [TmsInput]::Text($rest.Replace('\n', "`n").Replace('\\', '\')) }
    'quit'   { exit 0 }
  }
}
```

- [ ] **Step 5: In die Plattform-Auswahl eintragen**

In `server/src/remote/input/index.ts`:

```ts
import { createWin32Input } from './input.win32';
// …
    case 'win32':
      return createWin32Input();
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit && npm test
```

Erwartet: alles grün, darunter `# pass 6` aus `input.win32.test.ts`.

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote
git commit -m "feat(remote): Windows-Eingabe ueber SendInput"
```

- [ ] **Step 8: Nachweis am echten Windows-Rechner** *(nur mit Zugriff)*

```powershell
"abs 32768 32768", "rel 200 0", "quit" | powershell -NoProfile -ExecutionPolicy Bypass -File .\input-helper.ps1
```

Erwartet: der Zeiger springt in die Bildschirmmitte und dann nach rechts. **Ohne Zugriff ausdrücklich als ungetestet vermerken.**

---

### Task 10: Die Sitzung verdrahten — Bild raus, Eingaben rein

Jetzt fließen zum ersten Mal echte Bilder. Zerteiler, Rückstau-Regelung und Eingabe-Weiterleitung hängen sich an den Endpunkt aus Aufgabe 5.

**Files:**
- Modify: `~/Desktop/tms-terminal/server/src/remote/remote.socket.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/remote.socket.test.ts` (erweitern)

**Interfaces:**
- Consumes: `createAnnexBSplitter` (2) · `createBitrateGovernor` (3) · `ScreenCapture`, `InputInjector` (5) · `RemoteInputEvent` (5)
- Produces:
  ```ts
  export function packAccessUnit(au: AccessUnit, tsMs: number): Buffer;
  ```

- [ ] **Step 1: Write the failing test**

Ans Ende von `server/src/remote/remote.socket.test.ts` anfügen (die Hilfsklassen aus Aufgabe 5 werden weiterverwendet):

```ts
import { packAccessUnit } from './remote.socket';

test('packAccessUnit setzt Kennzeichen und Zeitstempel in den Kopf', () => {
  const nutzdaten = Buffer.from([9, 9, 9]);
  const voll = packAccessUnit({ data: nutzdaten, keyframe: true }, 1000);
  assert.equal(voll[0], 0x81, 'Typ 1 mit gesetztem Vollbild-Bit');
  assert.equal(voll.readUInt32BE(1), 1000);
  assert.deepEqual(voll.subarray(5), nutzdaten);

  const zwischen = packAccessUnit({ data: nutzdaten, keyframe: false }, 66);
  assert.equal(zwischen[0], 0x01, 'ohne Vollbild-Bit');
  assert.equal(zwischen.readUInt32BE(1), 66);
});

test('Bilddaten gehen unkomprimiert als Binaerframe raus', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  ws.sent.length = 0;

  // Ein Vollbild, gefolgt vom Anfang des naechsten Bildes (das erst den Abschluss ausloest).
  const nal = (t: number) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x60 | t]), Buffer.alloc(4, 0xaa)]);
  capture.dataCb(Buffer.concat([nal(7), nal(8), nal(5)]));
  capture.dataCb(nal(1));

  const binaer = ws.sent.filter((m) => Buffer.isBuffer(m));
  assert.equal(binaer.length, 1, 'genau eine fertige Access Unit');
  assert.equal(binaer[0][0], 0x81, 'als Vollbild gekennzeichnet');
});

test('bei vollem Sendepuffer fallen Zwischenbilder weg, Vollbilder nicht', async () => {
  const { ws, capture } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));
  ws.sent.length = 0;
  ws.bufferedAmount = 900 * 1024;                       // ueber der Verwurfsschwelle

  const nal = (t: number) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x60 | t]), Buffer.alloc(4, 0xaa)]);
  capture.dataCb(Buffer.concat([nal(1), nal(1)]));       // zwei Zwischenbilder
  assert.equal(ws.sent.filter((m) => Buffer.isBuffer(m)).length, 0, 'Zwischenbilder verworfen');

  capture.dataCb(Buffer.concat([nal(7), nal(8), nal(5), nal(1)]));
  assert.ok(ws.sent.filter((m) => Buffer.isBuffer(m)).length >= 1, 'das Vollbild kommt durch');
});

test('Eingabe-Ereignisse landen beim Injektor', async () => {
  const { ws, input } = wire();
  send(ws, { type: 'remote:start', payload: QUALITY_PRESETS.auto });
  await new Promise((r) => setImmediate(r));

  send(ws, { t: 'd', dx: 10, dy: -4 });
  send(ws, { t: 'b', b: 'r', d: true });
  send(ws, { t: 's', dx: 0, dy: -3 });
  send(ws, { t: 'k', c: 'KeyA', d: true, mods: { s: false, c: false, a: false, m: true } });
  send(ws, { t: 'x', s: 'Hallo' });
  send(ws, { t: 'm', x: 0.5, y: 0.25 });

  assert.deepEqual(input.calls, [
    'rel 10 -4', 'btn right true', 'scroll 0 -3', 'key KeyA true', 'text Hallo', 'abs 0.5 0.25',
  ]);
});

test('Eingaben ohne laufende Sitzung werden verworfen', () => {
  const { ws, input } = wire();
  send(ws, { t: 'd', dx: 10, dy: 10 });
  assert.deepEqual(input.calls, [], 'ohne Aufnahme gibt es nichts zu steuern');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/remote.socket.test.ts
```

Erwartet: FAIL — `packAccessUnit` ist kein Export.

- [ ] **Step 3: `remote.socket.ts` erweitern**

Zusätzliche Importe:

```ts
import { createAnnexBSplitter, type AccessUnit } from './annexb';
import { createBitrateGovernor } from './bitrate';
import type { RemoteInputEvent } from '../../../shared/protocol';
```

Die Paketierung als exportierte reine Funktion:

```ts
/**
 * Wire format for one frame:
 *   byte 0    0x01 = video access unit, bit 0x80 = keyframe
 *   byte 1-4  milliseconds since session start (uint32 BE)
 *   byte 5..  H.264 Annex-B payload
 */
export function packAccessUnit(au: AccessUnit, tsMs: number): Buffer {
  const head = Buffer.alloc(5);
  head[0] = 0x01 | (au.keyframe ? 0x80 : 0);
  head.writeUInt32BE(Math.max(0, Math.floor(tsMs)) >>> 0, 1);
  return Buffer.concat([head, au.data]);
}
```

In `handleRemoteConnection` den Sitzungszustand ergänzen:

```ts
  let splitter: ReturnType<typeof createAnnexBSplitter> | null = null;
  let governor: ReturnType<typeof createBitrateGovernor> | null = null;
  let startedAt = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let framesSent = 0;
  let bytesSent = 0;
  let dropped = 0;
```

In `stop()` vor dem Anhalten der Helfer aufräumen:

```ts
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    splitter = null;
    governor = null;
```

In `start()` nach dem erfolgreichen `c.start(opts)` und **vor** dem `remote:started`:

```ts
      splitter = createAnnexBSplitter();
      governor = createBitrateGovernor(opts.bitrateKbps);
      startedAt = Date.now();
      framesSent = 0; bytesSent = 0; dropped = 0;

      const emit = (units: AccessUnit[]) => {
        for (const au of units) {
          if (!governor || ws.readyState !== 1) return;
          const decision = governor.decide(au, ws.bufferedAmount, Date.now());
          if (decision.bitrateKbps !== null) capture?.setBitrate(decision.bitrateKbps);
          if (!decision.send) { dropped++; continue; }
          const frame = packAccessUnit(au, Date.now() - startedAt);
          // Schon komprimiert — ein zweiter Durchgang kostet nur Rechenzeit.
          ws.send(frame, { compress: false });
          framesSent++;
          bytesSent += frame.length;
        }
      };

      c.onData((chunk) => { if (splitter) emit(splitter.push(chunk, Date.now())); });

      // Ein Bild endet erst am naechsten Startcode; ohne diesen Taktgeber haenge
      // jedes Bild bis zum uebernaechsten fest (33 ms Verzoegerung bei 30 fps).
      idleTimer = setInterval(() => { if (splitter) emit(splitter.tick(Date.now())); }, 4);
      idleTimer.unref();

      statusTimer = setInterval(() => {
        reply({
          type: 'remote:status',
          payload: {
            fps: framesSent,
            kbps: Math.round((bytesSent * 8) / 1000),
            rttMs: 0,
            dropped,
          },
        });
        framesSent = 0; bytesSent = 0; dropped = 0;
      }, 1000);
      statusTimer.unref();
```

Im `message`-Zweig die Eingabe-Ereignisse abfangen, **bevor** auf `type` geschaltet wird:

```ts
    // Eingabe-Ereignisse tragen `t` statt `type` — kurze Schluessel, weil bei
    // Zeigerbewegung bis zu 60 Nachrichten pro Sekunde anfallen.
    if (typeof (msg as any).t === 'string') {
      if (input) applyInput(input, msg as unknown as RemoteInputEvent);
      return;
    }
```

Und die Zuordnung als eigene Funktion im Modul:

```ts
function applyInput(input: InputInjector, ev: RemoteInputEvent): void {
  switch (ev.t) {
    case 'd': input.moveRelative(ev.dx, ev.dy); break;
    case 'm': input.moveAbsolute(ev.x, ev.y); break;
    case 'b': input.button(ev.b === 'r' ? 'right' : ev.b === 'm' ? 'middle' : 'left', ev.d); break;
    case 's': input.scroll(ev.dx, ev.dy); break;
    case 'k': input.key(ev.c, ev.d, ev.mods); break;
    case 'x': input.text(ev.s); break;
    default: break;
  }
}
```

Die Prüfung `if (!msg || typeof (msg as any).type !== 'string') return;` muss **nach** dem Eingabe-Zweig stehen, sonst verwirft sie die Eingaben.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/remote.socket.test.ts
```

Erwartet: `# pass 14`, `# fail 0`.

- [ ] **Step 5: Gesamtlauf**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit && npm test
```

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/tms-terminal
git add server/src/remote
git commit -m "feat(remote): Bildstrom und Eingabe-Weiterleitung verdrahtet"
```

**Bekannte Einschränkung, die hier festgehalten wird:** ffmpeg kann Bitrate und Vollbild nicht im laufenden Betrieb umstellen — auf Windows sind `setBitrate` und `requestKeyframe` wirkungslos. Das Verwerfen von Zwischenbildern bei Rückstau greift trotzdem. Wechselt der Nutzer die Qualitätsstufe, schickt die App deshalb `remote:stop` gefolgt von `remote:start` (siehe Aufgabe 14), statt sich auf `remote:quality` zu verlassen.

---

### Task 11: Mockup — der Fernzugriffs-Bildschirm (Layout C)

Ab hier wird im Mockup gearbeitet: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` auf Zweig `master`. Der Mockup bleibt die Quelle für Aussehen und Gesten; `liquidDeckHtml.ts` wird **nie** von Hand angefasst.

Im Mobile-Teil gibt es keinen Testlauf. Die reinen Rechenfunktionen des Mockups bekommen deshalb einen eigenen: ein Node-Test schneidet einen markierten Block aus der HTML-Datei heraus und prüft ihn. Das erhält die Ein-Datei-Architektur und liefert trotzdem echte Tests.

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
- Create: `~/Desktop/tms-terminal/mobile/scripts/remote-logic.test.mjs`
- Modify: `~/Desktop/tms-terminal/mobile/package.json` (Testlauf ergänzen)

**Interfaces:**
- Consumes: nichts
- Produces (im Mockup, global auf `window`):
  ```js
  window.buildRemoteScreen()   // baut den Bildschirm einmalig auf
  window.remoteState           // { running, w, h, scale, page: 'pad'|'keys', fullscreen }
  ```
  Aufgabe 12 bis 15 hängen sich daran.

- [ ] **Step 1: Den Testlauf für Mockup-Logik anlegen**

`mobile/package.json` um ein Skript ergänzen:

```json
    "test:mockup": "node --test scripts/*.test.mjs"
```

`mobile/scripts/remote-logic.test.mjs`:

```js
/**
 * Prueft die reinen Rechenfunktionen des Mockups.
 *
 * Der Mockup ist bewusst eine einzige HTML-Datei — deshalb schneidet dieser Test
 * den markierten Block heraus und wertet ihn aus, statt die Architektur fuer die
 * Testbarkeit aufzubrechen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MOCKUP = '/Users/ayysir/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html';

function loadBlock(name) {
  const html = fs.readFileSync(MOCKUP, 'utf8');
  const re = new RegExp(`// ── TMS-TEST-EXPORT: ${name} ──([\\s\\S]*?)// ── /TMS-TEST-EXPORT ──`);
  const m = re.exec(html);
  assert.ok(m, `Block "${name}" fehlt im Mockup — Markierungen nicht entfernen`);
  return new Function(`${m[1]}; return { pointerGain, nextSticky, fitRect };`)();
}

test('der markierte Block laesst sich laden', () => {
  const api = loadBlock('remoteMath');
  assert.equal(typeof api.pointerGain, 'function');
  assert.equal(typeof api.nextSticky, 'function');
  assert.equal(typeof api.fitRect, 'function');
});

test('fitRect legt das Bild seitenrichtig in die Flaeche', () => {
  const { fitRect } = loadBlock('remoteMath');
  // Breites Bild in hohe Flaeche: links und rechts voll, oben/unten Rand.
  assert.deepEqual(fitRect(1600, 1000, 400, 800), { x: 0, y: 275, w: 400, h: 250 });
  // Genau passendes Seitenverhaeltnis: kein Rand.
  assert.deepEqual(fitRect(1600, 800, 400, 200), { x: 0, y: 0, w: 400, h: 200 });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: FAIL — `Block "remoteMath" fehlt im Mockup`.

- [ ] **Step 3: Den Rechenblock in den Mockup einsetzen**

Im `<script>`-Teil des Mockups, in der Nähe der übrigen Hilfsfunktionen (etwa bei `function clamp(v, lo, hi)`), einfügen:

```js
  // ── TMS-TEST-EXPORT: remoteMath ──
  // Reine Rechnerei fuer den Fernzugriff. Wird von mobile/scripts/remote-logic.test.mjs
  // aus dieser Datei herausgeschnitten und geprueft — die Markierungen bitte lassen.

  /**
   * Beschleunigungskurve fuer das Trackpad.
   *
   * Der Finger hat auf der Leiste ~300 Punkte Weg, der Mac-Bildschirm 1512 Pixel
   * Breite. Fest uebersetzt hiesse das entweder "ein Wisch reicht nicht ueber den
   * Bildschirm" oder "ein Pixel genau treffen ist unmoeglich". Die Kurve macht die
   * Uebersetzung von der Wischgeschwindigkeit abhaengig — genau wie macOS und
   * Windows es fuer echte Maeuse tun.
   */
  function pointerGain(speedPxPerMs) {
    var s = Math.abs(speedPxPerMs);
    if (!isFinite(s) || s <= 0) return 1;
    if (s < 0.15) return 1;                       // langsam: pixelgenau
    if (s > 3) return 4;                          // schnell: quer ueber den Schirm
    return 1 + ((s - 0.15) / (3 - 0.15)) * 3;     // dazwischen linear
  }

  /**
   * Haftende Sondertasten: einmal tippen haelt bis zum naechsten Anschlag,
   * zweimal stellt fest, dreimal loest wieder.
   * Ohne das waere Befehlstaste+Tab einhaendig nicht tippbar.
   */
  function nextSticky(state) {
    return state === 'off' ? 'once' : state === 'once' ? 'locked' : 'off';
  }

  /** Legt ein w×h grosses Bild seitenrichtig in eine Flaeche und zentriert es. */
  function fitRect(imgW, imgH, boxW, boxH) {
    var scale = Math.min(boxW / imgW, boxH / imgH);
    var w = Math.round(imgW * scale);
    var h = Math.round(imgH * scale);
    return { x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), w: w, h: h };
  }

  // Der gesamte Mockup-Code steckt in einer Kapsel — ohne diese Zeilen sieht
  // bridge.js keine einzige dieser Funktionen, und der Fernzugriff bricht mit
  // "fitRect is not defined" ab, waehrend die Tests weiter gruen melden (sie
  // werten den Block einzeln aus). Die Abfrage haelt den Block in Node lauffaehig.
  if (typeof window !== 'undefined') {
    window.pointerGain = pointerGain;
    window.nextSticky = nextSticky;
    window.fitRect = fitRect;
  }
  // ── /TMS-TEST-EXPORT ──
```

**Diese Ausfuhr-Zeilen sind Pflicht.** Jede spätere Aufgabe, die den Block erweitert, trägt ihre neue Funktion dort mit ein.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: `# pass 2`, `# fail 0`.

- [ ] **Step 5: Den Bildschirm im Mockup anlegen**

In der Liste der Bildschirme (`<div id="screens">`, um Zeile 1780) hinter `data-screen="files"` ergänzen:

```html
      <section class="screen" data-screen="remote"></section>
```

Und den Aufbau als Funktion, in der Nähe von `renderServers()`:

```js
  // ============================================================
  // Fernzugriff — Bild oben, darunter eine umschaltbare Leiste
  // ============================================================
  window.remoteState = { running: false, w: 0, h: 0, scale: 1, page: 'pad', fullscreen: false };

  function buildRemoteScreen() {
    var host = document.querySelector('[data-screen="remote"]');
    host.innerHTML = ''
      + '<div class="remote-head glass">'
      +   '<span class="remote-dot" id="remoteDot"></span>'
      +   '<span class="remote-name" id="remoteName">Fernzugriff</span>'
      +   '<span class="remote-stat" id="remoteStat">verbinde …</span>'
      +   '<button class="icon-btn glass" id="remoteFull" aria-label="Vollbild">⤢</button>'
      +   '<button class="icon-btn glass" id="remoteQuit" aria-label="Trennen">✕</button>'
      + '</div>'
      + '<div class="remote-stage" id="remoteStage"><canvas id="remoteCanvas"></canvas>'
      +   '<div class="remote-veil" id="remoteVeil"><span id="remoteVeilText">Verbinde …</span></div>'
      + '</div>'
      + '<div class="remote-seg" id="remoteSeg">'
      +   '<button data-page="pad" class="on">Trackpad</button>'
      +   '<button data-page="keys">Tastatur</button>'
      + '</div>'
      + '<div class="remote-bar" id="remoteBar"></div>';

    host.querySelector('#remoteSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-page]');
      if (btn) setRemotePage(btn.dataset.page);
    });
    host.querySelector('#remoteQuit').addEventListener('click', function () {
      if (window.TMSRemote) window.TMSRemote.stop();
      show('servers');
    });
    setRemotePage('pad');
  }

  function setRemotePage(page) {
    window.remoteState.page = page;
    document.querySelectorAll('#remoteSeg [data-page]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.page === page);
    });
    var bar = document.getElementById('remoteBar');
    bar.innerHTML = page === 'pad' ? remotePadMarkup() : remoteKeysMarkup();
    if (page === 'pad') wireRemotePad(); else wireRemoteKeys();
  }

  // Bis Aufgabe 12/13 stehen hier nur die Flaechen — Gesten und Tasten folgen dort.
  function remotePadMarkup() {
    return '<div class="remote-pad" id="remotePad">'
      + '<span class="remote-pad-hint">Wischen bewegt den Zeiger<br>Tippen klickt · zwei Finger scrollen</span>'
      + '<div class="remote-pad-btns"><button data-btn="l">Linksklick</button>'
      + '<button data-btn="r">Rechtsklick</button></div></div>';
  }
  function remoteKeysMarkup() { return '<div class="remote-keys" id="remoteKeys"></div>'; }
  function wireRemotePad() {}
  function wireRemoteKeys() {}

  // bridge.js baut den Bildschirm auf, sieht aber nicht in diese Kapsel hinein.
  window.buildRemoteScreen = buildRemoteScreen;
```

`buildRemoteScreen()` beim Wechsel auf den Bildschirm aufrufen — in `handleDockTap`/`show()` dort, wo die anderen Bildschirme ihren Aufbau bekommen.

- [ ] **Step 6: Die Gestaltung ergänzen**

Im `<style>`-Teil, bei den übrigen Bildschirm-Regeln:

```css
  [data-screen="remote"] { display: flex; flex-direction: column; gap: 8px; height: 100%; padding: 8px; }
  .remote-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 14px; }
  .remote-dot { width: 7px; height: 7px; border-radius: 50%; background: #34c759; flex: none; }
  .remote-dot[data-state="off"] { background: #8a8a8e; }
  .remote-name { font-weight: 600; font-size: 13px; }
  .remote-stat { margin-left: auto; font-size: 10px; opacity: .6; font-variant-numeric: tabular-nums; }
  .remote-stage { position: relative; background: #05080d; border-radius: 14px; overflow: hidden; flex: none; }
  .remote-stage canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
  .remote-veil { position: absolute; inset: 0; display: grid; place-items: center;
                 background: rgba(5,8,13,.72); font-size: 12px; opacity: 0; transition: opacity .2s; }
  .remote-veil[data-show="1"] { opacity: 1; }
  .remote-seg { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: rgba(255,255,255,.07); }
  .remote-seg button { flex: 1; padding: 7px 0; border: 0; border-radius: 9px; background: transparent;
                       color: inherit; opacity: .55; font-size: 12px; font-weight: 600; }
  .remote-seg button.on { background: rgba(90,169,255,.22); opacity: 1;
                          box-shadow: inset 0 0 0 1px rgba(90,169,255,.45); }
  .remote-bar { flex: 1; min-height: 0; }
  .remote-pad { position: relative; height: 100%; border-radius: 14px;
                background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.10);
                display: flex; flex-direction: column; touch-action: none; }
  .remote-pad-hint { position: absolute; inset: 0; display: grid; place-items: center;
                     text-align: center; font-size: 10px; opacity: .28; line-height: 1.7; pointer-events: none; }
  .remote-pad-btns { margin-top: auto; display: flex; gap: 6px; padding: 7px; }
  .remote-pad-btns button { flex: 1; padding: 11px 0; border-radius: 10px; font-size: 10px;
                            border: 1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.05);
                            color: inherit; opacity: .75; }

  /* Aufgeklappt ist die Breite da: groessere Tasten, mehr Luft. */
  @media (min-width: 700px) {
    [data-screen="remote"] { padding: 14px; gap: 12px; }
    .remote-name { font-size: 15px; }
    .remote-pad-btns button { padding: 15px 0; font-size: 12px; }
  }
```

Die Höhe der Bühne setzt Aufgabe 14, sobald die echten Bildmaße bekannt sind (`fitRect`).

- [ ] **Step 7: Layout headless prüfen**

Mit den Playwright-Werkzeugen (so wurden die bisherigen Season-2-Arbeiten geprüft):

1. `browser_resize` auf **412 × 915**, `browser_navigate` auf `file:///Users/ayysir/Desktop/TMS%20Terminal/mockups/season2/liquid-deck/index.html`
2. Über die Leiste zum Fernzugriffs-Bildschirm navigieren, `browser_take_screenshot`
3. Dasselbe bei **840 × 900**

Erwartet: Kopfzeile, Bühne, Umschaltleiste und Bedienfläche liegen untereinander, nichts läuft über den unteren Rand hinaus, nichts scrollt quer.

- [ ] **Step 8: Bauen und einchecken**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
cd ~/Desktop/TMS\ Terminal && git add mockups/season2/liquid-deck/index.html
git commit -m "feat(remote): Fernzugriffs-Bildschirm im Mockup (Layout C)"
cd ~/Desktop/tms-terminal && git add mobile/src/season2/web/liquidDeckHtml.ts mobile/package.json mobile/scripts/remote-logic.test.mjs
git commit -m "feat(remote): Fernzugriffs-Bildschirm gebaut, Mockup-Testlauf ergaenzt"
```

---

### Task 12: Mockup — Trackpad mit Gesten

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (`wireRemotePad`)
- Modify: `~/Desktop/tms-terminal/mobile/scripts/remote-logic.test.mjs`

**Interfaces:**
- Consumes: `pointerGain` (Aufgabe 11) · `window.TMSRemote.input(ev)` (Aufgabe 14, hier bereits benutzt)
- Produces: `wireRemotePad()` verdrahtet Zeiger-, Klick- und Scroll-Gesten

- [ ] **Step 1: Write the failing test**

An `mobile/scripts/remote-logic.test.mjs` anfügen:

```js
test('pointerGain bleibt bei langsamem Wischen bei 1:1', () => {
  const { pointerGain } = loadBlock('remoteMath');
  assert.equal(pointerGain(0), 1, 'Stillstand darf nicht verstaerken');
  assert.equal(pointerGain(0.05), 1, 'langsam heisst pixelgenau');
});

test('pointerGain verstaerkt schnelles Wischen, aber gedeckelt', () => {
  const { pointerGain } = loadBlock('remoteMath');
  assert.equal(pointerGain(10), 4, 'die Verstaerkung ist bei 4 gedeckelt');
  assert.ok(pointerGain(1) > 1 && pointerGain(1) < 4, 'dazwischen gleitend');
  assert.ok(pointerGain(2) > pointerGain(1), 'schneller heisst immer weiter');
});

test('pointerGain behandelt beide Richtungen gleich', () => {
  const { pointerGain } = loadBlock('remoteMath');
  assert.equal(pointerGain(-2), pointerGain(2));
});

test('nextSticky laeuft aus/einmal/fest im Kreis', () => {
  const { nextSticky } = loadBlock('remoteMath');
  assert.equal(nextSticky('off'), 'once');
  assert.equal(nextSticky('once'), 'locked');
  assert.equal(nextSticky('locked'), 'off');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: FAIL — `pointerGain(10)` liefert noch nicht 4, falls die Kurve aus Aufgabe 11 abweicht. Stimmen die Werte bereits, ist das in Ordnung: dann sichern die Tests das Verhalten ab, bevor die Gesten darauf aufbauen.

- [ ] **Step 3: `wireRemotePad` schreiben**

Die leere Fassung aus Aufgabe 11 ersetzen:

```js
  function wireRemotePad() {
    var pad = document.getElementById('remotePad');
    if (!pad) return;
    var R = function () { return window.TMSRemote; };

    var last = null;          // letzte Fingerposition
    var lastAt = 0;
    var moved = 0;            // zurueckgelegter Weg — trennt Tippen von Wischen
    var downAt = 0;
    var twoFinger = false;
    var dragging = false;
    var holdTimer = null;

    var TAP_SLOP = 10;        // Punkte, die ein "Tippen" wackeln darf
    var TAP_MS = 250;
    var HOLD_MS = 350;        // Halten leitet das Ziehen ein

    pad.addEventListener('pointerdown', function (e) {
      if (e.target.closest('[data-btn]')) return;
      pad.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      lastAt = e.timeStamp;
      moved = 0;
      downAt = e.timeStamp;
      twoFinger = e.isPrimary === false;
      holdTimer = setTimeout(function () {
        dragging = true;
        if (R()) R().input({ t: 'b', b: 'l', d: true });
      }, HOLD_MS);
    });

    pad.addEventListener('pointermove', function (e) {
      if (!last) return;
      var dx = e.clientX - last.x;
      var dy = e.clientY - last.y;
      var dt = Math.max(1, e.timeStamp - lastAt);
      last = { x: e.clientX, y: e.clientY };
      lastAt = e.timeStamp;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > TAP_SLOP && holdTimer) { clearTimeout(holdTimer); holdTimer = null; }

      var speed = Math.sqrt(dx * dx + dy * dy) / dt;
      var gain = pointerGain(speed);
      if (!R()) return;
      if (twoFinger) R().input({ t: 's', dx: Math.round(dx), dy: Math.round(dy) });
      else R().input({ t: 'd', dx: Math.round(dx * gain), dy: Math.round(dy * gain) });
    });

    function release(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      var quick = e.timeStamp - downAt < TAP_MS && moved <= TAP_SLOP;
      if (R()) {
        if (dragging) R().input({ t: 'b', b: 'l', d: false });
        else if (quick) {
          var b = twoFinger ? 'r' : 'l';   // zwei Finger tippen = Rechtsklick
          R().input({ t: 'b', b: b, d: true });
          R().input({ t: 'b', b: b, d: false });
        }
      }
      last = null; dragging = false; twoFinger = false;
    }

    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);

    // Die beiden festen Knoepfe: Ziehen und Rechtsklick ohne Fingerakrobatik.
    pad.querySelectorAll('[data-btn]').forEach(function (btn) {
      var which = btn.dataset.btn;
      btn.addEventListener('pointerdown', function () { if (R()) R().input({ t: 'b', b: which, d: true }); });
      btn.addEventListener('pointerup',   function () { if (R()) R().input({ t: 'b', b: which, d: false }); });
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Von Hand prüfen**

Mockup in Chrome öffnen, Entwicklerwerkzeuge, Geräteansicht 412 × 915. In der Konsole eine Attrappe setzen und über das Trackpad wischen:

```js
window.TMSRemote = { input: (e) => console.log(e), stop: () => {} };
```

Erwartet: langsames Wischen ergibt `t:'d'` mit kleinen Werten, schnelles mit deutlich größeren; kurzes Tippen ergibt ein Paar `t:'b'` mit `d:true` und `d:false`.

- [ ] **Step 6: Bauen und einchecken**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
cd ~/Desktop/TMS\ Terminal && git add mockups/season2/liquid-deck/index.html && git commit -m "feat(remote): Trackpad-Gesten mit Beschleunigungskurve"
cd ~/Desktop/tms-terminal && git add mobile/src/season2/web/liquidDeckHtml.ts mobile/scripts/remote-logic.test.mjs && git commit -m "feat(remote): Trackpad gebaut"
```

---

### Task 13: Mockup — Tastatur mit haftenden Sondertasten

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (`remoteKeysMarkup`, `wireRemoteKeys`, Gestaltung)
- Modify: `~/Desktop/tms-terminal/mobile/scripts/remote-logic.test.mjs`

**Interfaces:**
- Consumes: `nextSticky` (Aufgabe 11) · `window.TMSRemote.input(ev)` (Aufgabe 14)
- Produces:
  ```js
  window.remoteKeyRows(layer)   // 'base' | 'num' | 'fn'  → Array von Tastenreihen
  ```

- [ ] **Step 1: Write the failing test**

An `mobile/scripts/remote-logic.test.mjs` anfügen (und `remoteKeyRows` in `loadBlock` mit zurückgeben):

```js
test('die Grundebene ist eine deutsche Tastatur', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const codes = remoteKeyRows('base').flat().map((k) => k.c);

  assert.ok(codes.includes('KeyZ'), 'Z liegt auf der deutschen Tastatur oben');
  assert.ok(codes.includes('Semicolon'), 'Umlaut-Position oe');
  assert.ok(codes.includes('Enter'));
  assert.ok(codes.includes('Backspace'));
  assert.ok(codes.includes('Space'));
});

test('jede Sondertaste ist als haftend gekennzeichnet', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const alle = remoteKeyRows('base').flat();
  const cmd = alle.find((k) => k.c === 'MetaLeft');
  const a = alle.find((k) => k.c === 'KeyA');

  assert.equal(cmd.sticky, true, 'ohne haftende Befehlstaste ist Befehl+Tab nicht tippbar');
  assert.ok(!a.sticky, 'Buchstaben haften nicht');
});

test('die Funktionsebene bringt F1 bis F12', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  const codes = remoteKeyRows('fn').flat().map((k) => k.c);
  assert.ok(codes.includes('F1'));
  assert.ok(codes.includes('F12'));
});

test('jede Taste hat eine Beschriftung und einen Code', () => {
  const { remoteKeyRows } = loadBlock('remoteMath');
  for (const layer of ['base', 'num', 'fn']) {
    for (const key of remoteKeyRows(layer).flat()) {
      assert.ok(key.l && key.l.length > 0, `Beschriftung fehlt bei ${JSON.stringify(key)}`);
      assert.ok(key.c && key.c.length > 0, `Code fehlt bei ${key.l}`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: FAIL — `remoteKeyRows is not defined`.

- [ ] **Step 3: Die Tastenbelegung in den markierten Block aufnehmen**

Innerhalb von `// ── TMS-TEST-EXPORT: remoteMath ──` ergänzen und die `return`-Zeile im Test um `remoteKeyRows` erweitern:

```js
  /**
   * Die Tastenbelegung. `c` ist der KeyboardEvent.code — also die POSITION der
   * Taste; welches Zeichen dabei herauskommt, entscheidet der Zielrechner mit
   * seiner eigenen Belegung. Wuerden wir Zeichen schicken, tippte eine deutsche
   * Handytastatur auf einem englisch eingestellten Mac Y statt Z.
   */
  function remoteKeyRows(layer) {
    var mod = function (l, c) { return { l: l, c: c, sticky: true, m: true }; };
    var k = function (l, c, w) { return w ? { l: l, c: c, w: w } : { l: l, c: c }; };

    if (layer === 'fn') {
      return [
        [k('F1','F1'), k('F2','F2'), k('F3','F3'), k('F4','F4'), k('F5','F5'), k('F6','F6')],
        [k('F7','F7'), k('F8','F8'), k('F9','F9'), k('F10','F10'), k('F11','F11'), k('F12','F12')],
        [k('Pos1','Home'), k('Ende','End'), k('Bild ↑','PageUp'), k('Bild ↓','PageDown'), k('Entf','Delete')],
        [k('ABC','__layer:base', 1.5), k('␣','Space', 4), k('⏎','Enter', 1.5)],
      ];
    }
    if (layer === 'num') {
      return [
        [k('1','Digit1'), k('2','Digit2'), k('3','Digit3'), k('4','Digit4'), k('5','Digit5'),
         k('6','Digit6'), k('7','Digit7'), k('8','Digit8'), k('9','Digit9'), k('0','Digit0')],
        [k('-','Minus'), k('=','Equal'), k('[','BracketLeft'), k(']','BracketRight'),
         k('\\\\','Backslash'), k(';','Semicolon'), k('\\'','Quote'), k('`','Backquote')],
        [k(',','Comma'), k('.','Period'), k('/','Slash'), k('⌫','Backspace', 1.5)],
        [k('ABC','__layer:base', 1.5), k('␣','Space', 4), k('⏎','Enter', 1.5)],
      ];
    }
    return [
      [k('esc','Escape'), k('F…','__layer:fn'), mod('⌘','MetaLeft'), mod('⌥','AltLeft'),
       mod('ctrl','ControlLeft'), k('↹','Tab'), k('🎙','__mic')],
      [k('q','KeyQ'), k('w','KeyW'), k('e','KeyE'), k('r','KeyR'), k('t','KeyT'), k('z','KeyZ'),
       k('u','KeyU'), k('i','KeyI'), k('o','KeyO'), k('p','KeyP'), k('ü','BracketLeft')],
      [k('a','KeyA'), k('s','KeyS'), k('d','KeyD'), k('f','KeyF'), k('g','KeyG'), k('h','KeyH'),
       k('j','KeyJ'), k('k','KeyK'), k('l','KeyL'), k('ö','Semicolon'), k('ä','Quote')],
      [mod('⇧','ShiftLeft'), k('y','KeyY'), k('x','KeyX'), k('c','KeyC'), k('v','KeyV'),
       k('b','KeyB'), k('n','KeyN'), k('m','KeyM'), k('⌫','Backspace', 1.5)],
      [k('123','__layer:num'), k('␣','Space', 4), k('◀','ArrowLeft'), k('▶','ArrowRight'),
       k('⏎','Enter', 1.5)],
    ];
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: `# pass 10`, `# fail 0`.

- [ ] **Step 5: Die Tastatur zeichnen und verdrahten**

`remoteKeysMarkup` und `wireRemoteKeys` aus Aufgabe 11 ersetzen:

```js
  var remoteLayer = 'base';
  var remoteSticky = { MetaLeft: 'off', AltLeft: 'off', ControlLeft: 'off', ShiftLeft: 'off' };

  function remoteKeysMarkup() {
    var rows = remoteKeyRows(remoteLayer).map(function (row) {
      var keys = row.map(function (key) {
        var cls = 'rk' + (key.m ? ' mod' : '') + (remoteSticky[key.c] && remoteSticky[key.c] !== 'off'
          ? ' on' + (remoteSticky[key.c] === 'locked' ? ' locked' : '') : '');
        var style = key.w ? ' style="flex:' + key.w + '"' : '';
        return '<button class="' + cls + '" data-code="' + key.c + '"' + style + '>'
             + escapeHtml(key.l) + '</button>';
      }).join('');
      return '<div class="rk-row">' + keys + '</div>';
    }).join('');
    return '<div class="remote-keys" id="remoteKeys">' + rows + '</div>';
  }

  function currentMods() {
    return {
      s: remoteSticky.ShiftLeft !== 'off',
      c: remoteSticky.ControlLeft !== 'off',
      a: remoteSticky.AltLeft !== 'off',
      m: remoteSticky.MetaLeft !== 'off',
    };
  }

  /** Nach einem Anschlag fallen die einmal-Sondertasten zurueck, feste bleiben. */
  function releaseOnceModifiers() {
    var changed = false;
    Object.keys(remoteSticky).forEach(function (code) {
      if (remoteSticky[code] === 'once') {
        remoteSticky[code] = 'off';
        if (window.TMSRemote) window.TMSRemote.input({ t: 'k', c: code, d: false, mods: currentMods() });
        changed = true;
      }
    });
    if (changed) setRemotePage('keys');
  }

  function wireRemoteKeys() {
    var host = document.getElementById('remoteKeys');
    if (!host) return;

    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-code]');
      if (!btn) return;
      var code = btn.dataset.code;
      var R = window.TMSRemote;

      if (code.indexOf('__layer:') === 0) { remoteLayer = code.slice(8); setRemotePage('keys'); return; }
      if (code === '__mic') { if (R) R.dictate(); return; }

      if (code in remoteSticky) {
        var before = remoteSticky[code];
        remoteSticky[code] = nextSticky(before);
        if (R) R.input({ t: 'k', c: code, d: remoteSticky[code] !== 'off', mods: currentMods() });
        setRemotePage('keys');
        return;
      }

      if (R) {
        R.input({ t: 'k', c: code, d: true, mods: currentMods() });
        R.input({ t: 'k', c: code, d: false, mods: currentMods() });
      }
      releaseOnceModifiers();
    });
  }
```

- [ ] **Step 6: Gestaltung ergänzen**

```css
  .remote-keys { display: flex; flex-direction: column; gap: 4px; height: 100%; }
  .rk-row { display: flex; gap: 4px; flex: 1; }
  .rk { flex: 1; min-width: 0; border-radius: 7px; border: 1px solid rgba(255,255,255,.06);
        background: rgba(255,255,255,.09); color: inherit; font-size: 14px; padding: 0; }
  .rk:active { background: rgba(255,255,255,.20); }
  .rk.mod { background: rgba(255,255,255,.05); font-size: 11px; opacity: .8; }
  .rk.on { background: rgba(90,169,255,.28); opacity: 1;
           box-shadow: inset 0 0 0 1px rgba(90,169,255,.5); }
  .rk.locked { box-shadow: inset 0 0 0 2px rgba(90,169,255,.85); }
  @media (min-width: 700px) { .rk { font-size: 17px; } .rk.mod { font-size: 13px; } }
```

- [ ] **Step 7: Von Hand prüfen**

Mockup öffnen, Attrappe setzen (`window.TMSRemote = { input: console.log, dictate(){}, stop(){} }`), auf „Tastatur" wechseln.

Erwartet: ⌘ einmal tippen färbt sie ein, danach `a` tippen sendet `mods:{m:true}` und ⌘ fällt zurück. Zweimal ⌘ tippen stellt sie fest (dickerer Rahmen) und sie bleibt über mehrere Anschläge aktiv.

- [ ] **Step 8: Bauen und einchecken**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
cd ~/Desktop/TMS\ Terminal && git add mockups/season2/liquid-deck/index.html && git commit -m "feat(remote): Bildschirmtastatur mit haftenden Sondertasten"
cd ~/Desktop/tms-terminal && git add mobile/src/season2/web/liquidDeckHtml.ts mobile/scripts/remote-logic.test.mjs && git commit -m "feat(remote): Tastatur gebaut"
```

---

### Task 14: `bridge.js` — Verbindung, Dekoder, Bild

Hier wird zum ersten Mal ein echter Bildschirm sichtbar. Der Code lebt in `bridge.js`, nicht im Mockup: der Mockup bleibt für sich lauffähig, die Brücke macht daraus die App.

**Files:**
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js`

**Interfaces:**
- Consumes: Protokoll aus Aufgabe 5 und 10 · `remoteState`, `fitRect`, `buildRemoteScreen` (Aufgabe 11)
- Produces:
  ```js
  window.TMSRemote = { start(preset), stop(), input(ev), dictate(), setQuality(preset) }
  window.TMSBridge.setRemoteTarget({ host, port, token })   // von React Native
  ```

- [ ] **Step 1: Ziel-Angaben entgegennehmen**

Bei den übrigen `window.TMSBridge.set…`-Funktionen ergänzen:

```js
  // React Native reicht nur die Zugangsdaten durch — Bilddaten sieht es nie.
  var remoteTarget = null;
  window.TMSBridge.setRemoteTarget = function (t) { remoteTarget = t; };
```

- [ ] **Step 2: Die Fernzugriffs-Brücke schreiben**

Ans Ende von `bridge.js` (vor einem etwaigen Abschluss-Aufruf):

```js
  // ══ Fernzugriff ═══════════════════════════════════════════════════════
  // Eigene WebSocket-Verbindung, direkt aus der Seite heraus. Der Umweg ueber
  // React Native scheidet aus: dessen Bruecke kann nur Text, Video muesste also
  // base64-kodiert werden — ein Drittel mehr Daten, 30-mal pro Sekunde.
  (function () {
    var ws = null;
    var decoder = null;
    var canvas = null;
    var ctx = null;
    var retry = 0;
    var retryTimer = null;
    var wantRunning = false;
    var preset = 'auto';

    var PRESETS = {
      sparsam: { maxWidth: 1280, fps: 24, bitrateKbps: 800 },
      auto:    { maxWidth: 1600, fps: 30, bitrateKbps: 1500 },
      scharf:  { maxWidth: 1920, fps: 30, bitrateKbps: 3000 },
    };

    function veil(text) {
      var v = document.getElementById('remoteVeil');
      var t = document.getElementById('remoteVeilText');
      if (!v || !t) return;
      if (text) { t.textContent = text; v.dataset.show = '1'; }
      else { v.dataset.show = '0'; }
    }

    function stat(text) {
      var el = document.getElementById('remoteStat');
      if (el) el.textContent = text;
    }

    /** Die Buehne bekommt genau die Hoehe, die das Bild seitenrichtig braucht. */
    function layoutStage() {
      var stage = document.getElementById('remoteStage');
      if (!stage || !window.remoteState.w) return;
      var w = stage.clientWidth || stage.getBoundingClientRect().width;
      // window.-Vorsatz ist Pflicht: der Mockup-Code liegt in einer Kapsel, in
      // die bridge.js nicht hineinsieht (siehe Ausfuhr-Zeilen in Aufgabe 11).
      var box = window.fitRect(window.remoteState.w, window.remoteState.h, w, w * 2);
      stage.style.height = box.h + 'px';
      if (canvas) { canvas.width = window.remoteState.w; canvas.height = window.remoteState.h; }
    }

    function ensureDecoder() {
      if (decoder && decoder.state !== 'closed') return true;
      if (typeof VideoDecoder === 'undefined') {
        veil('Dieses Geraet kann den Bildstrom nicht anzeigen.');
        return false;
      }
      decoder = new VideoDecoder({
        output: function (frame) {
          if (ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
        },
        error: function () {
          // Ein Dekoderfehler heilt nur mit einem frischen Vollbild.
          try { decoder.close(); } catch (e) {}
          decoder = null;
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:keyframe' }));
        },
      });
      // Ohne `description` erwartet WebCodecs Annex-B — genau das, was der Server sendet.
      decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true });
      return true;
    }

    function onBinary(buf) {
      var view = new Uint8Array(buf);
      if (view.length < 6 || (view[0] & 0x7f) !== 0x01) return;
      var keyframe = (view[0] & 0x80) !== 0;
      var ts = (view[1] << 24 | view[2] << 16 | view[3] << 8 | view[4]) >>> 0;
      if (!ensureDecoder()) return;
      // Vor dem ersten Vollbild ist jedes Zwischenbild sinnlos — der Dekoder
      // haette keinen Ausgangspunkt und zeichnete graue Kloetze.
      if (decoder.state !== 'configured') return;
      if (!keyframe && !decoder.__gotKey) return;
      if (keyframe) decoder.__gotKey = true;
      decoder.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: ts * 1000,
        data: view.subarray(5),
      }));
    }

    function onControl(msg) {
      switch (msg.type) {
        case 'remote:started':
          window.remoteState.running = true;
          window.remoteState.w = msg.payload.width;
          window.remoteState.h = msg.payload.height;
          window.remoteState.scale = msg.payload.scale;
          retry = 0;
          veil('');
          layoutStage();
          break;
        case 'remote:status':
          stat(msg.payload.fps + ' fps · ' + msg.payload.kbps + ' kbit/s');
          break;
        case 'remote:stopped':
          window.remoteState.running = false;
          veil('Beendet');
          break;
        case 'remote:error':
          window.remoteState.running = false;
          veil(remoteErrorText(msg.payload));
          break;
      }
    }

    function connect() {
      if (!remoteTarget) { veil('Kein Server verbunden.'); return; }
      canvas = document.getElementById('remoteCanvas');
      ctx = canvas ? canvas.getContext('2d') : null;

      var url = 'ws://' + remoteTarget.host + ':' + remoteTarget.port
              + '/remote?token=' + encodeURIComponent(remoteTarget.token);
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function () {
        ws.send(JSON.stringify({ type: 'remote:start', payload: PRESETS[preset] }));
        veil('Verbinde …');
      };
      ws.onmessage = function (e) {
        if (typeof e.data === 'string') { try { onControl(JSON.parse(e.data)); } catch (err) {} }
        else onBinary(e.data);
      };
      ws.onclose = function () {
        ws = null;
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
        if (!wantRunning) return;
        // Nie aufgeben: die Verbindung faellt unterwegs staendig kurz weg.
        retry = Math.min(retry + 1, 6);
        veil('Verbindung verloren — neuer Versuch …');
        retryTimer = setTimeout(connect, Math.min(500 * retry, 4000));
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }

    window.TMSRemote = {
      start: function (which) {
        preset = which || preset;
        wantRunning = true;
        if (typeof window.buildRemoteScreen === 'function' && !document.getElementById('remoteStage')) {
          window.buildRemoteScreen();
        }
        if (!ws) connect();
      },
      stop: function () {
        wantRunning = false;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:stop' }));
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
      },
      /** Stufenwechsel = neu starten: ffmpeg auf Windows kann die Bitrate nicht im Lauf aendern. */
      setQuality: function (which) {
        preset = which;
        if (!wantRunning) return;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'remote:stop' }));
          ws.send(JSON.stringify({ type: 'remote:start', payload: PRESETS[preset] }));
        }
      },
      input: function (ev) {
        if (ws && ws.readyState === 1 && window.remoteState.running) ws.send(JSON.stringify(ev));
      },
      dictate: function () { post('mic:start', { target: 'remote' }); },
    };

    // Der Mockup ruft das beim Vollbildwechsel und nach Gesten auf, kommt aber
    // nicht in diese Kapsel hinein — deshalb ausdruecklich nach aussen geben.
    window.layoutRemoteStage = layoutStage;
    window.addEventListener('resize', layoutStage);
  })();

  /** Fehlercodes des Servers in Saetze, die weiterhelfen. */
  function remoteErrorText(p) {
    switch (p && p.code) {
      case 'permission_screen':
        return 'Der Mac darf seinen Bildschirm nicht teilen.\n'
             + 'Systemeinstellungen → Datenschutz & Sicherheit → Bildschirmaufnahme';
      case 'permission_input':
        return 'Der Mac darf keine Eingaben annehmen.\n'
             + 'Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen';
      case 'display_asleep':
        return 'Der Bildschirm des Macs ist eingeschlafen. Gleich noch einmal versuchen.';
      case 'capture_unavailable':
        return 'Auf dem PC fehlt ffmpeg. Einmalig einrichten:  winget install ffmpeg';
      case 'disabled':
        return 'Der Fernzugriff ist auf diesem Server abgeschaltet.';
      case 'helper_crashed':
        return 'Die Bildschirmaufnahme ist abgestuerzt. Erneut versuchen.';
      default:
        return (p && p.message) || 'Der Fernzugriff ist fehlgeschlagen.';
    }
  }
```

- [ ] **Step 3: Bauen**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
```

Erwartet: `liquidDeckHtml.ts` neu geschrieben, keine Fehlermeldung über nicht mehr passende Patches.

- [ ] **Step 4: Gegen den echten Server prüfen**

Den Fernzugriffs-Endpunkt vom Rechner aus ansprechen — ohne App, nur um zu sehen, dass Bilder fließen. Ein gültiges Token steht in der App bzw. lässt sich über den normalen Anmeldeweg holen:

```bash
cd ~/Desktop/tms-terminal/server
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8767/remote?token=' + process.env.TOKEN);
let frames = 0, bytes = 0, keys = 0;
ws.on('open', () => ws.send(JSON.stringify({type:'remote:start',payload:{maxWidth:1280,fps:30,bitrateKbps:800}})));
ws.on('message', (d, bin) => {
  if (!bin) return console.log('STEUERUNG', d.toString().slice(0, 160));
  frames++; bytes += d.length; if (d[0] & 0x80) keys++;
});
setTimeout(() => { console.log({frames, kb: Math.round(bytes/1024), keys}); process.exit(0); }, 5000);
"
```

Erwartet: eine `remote:started`-Zeile mit den Bildschirmmaßen, danach **rund 150 Bilder in 5 Sekunden**, mindestens 2 Vollbilder und eine plausible Datenmenge (bei 800 kbit/s etwa 500 KB).

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/tms-terminal
git add mobile/src/season2/web/bridge.js mobile/src/season2/web/liquidDeckHtml.ts
git commit -m "feat(remote): Bildstrom-Verbindung und WebCodecs-Dekoder in der Bruecke"
```

---

### Task 15: Vollbild-Modus für angeschlossene Tastatur und Maus

Manuell umgeschaltet, wie festgelegt — keine Erkennung, die danebenliegen kann.

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js`
- Modify: `~/Desktop/tms-terminal/mobile/scripts/remote-logic.test.mjs`

**Interfaces:**
- Consumes: `fitRect` (11) · `window.TMSRemote.input` (14) · `remoteState` (11)
- Produces:
  ```js
  window.setRemoteFullscreen(on)
  // im markierten Block:
  toStageNormalized(clientX, clientY, box)   // → {x, y} in 0..1 oder null ausserhalb
  ```

- [ ] **Step 1: Write the failing test**

An `mobile/scripts/remote-logic.test.mjs` anfügen (und `toStageNormalized` im `return` von `loadBlock` ergänzen):

```js
test('toStageNormalized rechnet Bildschirmpunkte in Bildkoordinaten', () => {
  const { toStageNormalized } = loadBlock('remoteMath');
  const box = { x: 20, y: 10, w: 200, h: 100 };   // Bild sitzt mit Rand in der Buehne

  assert.deepEqual(toStageNormalized(20, 10, box), { x: 0, y: 0 }, 'linke obere Ecke');
  assert.deepEqual(toStageNormalized(220, 110, box), { x: 1, y: 1 }, 'rechte untere Ecke');
  assert.deepEqual(toStageNormalized(120, 60, box), { x: 0.5, y: 0.5 }, 'Mitte');
});

test('toStageNormalized meldet Punkte neben dem Bild als ungueltig', () => {
  const { toStageNormalized } = loadBlock('remoteMath');
  const box = { x: 20, y: 10, w: 200, h: 100 };
  assert.equal(toStageNormalized(5, 60, box), null, 'im schwarzen Rand links');
  assert.equal(toStageNormalized(120, 200, box), null, 'unterhalb des Bildes');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: FAIL — `toStageNormalized is not defined`.

- [ ] **Step 3: Die Umrechnung in den markierten Block aufnehmen**

```js
  /**
   * Punkt auf dem Handybildschirm → Punkt im gespiegelten Bild (0..1).
   *
   * Im Vollbild-Modus wird die Maus ABSOLUT abgebildet: der PC-Zeiger steht
   * dort, wo der Android-Zeiger ueber dem Bild steht. Der Browser-Weg fuer
   * relative Bewegung (Pointer Lock) ist im Android-WebView unzuverlaessig, und
   * mit sichtbarem Zeiger ist absolut ohnehin das Natuerlichere.
   * Ausserhalb des Bildes (schwarzer Rand) gibt es nichts zu steuern → null.
   */
  function toStageNormalized(clientX, clientY, box) {
    var nx = (clientX - box.x) / box.w;
    var ny = (clientY - box.y) / box.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { x: nx, y: ny };
  }
```

Und in die Ausfuhr-Zeilen am Ende des Blocks aufnehmen — `bridge.js` ruft die Funktion auf:

```js
    window.toStageNormalized = toStageNormalized;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: `# pass 12`, `# fail 0`.

- [ ] **Step 5: Umschalten im Mockup**

```js
  window.setRemoteFullscreen = function (on) {
    window.remoteState.fullscreen = !!on;
    var host = document.querySelector('[data-screen="remote"]');
    if (host) host.classList.toggle('fullscreen', !!on);
    if (typeof layoutRemoteStage === 'function') layoutRemoteStage();
  };
```

Den Knopf aus Aufgabe 11 verdrahten, in `buildRemoteScreen()`:

```js
    host.querySelector('#remoteFull').addEventListener('click', function () {
      window.setRemoteFullscreen(!window.remoteState.fullscreen);
    });
```

Ein Abzeichen zum Zurückkehren, in das Markup der Bühne aufnehmen:

```js
      +   '<button class="remote-badge" id="remoteExit">⌨ + 🖱 · ⤡</button>'
```

und verdrahten:

```js
    host.querySelector('#remoteExit').addEventListener('click', function () {
      window.setRemoteFullscreen(false);
    });
```

Gestaltung:

```css
  [data-screen="remote"].fullscreen { padding: 0; gap: 0; }
  [data-screen="remote"].fullscreen .remote-head,
  [data-screen="remote"].fullscreen .remote-seg,
  [data-screen="remote"].fullscreen .remote-bar { display: none; }
  [data-screen="remote"].fullscreen .remote-stage { flex: 1; border-radius: 0; }
  .remote-badge { position: absolute; right: 8px; top: 8px; display: none;
                  padding: 4px 9px; border-radius: 20px; font-size: 10px;
                  background: rgba(8,12,18,.72); border: 1px solid rgba(255,255,255,.14);
                  color: rgba(255,255,255,.75); }
  [data-screen="remote"].fullscreen .remote-badge { display: block; }
```

- [ ] **Step 6: Harte Tastatur und Maus in `bridge.js` weiterleiten**

Innerhalb des Fernzugriffs-Blocks aus Aufgabe 14 ergänzen:

```js
    /** Rechteck des Bildes innerhalb der Buehne, in Bildschirmkoordinaten. */
    function stageBox() {
      var stage = document.getElementById('remoteStage');
      if (!stage || !window.remoteState.w) return null;
      var r = stage.getBoundingClientRect();
      var box = window.fitRect(window.remoteState.w, window.remoteState.h, r.width, r.height);
      return { x: r.left + box.x, y: r.top + box.y, w: box.w, h: box.h };
    }

    // Angeschlossene Maus: absolute Abbildung ueber dem Bild.
    document.addEventListener('pointermove', function (e) {
      if (!window.remoteState.fullscreen || e.pointerType !== 'mouse') return;
      var box = stageBox();
      if (!box) return;
      var p = window.toStageNormalized(e.clientX, e.clientY, box);
      if (p) window.TMSRemote.input({ t: 'm', x: p.x, y: p.y });
    });

    document.addEventListener('pointerdown', function (e) {
      if (!window.remoteState.fullscreen || e.pointerType !== 'mouse') return;
      if (e.target.closest('#remoteExit')) return;
      e.preventDefault();
      window.TMSRemote.input({ t: 'b', b: e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l', d: true });
    });
    document.addEventListener('pointerup', function (e) {
      if (!window.remoteState.fullscreen || e.pointerType !== 'mouse') return;
      window.TMSRemote.input({ t: 'b', b: e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l', d: false });
    });
    document.addEventListener('contextmenu', function (e) {
      if (window.remoteState.fullscreen) e.preventDefault();
    });
    document.addEventListener('wheel', function (e) {
      if (!window.remoteState.fullscreen) return;
      e.preventDefault();
      window.TMSRemote.input({ t: 's', dx: Math.round(-e.deltaX / 20), dy: Math.round(-e.deltaY / 20) });
    }, { passive: false });

    // Angeschlossene Tastatur: Tasten abfangen, bevor der Browser sie deutet.
    function forwardKey(e, down) {
      if (!window.remoteState.fullscreen) return;
      if (e.key === 'Escape' && e.shiftKey) {      // Notausstieg, falls das Abzeichen verdeckt ist
        if (down) window.setRemoteFullscreen(false);
        return;
      }
      e.preventDefault();
      window.TMSRemote.input({
        t: 'k', c: e.code, d: down,
        mods: { s: e.shiftKey, c: e.ctrlKey, a: e.altKey, m: e.metaKey },
      });
    }
    document.addEventListener('keydown', function (e) { forwardKey(e, true); }, true);
    document.addEventListener('keyup', function (e) { forwardKey(e, false); }, true);
```

- [ ] **Step 7: Am Gerät prüfen**

Mit angeschlossener Bluetooth- oder USB-Tastatur und -Maus am Fold: Vollbild einschalten.

Erwartet: Kopfzeile und Leiste verschwinden, das Bild füllt den Schirm; der PC-Zeiger folgt der Maus, Klicks und Scrollrad wirken, Tippen landet auf dem PC. `Umschalt+Esc` kommt zurück.

- [ ] **Step 8: Bauen und einchecken**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
cd ~/Desktop/TMS\ Terminal && git add mockups/season2/liquid-deck/index.html && git commit -m "feat(remote): Vollbild-Modus fuer externe Tastatur und Maus"
cd ~/Desktop/tms-terminal && git add mobile/src/season2/web mobile/scripts/remote-logic.test.mjs && git commit -m "feat(remote): harte Tastatur und Maus im Vollbild weiterleiten"
```

---

### Task 16: Einstieg auf der Gerätekarte und die React-Native-Seite

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html` (`renderServers`, ab Zeile ~2886)
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/SeasonTwoWebRoot.tsx` (Nachrichtenzweig ab Zeile ~737)

**Interfaces:**
- Consumes: `window.TMSRemote` (14) · `window.TMSBridge.setRemoteTarget` (14)
- Produces: Bridge-Nachricht `remote:open` von der Seite an React Native

- [ ] **Step 1: Knopf auf die Gerätekarte setzen**

In `renderServers()` das Karten-Markup um eine Aktionszeile erweitern (nach `</div>` des `server-info`-Blocks):

```js
        <div class="server-actions">
          <button class="server-action" data-remote="${srv.id}" ${online ? '' : 'disabled'}>
            Fernzugriff
          </button>
        </div>
```

Und im Karten-Klick den neuen Knopf abfangen, **bevor** die bestehende Umschaltlogik greift:

```js
      card.addEventListener('click', function (e) {
        var remoteBtn = e.target.closest('[data-remote]');
        if (remoteBtn) {
          e.stopPropagation();
          if (!online) { toast(srv.name + ' ist offline'); return; }
          post('remote:open', { id: srv.id });   // React Native liefert die Zugangsdaten
          show('remote');
          if (window.TMSRemote) window.TMSRemote.start('auto');
          return;
        }
        if (srv.active) { goToTerminals(); return; }
        if (!online) { toast(srv.name + ' ist offline'); return; }
        if (window.__tmsSwitchServer) { window.__tmsSwitchServer(srv.id); goToTerminals(); }
        else goToTerminals();
      });
```

Gestaltung:

```css
  .server-actions { display: flex; gap: 6px; margin-top: 8px; }
  .server-action { padding: 7px 12px; border-radius: 9px; font-size: 11px; font-weight: 600;
                   border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.07);
                   color: inherit; }
  .server-action[disabled] { opacity: .35; }
```

- [ ] **Step 2: React Native verdrahten**

In `SeasonTwoWebRoot.tsx` bei den übrigen `case`-Zweigen (ab Zeile ~737):

```tsx
      case 'remote:open': {
        // Die Seite oeffnet ihre eigene Verbindung — wir reichen nur die Zugangsdaten durch.
        const srv = servers.find((s) => s.id === msg.payload?.id) ?? activeServer;
        if (srv) {
          inject(`window.TMSBridge.setRemoteTarget(${JSON.stringify({
            host: srv.host, port: srv.port, token: srv.token,
          })}); true;`);
        }
        break;
      }
```

(`inject` ist die im Modul bereits vorhandene Funktion zum Ausführen von JavaScript im WebView; die Namen `servers`/`activeServer` an die dort tatsächlich verwendeten anpassen.)

Und den Vorder-/Hintergrund-Wechsel melden — bei den übrigen Effekten:

```tsx
  // Im Hintergrund ist die Aufnahme reine Verschwendung: sie kostet auf dem PC
  // Rechenzeit und hier Akku. Das browserseitige visibilitychange ist im
  // Android-WebView dafuer unzuverlaessig, deshalb der Weg ueber AppState.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') inject('window.TMSRemote && window.TMSRemote.start(); true;');
      else inject('window.TMSRemote && window.TMSRemote.stop(); true;');
    });
    return () => sub.remove();
  }, []);
```

`AppState` aus `react-native` importieren, falls noch nicht geschehen.

- [ ] **Step 3: Diktat auf den PC leiten**

Der `mic:start`-Zweig bekommt das neue Ziel: kommt `{ target: 'remote' }`, wird der erkannte Text nicht in ein Terminal geschrieben, sondern an die Seite zurückgegeben:

```tsx
      case 'mic:start':
        if (msg.payload?.target === 'remote') {
          startDictation((text: string) => {
            inject(`window.TMSRemote && window.TMSRemote.input(${JSON.stringify({ t: 'x', s: text })}); true;`);
          });
          break;
        }
        // bestehendes Verhalten unveraendert
```

(Den Namen der vorhandenen Diktat-Funktion an den im Modul verwendeten anpassen.)

- [ ] **Step 4: Übersetzung prüfen**

```bash
cd ~/Desktop/tms-terminal/mobile && npx tsc --noEmit
```

Erwartet: keine Fehler.

- [ ] **Step 5: Bauen, Layout prüfen, einchecken**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2 && npm run test:mockup
```

Headless bei 412 × 915 und 840 × 900 nachsehen, dass die Karte mit dem neuen Knopf nicht umbricht.

```bash
cd ~/Desktop/TMS\ Terminal && git add mockups/season2/liquid-deck/index.html && git commit -m "feat(remote): Fernzugriffs-Knopf auf der Geraetekarte"
cd ~/Desktop/tms-terminal && git add mobile/src/season2 && git commit -m "feat(remote): Zugangsdaten, Hintergrund-Pause und Diktat verdrahtet"
```

---

### Task 17: Bildgesten — vergrößern, verschieben, Zeiger versetzen

Deckt die drei Zeilen der Spezifikation ab, die bisher in keiner Aufgabe standen: Aufziehen bis 3×, Doppeltipp auf 1:1, und der lange Druck aufs Bild, der den Zeiger dorthin setzt.

**Files:**
- Modify: `~/Desktop/TMS Terminal/mockups/season2/liquid-deck/index.html`
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js`
- Modify: `~/Desktop/tms-terminal/mobile/scripts/remote-logic.test.mjs`

**Interfaces:**
- Consumes: `fitRect`, `toStageNormalized` (Aufgaben 11, 15) · `window.TMSRemote.input` (14)
- Produces (im markierten Block):
  ```js
  clampZoom(z)                        // 1 … 3
  clampPan(offset, zoom, size)        // haelt das Bild im Rahmen
  ```

- [ ] **Step 1: Write the failing test**

An `mobile/scripts/remote-logic.test.mjs` anfügen (und beide Namen im `return` von `loadBlock` ergänzen):

```js
test('clampZoom bleibt zwischen 1 und 3', () => {
  const { clampZoom } = loadBlock('remoteMath');
  assert.equal(clampZoom(0.4), 1, 'kleiner als das Bild ergibt keinen Sinn');
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(9), 3, 'darueber wird es nur noch matschig');
});

test('clampPan laesst bei 1x gar kein Verschieben zu', () => {
  const { clampPan } = loadBlock('remoteMath');
  assert.equal(clampPan(120, 1, 400), 0, 'unvergroessert gibt es nichts zu verschieben');
});

test('clampPan haelt das vergroesserte Bild im Rahmen', () => {
  const { clampPan } = loadBlock('remoteMath');
  // Bei 2x ist das Bild 800 breit, der Rahmen 400 — je 200 Spielraum pro Seite.
  assert.equal(clampPan(0, 2, 400), 0);
  assert.equal(clampPan(500, 2, 400), 200, 'nach rechts abgefangen');
  assert.equal(clampPan(-500, 2, 400), -200, 'nach links abgefangen');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: FAIL — `clampZoom is not defined`.

- [ ] **Step 3: Beide Funktionen in den markierten Block aufnehmen**

```js
  /** Aufziehen bis 3× — darueber zeigt der Strom keine echten Bildpunkte mehr. */
  function clampZoom(z) {
    if (!isFinite(z)) return 1;
    return z < 1 ? 1 : z > 3 ? 3 : z;
  }

  /**
   * Haelt das vergroesserte Bild im Rahmen: bei Zoom z ist es z-mal so breit wie
   * die Flaeche, also gibt es je Seite (z-1)/2 der Flaechenbreite an Spielraum.
   */
  function clampPan(offset, zoom, size) {
    var slack = ((zoom - 1) * size) / 2;
    if (slack <= 0) return 0;
    return offset > slack ? slack : offset < -slack ? -slack : offset;
  }
```

Beide in die Ausfuhr-Zeilen am Ende des Blocks aufnehmen — `bridge.js` ruft sie auf:

```js
    window.clampZoom = clampZoom;
    window.clampPan = clampPan;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run test:mockup
```

Erwartet: `# pass 15`, `# fail 0`.

- [ ] **Step 5: Die Gesten an der Bühne verdrahten**

Im Fernzugriffs-Block von `bridge.js`:

```js
    var view = { zoom: 1, x: 0, y: 0 };
    var pinch = null;
    var holdTimer = null;

    function applyView() {
      if (!canvas) return;
      canvas.style.transformOrigin = 'center center';
      canvas.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
    }

    function wireStageGestures() {
      var stage = document.getElementById('remoteStage');
      if (!stage || stage.dataset.wired === '1') return;
      stage.dataset.wired = '1';
      stage.style.touchAction = 'none';

      var points = new Map();
      var lastTap = 0;

      stage.addEventListener('pointerdown', function (e) {
        if (window.remoteState.fullscreen) return;      // dort gehoert alles der Maus
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (points.size === 2) {
          var p = Array.from(points.values());
          pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), zoom: view.zoom };
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          return;
        }
        // Langer Druck aufs Bild: Zeiger dorthin — fuer weite Wege, die auf dem
        // Trackpad mehrere Wischer kosten wuerden.
        var start = { x: e.clientX, y: e.clientY };
        holdTimer = setTimeout(function () {
          holdTimer = null;
          var box = stageBox();
          if (!box) return;
          var n = window.toStageNormalized(start.x, start.y, box);
          if (n) {
            window.TMSRemote.input({ t: 'm', x: n.x, y: n.y });
            if (navigator.vibrate) navigator.vibrate(12);
          }
        }, 400);
      });

      stage.addEventListener('pointermove', function (e) {
        if (!points.has(e.pointerId)) return;
        var prev = points.get(e.pointerId);
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 8 && holdTimer) {
          clearTimeout(holdTimer); holdTimer = null;
        }

        if (pinch && points.size === 2) {
          var p = Array.from(points.values());
          var d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
          view.zoom = window.clampZoom(pinch.zoom * (d / pinch.d));
        } else if (points.size === 1 && view.zoom > 1) {
          var r = stage.getBoundingClientRect();
          view.x = window.clampPan(view.x + (e.clientX - prev.x), view.zoom, r.width);
          view.y = window.clampPan(view.y + (e.clientY - prev.y), view.zoom, r.height);
        }
        applyView();
      });

      function up(e) {
        points.delete(e.pointerId);
        if (points.size < 2) pinch = null;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }

        var now = Date.now();
        if (now - lastTap < 300) {                      // Doppeltipp
          view.zoom = view.zoom > 1 ? 1 : 2;
          view.x = 0; view.y = 0;
          applyView();
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    }
```

`wireStageGestures()` in `TMSRemote.start()` direkt nach `buildRemoteScreen()` aufrufen, und in `layoutStage()` am Ende `applyView()` ergänzen.

- [ ] **Step 6: Von Hand prüfen**

Erwartet: Aufziehen vergrößert bis 3× und lässt sich verschieben, ohne dass das Bild aus dem Rahmen läuft; Doppeltipp springt zwischen 1× und 2×; ein langer Druck setzt den Zeiger an die gedrückte Stelle (kurzes Vibrieren als Rückmeldung) und löst **keinen** Klick aus.

- [ ] **Step 7: Bauen und einchecken**

```bash
cd ~/Desktop/tms-terminal/mobile && npm run build:season2 && npm run test:mockup
cd ~/Desktop/TMS\ Terminal && git add mockups/season2/liquid-deck/index.html && git commit -m "feat(remote): Zoom, Verschieben und Zeiger-Versetzen auf dem Bild"
cd ~/Desktop/tms-terminal && git add mobile/src/season2/web mobile/scripts/remote-logic.test.mjs && git commit -m "feat(remote): Bildgesten gebaut"
```

---

### Task 18: Widerstandsfähigkeit — Helfer-Neustart und Auflösungswechsel

Zwei Zeilen der Spezifikation, die bisher nur beschrieben, aber nicht gebaut waren: der Helfer-Neustart mit wachsender Wartezeit (0,5 s / 1 s / 2 s, danach `helper_crashed`) und der Auflösungswechsel.

Beides fällt zusammen: ein gestorbener Helfer und ein Bildschirm, dessen Auflösung sich geändert hat, brauchen dieselbe Antwort — Aufnahme neu starten und der App die neuen Maße schicken.

**Files:**
- Create: `~/Desktop/tms-terminal/server/src/remote/restart.ts`
- Test: `~/Desktop/tms-terminal/server/src/remote/restart.test.ts`
- Modify: `~/Desktop/tms-terminal/server/src/remote/remote.socket.ts`
- Modify: `~/Desktop/tms-terminal/mobile/src/season2/web/bridge.js`

**Interfaces:**
- Consumes: `ScreenCapture` (5) · `RemoteErrorCode` (5)
- Produces:
  ```ts
  export const RESTART_DELAYS_MS: readonly number[];
  export function nextRestartDelay(attempt: number): number | null;
  ```

- [ ] **Step 1: Write the failing test**

`server/src/remote/restart.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRestartDelay, RESTART_DELAYS_MS } from './restart';

test('die Wartezeiten stehen so in der Spezifikation', () => {
  assert.deepEqual([...RESTART_DELAYS_MS], [500, 1000, 2000]);
});

test('nextRestartDelay geht die Stufen durch und gibt dann auf', () => {
  assert.equal(nextRestartDelay(0), 500);
  assert.equal(nextRestartDelay(1), 1000);
  assert.equal(nextRestartDelay(2), 2000);
  assert.equal(nextRestartDelay(3), null, 'nach dem dritten Versuch ist Schluss');
  assert.equal(nextRestartDelay(99), null);
});

test('unsinnige Zaehler ergeben keinen Versuch', () => {
  assert.equal(nextRestartDelay(-1), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/restart.test.ts
```

Erwartet: FAIL — `Cannot find module './restart'`.

- [ ] **Step 3: Write minimal implementation**

`server/src/remote/restart.ts`:

```ts
/**
 * How often and how fast a dead capture helper is brought back.
 *
 * Same answer covers two cases: a crashed helper, and a display whose resolution
 * changed underneath the running capture — both need a fresh capture and fresh
 * dimensions sent to the app.
 */
export const RESTART_DELAYS_MS = [500, 1000, 2000] as const;

export function nextRestartDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return attempt < RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[attempt] : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test src/remote/restart.test.ts
```

Erwartet: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Den Neustart in `remote.socket.ts` einhängen**

Import ergänzen und den Fehlerzweig aus Aufgabe 5 ersetzen:

```ts
import { nextRestartDelay } from './restart';
```

Im Sitzungszustand:

```ts
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let lastOpts: CaptureOptions | null = null;
```

In `stop()` mit aufräumen:

```ts
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
```

In `start()` die Optionen merken und den Fehlerzweig umbauen:

```ts
    lastOpts = opts;
    const c = deps.makeCapture();
    c.onError((code, message) => {
      // Der Identitaets-Waechter aus Aufgabe 5 gilt hier genauso — sonst laesst
      // ein verspaeteter Fehler der alten Aufnahme den frischen Neustart wieder
      // abraeumen, und die Wiederbelebung schiesst sich selbst ab.
      if (capture !== null && capture !== c) return;
      // Ein abgestuerzter Helfer ist der Normalfall, nicht das Ende: erst
      // wiederbeleben, und nur wenn das dreimal misslingt, den Nutzer stoeren.
      if (code === 'helper_crashed' && lastOpts) {
        const delay = nextRestartDelay(restartAttempt++);
        if (delay !== null) {
          void stop('neustart', false);
          restartTimer = setTimeout(() => { void start(lastOpts!); }, delay);
          return;
        }
      }
      fail(code, message);
      void stop('fehler', false);
    });
```

Und nach erfolgreichem Start den Zähler zurücksetzen — direkt neben `startedAt = Date.now();`:

```ts
      restartAttempt = 0;
```

Weil jeder erfolgreiche Start ein frisches `remote:started` sendet, bekommt die App nach einem Auflösungswechsel automatisch die neuen Maße.

- [ ] **Step 6: Die App auf ein zweites `remote:started` vorbereiten**

In `bridge.js`, im `remote:started`-Zweig aus Aufgabe 14 **vor** dem Setzen der Maße:

```js
          // Neue Masse heissen neuer Bildaufbau — der alte Dekoder rechnet noch
          // mit der alten Groesse und wuerde verzerrte Bilder liefern.
          if (decoder && (window.remoteState.w !== msg.payload.width
                       || window.remoteState.h !== msg.payload.height)) {
            try { decoder.close(); } catch (e) {}
            decoder = null;
          }
```

- [ ] **Step 7: Nachweisen, dass ein getöteter Helfer zurückkommt**

Bei laufender Sitzung auf dem Mac:

```bash
pkill -f tms-remote-helper
```

Erwartet: das Bild friert kurz ein und läuft nach etwa einer halben Sekunde von selbst weiter — **ohne** Fehlermeldung in der App. Erst wenn der Helfer dreimal hintereinander stirbt (etwa durch wiederholtes `pkill`), erscheint „Die Bildschirmaufnahme ist abgestürzt."

- [ ] **Step 8: Gesamtlauf und Commit**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit && npm test
cd ~/Desktop/tms-terminal/mobile && npm run build:season2
cd ~/Desktop/tms-terminal
git add server/src/remote mobile/src/season2/web
git commit -m "feat(remote): Helfer-Neustart mit Wartezeiten und Aufloesungswechsel"
```

---

### Task 19: Zusammenbauen, prüfen, ausliefern

**Files:**
- Modify: `~/Desktop/TMS Terminal/CLAUDE.md` (kurzer Abschnitt zum Fernzugriff)
- Kein neuer Code

- [ ] **Step 1: Alles prüfen**

```bash
cd ~/Desktop/tms-terminal/server && npx tsc --noEmit
cd ~/Desktop/tms-terminal/server && node --require ts-node/register --test 'src/remote/**/*.test.ts'
cd ~/Desktop/tms-terminal/mobile && npx tsc --noEmit && npm run test:mockup
```

Erwartet: alle drei Läufe grün. **Kein „ist fertig" ohne diese Ausgabe.**

**Warum nicht `npm test`:** Der volle Lauf ist in diesem Arbeitsbaum **vorbestehend kaputt** — `terminal.manager.test.ts` hängt (in Aufgabe 5 nach ~19 Minuten ohne Fortschritt abgebrochen), und `terminal.manager.restore.test.ts` schlägt fehl. Beides hat mit dem Fernzugriff nichts zu tun: der Zweig fügt ausschließlich hinzu (722 Zeilen, 0 gelöscht) und fasst `server/src/terminal/` nie an. Nachgewiesen mit `git log feat/manager-chat-redesign..feat/fernzugriff -- server/src/terminal/` (leer). Ein Prüftor an `npm test` zu hängen hieße, es nie zu erreichen — deshalb der zielgenaue Lauf über `src/remote/`. Der kaputte Terminal-Test bleibt ein eigenes, dem Nutzer gemeldetes Thema.

- [ ] **Step 2: Den Server neu übersetzen**

```bash
cd ~/Desktop/tms-terminal/server && rm -f .tsbuildinfo && npx tsc
ls -la dist/server/src/remote/
```

`.tsbuildinfo` muss weg: ein stehengebliebener Stand lässt `tsc` folgenlos durchlaufen, und der Server startet danach mit `MODULE_NOT_FOUND`.

- [ ] **Step 3: Den Nutzer um den Neustart bitten**

Der Server läuft im selben PTY wie die Arbeitssitzung — ein Neustart von hier aus beendet sie. Also: dem Nutzer sagen, dass er den Server neu starten soll, und was danach zu sehen sein sollte.

- [ ] **Step 4: Am Gerät durchspielen**

Nach dem Neustart, mit der App am Fold:

1. Gerätekarte → „Fernzugriff" → Bild erscheint in unter 3 Sekunden
2. Trackpad: Zeiger bewegen, klicken, rechtsklicken, scrollen
3. Tastatur: Text tippen, ⌘+Leertaste (Spotlight), haftende Sondertaste zweimal antippen
4. Bild aufziehen und verschieben, Doppeltipp
5. Vollbild mit angeschlossener Tastatur und Maus
6. App in den Hintergrund → Aufnahme stoppt (am PC prüfbar: der Helferprozess ist weg)
7. Flugmodus kurz an und aus → Bild friert ein, kommt von selbst zurück
8. Aufgeklappt und zugeklappt je einmal durchgehen

- [ ] **Step 5: Version anheben und ausliefern**

Der örtliche APK-Bau bleibt am Metro-Schritt hängen; ausgeliefert wird über den GitHub-Actions-Lauf beim Setzen eines Tags:

```bash
cd ~/Desktop/tms-terminal
git push origin feat/manager-chat-redesign
# Version in mobile/app.json und mobile/android/app/build.gradle anheben, dann:
git tag v1.109.0 && git push origin v1.109.0
```

- [ ] **Step 6: `CLAUDE.md` ergänzen**

Einen kurzen Abschnitt aufnehmen: wo der macOS-Helfer liegt, dass er beim Einrichten gebaut wird, welche zwei Berechtigungen nötig sind, und dass Windows ffmpeg voraussetzt.

```bash
cd ~/Desktop/TMS\ Terminal && git add CLAUDE.md && git commit -m "docs: Fernzugriff in den Projekthinweisen"
```

---

## Was am Ende offen bleibt

- **Windows ist ungetestet**, solange keine Windows-Maschine erreichbar ist (Aufgabe 8 Schritt 8, Aufgabe 9 Schritt 8). Beim Ausliefern ausdrücklich sagen.
- **`remote:quality` wirkt auf Windows nicht im Lauf** — ffmpeg kann die Bitrate nicht nachträglich ändern. Die App startet die Sitzung bei einem Stufenwechsel deshalb neu (Aufgabe 14).
- **Die Rückstau-Regelung senkt auf Windows nur über das Verwerfen von Zwischenbildern**, nicht über die Bitrate.
- **Kein Ton, keine gemeinsame Zwischenablage, ein Bildschirm** — bewusste Nicht-Ziele der Spezifikation.
