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

// ── Capture ─────────────────────────────────────────────────────────────
final class Capture: NSObject, SCStreamOutput {
  private var session: VTCompressionSession?
  private var stream: SCStream?
  private let out = FileHandle.standardOutput
  private var wantKeyframe = false
  var assertion: IOPMAssertionID = 0

  // ScreenCaptureKit delivers change-driven: on a still screen only ~6 frames
  // per second arrive, sometimes none for seconds at a time. Someone opening a
  // session then sees nothing until something moves. So the last captured
  // buffer gets looked up again — measured in Task 1.
  private var lastPixelBuffer: CVPixelBuffer?
  private var lastFrameAt = Date.distantPast
  private var heartbeat: DispatchSourceTimer?

  // Both the stream callback and the heartbeat run here, so they never touch
  // lastPixelBuffer/lastFrameAt/wantKeyframe from two threads at once. Stored
  // as a property (not created inline at addStreamOutput) so startHeartbeat
  // can schedule its timer on the exact same queue.
  private let captureQueue = DispatchQueue(label: "tms.capture")

  func start(maxWidth: Int, fps: Int, bitrateKbps: Int) async {
    // Keep the display awake for as long as the session runs. A sleeping
    // display makes ScreenCaptureKit report "no display at all" — remote
    // access would otherwise show nothing exactly when the machine sits
    // unattended. The assertion ends with the process, i.e. with the session.
    var sleepAssertion: IOPMAssertionID = 0
    // The constant is spelled `kIOPMAssertionTypeNoDisplaySleep` in Swift — the
    // longer C spelling ending in "…Assertion" doesn't exist here and breaks
    // the build. Checked against swiftc 6.3.1 beforehand.
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
      // Don't report this as a permission problem: the checkbox is already
      // granted — the display is either asleep or none is attached at all.
      // (Reproduced exactly this way for the asleep case in Task 1's
      // throwaway test.)
      fail("display_asleep", "Kein Bildschirm verfuegbar (eingeschlafen oder nicht angeschlossen)")
    }

    // ScreenCaptureKit's `display.width`/`.height` are logical points, but the
    // captured buffer is `width` pixels wide (capped to maxWidth) — so `scale`
    // is pixels-per-point, not the ratio of two point measurements. Using
    // CGDisplayCopyDisplayMode here (both operands in points) always yields
    // 1.0 and silently breaks pointer mapping in geometry.ts. Verified via
    // real capture: --max-width 1280 on a 1728pt-wide display measures
    // scale ~0.7407; --max-width above the display's pixel width measures 1.0.
    let width = min(maxWidth, display.width)
    let height = Int((Double(display.height) * Double(width) / Double(display.width)).rounded(.down)) & ~1
    let scale = Double(width) / Double(display.width)

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
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
      try await stream.startCapture()
    } catch {
      fail("permission_screen", "Aufnahme konnte nicht gestartet werden")
    }
    self.stream = stream

    emit("{\"ready\":{\"width\":\(width),\"height\":\(height),\"scale\":\(scale)}}")
    startHeartbeat(on: captureQueue)
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

  /// Looks up the last frame again when the screen is still: a requested
  /// keyframe must not wait for the next mouse movement.
  ///
  /// `Timer.scheduledTimer` was tried first and silently never fired: it
  /// attaches to the *calling thread's* run loop, but `start()` runs inside an
  /// async `Task` on a Swift Concurrency worker thread that runs no run loop
  /// of its own. `RunLoop.main.run()` at the bottom of this file doesn't help
  /// either, since the timer was never registered there. `DispatchSourceTimer`
  /// has no such assumption — it fires on the queue it's given regardless of
  /// run loops, which is also why `on: captureQueue` matters here (see the
  /// `captureQueue` property comment above).
  private func startHeartbeat(on queue: DispatchQueue) {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + 0.1, repeating: 0.1)
    t.setEventHandler { [weak self] in
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
    t.resume()
    heartbeat = t
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

// ── Input ───────────────────────────────────────────────────────────────
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

private func warp(to p: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

/// Undoes the escaping from input.darwin.ts in a single pass.
/// Two successive replacements cannot do this: whichever runs first corrupts
/// the input of the second (`C:\neuer` → `C:\` + newline + `euer`).
func unescapeText(_ s: String) -> String {
  var out = ""
  out.reserveCapacity(s.count)
  var it = s.makeIterator()
  while let ch = it.next() {
    guard ch == "\\" else { out.append(ch); continue }
    guard let next = it.next() else { out.append(ch); break }
    out.append(next == "n" ? "\n" : next)
  }
  return out
}

func runInputLoop() {
  // Without the Accessibility grant every event below is silently swallowed —
  // report that instead of pretending to work.
  if !AXIsProcessTrusted() {
    fail("permission_input", "Bedienungshilfen sind nicht freigegeben")
  }
  emit("{\"ready\":{\"input\":true}}")

  let screen = CGDisplayBounds(CGMainDisplayID())
  // Track the pointer position ourselves instead of reading it back from the
  // system after every warp. CGEvent(source: nil)?.location only reflects a
  // just-posted move once the WindowServer has actually processed it, which
  // lags a rapid burst of events by real wall-clock time. Re-querying it as
  // the base for the *next* relative move therefore reads a stale position,
  // so most of a fast swipe's distance silently disappears — measured
  // directly: 10 relative moves of (12,6) posted back-to-back moved the
  // pointer (24,12) instead of (120,60) when read back each time; tracking
  // the position locally instead delivered the full (120,60) every time.
  // (A local mouse nudging the cursor mid-session could desync this from
  // reality, but that is a far smaller risk than silently losing input.)
  var current = CGEvent(source: nil)?.location ?? screen.origin

  while let line = readLine(strippingNewline: true) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    guard let cmd = parts.first else { continue }
    let rest = parts.count > 1 ? parts[1] : ""
    let nums = rest.split(separator: " ").map { Double($0) ?? 0 }

    switch cmd {
    case "rel":
      current = CGPoint(x: min(max(current.x + (nums.first ?? 0), screen.minX), screen.maxX - 1),
                        y: min(max(current.y + (nums.count > 1 ? nums[1] : 0), screen.minY), screen.maxY - 1))
      warp(to: current)
    case "abs":
      current = CGPoint(x: screen.minX + (nums.first ?? 0) * screen.width,
                        y: screen.minY + (nums.count > 1 ? nums[1] : 0) * screen.height)
      warp(to: current)
    case "btn":
      let which = rest.first ?? "l"
      let down = rest.hasSuffix("1")
      let button: CGMouseButton = which == "r" ? .right : which == "m" ? .center : .left
      let type: CGEventType = which == "r"
        ? (down ? .rightMouseDown : .rightMouseUp)
        : which == "m" ? (down ? .otherMouseDown : .otherMouseUp)
        : (down ? .leftMouseDown : .leftMouseUp)
      CGEvent(mouseEventSource: nil, mouseType: type,
              mouseCursorPosition: current, mouseButton: button)?
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
      let text = unescapeText(rest)
      // Feed Unicode directly: independent of the Mac's keyboard layout.
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

// ── Entry point ─────────────────────────────────────────────────────────
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
  runInputLoop()
} else {
  fail("capture_unavailable", "Betriebsart fehlt: --capture oder --input")
}
