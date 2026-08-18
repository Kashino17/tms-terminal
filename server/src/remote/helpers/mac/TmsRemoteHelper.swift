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

// Placeholder until Task 7 replaces this with the real input loop.
func runInputLoop() { fail("capture_unavailable", "Eingabe folgt in Aufgabe 7") }
