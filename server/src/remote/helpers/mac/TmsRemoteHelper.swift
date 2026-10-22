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
import AppKit
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
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
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
  private var lastLockCheckAt = Date.distantPast
  private var lastLockedState: Bool? = nil
  private var heartbeat: DispatchSourceTimer?
  private var cursorTimer: DispatchSourceTimer?

  // Both the stream callback and the heartbeat run here, so they never touch
  // lastPixelBuffer/lastFrameAt/wantKeyframe from two threads at once. Stored
  // as a property (not created inline at addStreamOutput) so startHeartbeat
  // can schedule its timer on the exact same queue.
  private let captureQueue = DispatchQueue(label: "tms.capture")

  func start(maxWidth: Int, fps: Int, bitrateKbps: Int, localCursor: Bool = false) async {
    // I17: wake a sleeping display before anything else. The no-sleep
    // assertion below only prevents FUTURE sleep — it cannot wake a display
    // that is already asleep, which is exactly why the very first session
    // after the Mac's screen went to sleep always failed with
    // `display_asleep` even though the assertion was already in place by
    // then. Declaring user activity is what a real key press or mouse move
    // does; one-shot, no need to keep the assertion ID afterwards (unlike
    // the no-sleep assertion below, which must live for the whole session).
    var activityAssertion: IOPMAssertionID = 0
    IOPMAssertionDeclareUserActivity(
      "TMS Terminal Fernzugriff" as CFString,
      kIOPMUserActiveLocal,
      &activityAssertion)

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

    var content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      fail("permission_screen", "Bildschirmaufnahme ist nicht freigegeben")
    }
    if content.displays.isEmpty {
      // The wake call above needs a brief moment to actually take effect —
      // one short retry before concluding the display is genuinely asleep
      // or disconnected. Only costs time on the failure path; an
      // already-awake Mac never takes this branch.
      try? await Task.sleep(nanoseconds: 400_000_000)
      if let retried = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) {
        content = retried
      }
    }
    let mainID = CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
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
    // With --local-cursor the app draws the pointer itself, instantly, from
    // its own prediction — the pointer in the video trailed every movement by
    // a full network round trip. The real position still comes from here (see
    // startCursorReports). Bonus: pointer-only motion no longer costs frames.
    cfg.showsCursor = !localCursor
    cfg.queueDepth = 3

    // Low-latency rate control (the video-conferencing mode): keeps every
    // single frame near the target size instead of averaging over seconds.
    // Measured on this Mac at 1.5 Mbit/s: keyframes 13-23 KB instead of
    // 82-282 KB (SSIM 0.950 vs 0.961) — a 282 KB keyframe alone took ~1.5 s
    // to cross the link and froze the picture every two seconds. Falls back
    // to the default encoder where the hardware doesn't offer this mode.
    let lowLatency = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] as CFDictionary
    for spec in [lowLatency, nil] as [CFDictionary?] {
      VTCompressionSessionCreate(
        allocator: nil, width: Int32(width), height: Int32(height),
        codecType: kCMVideoCodecType_H264, encoderSpecification: spec,
        imageBufferAttributes: nil, compressedDataAllocator: nil,
        outputCallback: nil, refcon: nil, compressionSessionOut: &session)
      if session != nil { break }
    }
    guard let s = session else { fail("capture_unavailable", "VideoToolbox nicht verfuegbar") }

    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
                         value: kVTProfileLevel_H264_Baseline_AutoLevel)
    // Keyframes come on demand (`keyframe` on stdin: session start, decoder
    // error, recovery after the server dropped frames — see flow.ts). The
    // periodic one is only a safety net; every two seconds, as before, it
    // was the biggest recurring stall on a slow link.
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         value: NSNumber(value: fps * 10))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                         value: NSNumber(value: 10))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate,
                         value: NSNumber(value: bitrateKbps * 1000))
    VTCompressionSessionPrepareToEncodeFrames(s)

    let filter = SCContentFilter(display: display, excludingWindows: [])
    // `delegate: self`, not nil — see `stream(_:didStopWithError:)` below.
    let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
    do {
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
      try await stream.startCapture()
    } catch {
      fail("permission_screen", "Aufnahme konnte nicht gestartet werden")
    }
    self.stream = stream

    emit("{\"ready\":{\"width\":\(width),\"height\":\(height),\"scale\":\(scale)}}")
    startHeartbeat(on: captureQueue)
    if localCursor { startCursorReports(on: captureQueue) }
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

  /// The stream itself reporting it died — a resolution change, the display
  /// going away, or any other capture-pipeline failure ScreenCaptureKit can
  /// name. Without this delegate method wired up (it wasn't: `delegate: nil`
  /// at creation, above), such a stop was invisible to this process: the
  /// heartbeat kept re-encoding whatever frame it had last seen, forever — a
  /// frozen picture with no error, and the trigger the design doc's
  /// "resolution changes" case needed but never had. Exiting here feeds the
  /// exact same path a killed helper already takes: once a session is
  /// running, `capture.darwin.ts`'s `proc.on('exit', ...)` reports
  /// `helper_crashed`, and the existing backoff-restart in remote.socket.ts
  /// (Task 18) rebuilds the session from scratch — and because `start()`
  /// above re-reads the display's current size from scratch too, a genuine
  /// resolution change recovers along with it, not just a hard crash.
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    exit(1)
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
      guard let self else { return }
      if Date().timeIntervalSince(self.lastLockCheckAt) >= 0.8 {
        self.lastLockCheckAt = Date()
        let dict = CGSessionCopyCurrentDictionary() as? [String: Any]
        let locked = (dict?["CGSSessionScreenIsLocked"] as? Bool)
          ?? ((dict?["CGSSessionScreenIsLocked"] as? Int ?? 0) != 0)
        if self.lastLockedState != locked {
          self.lastLockedState = locked
          emit("{\"locked\":\(locked ? "true" : "false")}")
        }
      }
      guard let px = self.lastPixelBuffer else { return }
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

  /// Reports the pointer position (normalized to the main display, like the
  /// `abs` input command) whenever it changed, at most 60 times a second.
  /// The app uses it to correct its locally predicted pointer — e.g. when
  /// something on the Mac moved the pointer by itself.
  private func startCursorReports(on queue: DispatchQueue) {
    var last = CGPoint(x: -1, y: -1)
    var lastEmitAt = Date.distantPast
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: 1.0 / 60.0)
    t.setEventHandler {
      guard let loc = CGEvent(source: nil)?.location else { return }
      let b = CGDisplayBounds(CGMainDisplayID())
      guard b.width > 1, b.height > 1 else { return }
      let spanW = max(1.0, b.width - 1.0)
      let spanH = max(1.0, b.height - 1.0)
      let p = CGPoint(x: min(max((loc.x - b.minX) / spanW, 0), 1),
                      y: min(max((loc.y - b.minY) / spanH, 0), 1))
      let now = Date()
      let moved = abs(p.x - last.x) >= 0.00015 || abs(p.y - last.y) >= 0.00015
      if !moved && now.timeIntervalSince(lastEmitAt) < 0.4 { return }
      last = p
      lastEmitAt = now
      emit(String(format: "{\"cursor\":{\"x\":%.5f,\"y\":%.5f}}", p.x, p.y))
    }
    t.resume()
    cursorTimer = t
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

// ── Modifier state ──────────────────────────────────────────────────────
// Events created with a nil source inherit the WindowServer's current
// modifier flags, and a posted key event *sets* those flags. A hot key's
// key-up still carries ⌃+fn (79/81), and the app releases a modifier key
// with the full chord's mods — both left Control stuck system-wide, so every
// later left click arrived as ⌃-click = right click (measured: combined
// state 0x840000 CTRL+FN while the phone was only tapping).
// The helper therefore owns the modifier state: it tracks which modifier
// keys it holds itself and stamps exactly that onto every event it posts.
private let modifierMasks: [CGKeyCode: CGEventFlags] = [
  54: .maskCommand, 55: .maskCommand, 56: .maskShift, 60: .maskShift,
  58: .maskAlternate, 61: .maskAlternate, 59: .maskControl, 62: .maskControl,
  63: .maskSecondaryFn,
]
private let allModifierMasks: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate,
                                              .maskControl, .maskSecondaryFn, .maskAlphaShift]
/// Modifier keys currently held down by this helper (via `key` commands).
private var heldMods = CGEventFlags()

/// Replaces the inherited modifier bits of `ev` with `mods`.
private func stamp(_ ev: CGEvent, _ mods: CGEventFlags) {
  ev.flags = ev.flags.subtracting(allModifierMasks).union(mods)
}

/// Sets the system-wide modifier state back to what the helper holds, if
/// something left it different. A Control key-up carrying the wanted flags is
/// enough: the WindowServer adopts the flags of each posted flagsChanged event.
/// `posted` = flags of the event just posted — the WindowServer applies events
/// asynchronously, so reading the live state right after posting would race.
private func resetModifierState(posted: CGEventFlags? = nil) {
  let state = (posted ?? CGEventSource.flagsState(.combinedSessionState)).intersection(allModifierMasks)
  guard state != heldMods.intersection(allModifierMasks) else { return }
  guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: 59, keyDown: false) else { return }
  ev.flags = heldMods
  ev.post(tap: .cghidEventTap)
}

// ── System gestures (Mission Control, Spaces, Spotlight) ───────────────
// Private CoreGraphics/SkyLight calls behind System Settings' keyboard
// shortcuts. Just posting ⌃→ is not enough: those shortcuts can be switched
// off (on the dev Mac "move one space" and Mission Control are), and then
// the key press does nothing. Instead the helper reads the configured key
// straight from the WindowServer, enables the shortcut for the moment of the
// press if needed and restores it afterwards — System Settings stay as they
// were (verified: switching spaces 166 → 4 → 166 left `enabled = 0` intact).
@_silgen_name("CGSGetSymbolicHotKeyValue")
private func CGSGetSymbolicHotKeyValue(_ hotKey: Int32, _ keyEquivalent: UnsafeMutablePointer<UInt16>,
                                       _ virtualKeyCode: UnsafeMutablePointer<UInt16>,
                                       _ modifiers: UnsafeMutablePointer<UInt32>) -> Int32
@_silgen_name("CGSIsSymbolicHotKeyEnabled")
private func CGSIsSymbolicHotKeyEnabled(_ hotKey: Int32) -> Bool
@_silgen_name("CGSSetSymbolicHotKeyEnabled")
private func CGSSetSymbolicHotKeyEnabled(_ hotKey: Int32, _ enabled: Bool) -> Int32

/// Checks whether Mission Control ("Spaces Bar" / "ExposeShieldWindow") is
/// currently open on screen. Checks both window names and WindowManager's
/// dedicated Expose layers (19 = ExposeShieldWindow, 14 = Spaces Bar) so it
/// works even without Screen Recording window-name access.
private func isMissionControlOpen() -> Bool {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
    return false
  }
  return list.contains {
    let name = ($0[kCGWindowName as String] as? String) ?? ""
    if name == "ExposeShieldWindow" || name == "Spaces Bar" { return true }
    let owner = ($0[kCGWindowOwnerName as String] as? String) ?? ""
    let layer = ($0[kCGWindowLayer as String] as? Int) ?? 0
    return owner == "WindowManager" && (layer == 19 || layer == 14)
  }
}

private func postSymbolicHotKey(_ id: Int32) {
  var equiv: UInt16 = 0, code: UInt16 = 0, mods: UInt32 = 0
  guard CGSGetSymbolicHotKeyValue(id, &equiv, &code, &mods) == 0 else { return }
  // The hot key's own key-up carries its modifiers (⌃+fn) into the system state.
  defer { resetModifierState(posted: CGEventFlags(rawValue: UInt64(mods))) }
  if !CGSIsSymbolicHotKeyEnabled(id) {
    _ = CGSSetSymbolicHotKeyEnabled(id, true)
    usleep(30_000)
  }
  let flags = CGEventFlags(rawValue: UInt64(mods))
  for down in [true, false] {
    let ev = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down)
    ev?.flags = flags
    ev?.post(tap: .cghidEventTap)
    if down { usleep(15_000) }
  }
}

/// Fires one symbolic hot key (32 Mission Control, 33 App windows, 36 Show
/// Desktop, 64 Spotlight, 79/81 move a space left/right).
///
/// On macOS 15 (WindowManager / Stage Manager):
/// 1. Disabling the symbolic hot key 250 ms after posting races WindowManager's
///    asynchronous SystemHotKeyEventMonitor and aborts the ~800 ms space slide,
///    so gesture hot keys stay enabled once activated.
/// 2. While Mission Control ("Spaces Bar") is open, 79/81 only moves the
///    highlight inside the top overview bar without leaving Mission Control.
///    When Mission Control is open during a space switch (79/81), we first
///    close Mission Control (32) and then fire the space switch (79/81) so
///    the user lands directly in the target workspace. Swiping down (33) while
///    Mission Control is open also closes Mission Control, matching a real trackpad.
private func triggerSymbolicHotKey(_ id: Int32) {
  let mcOpen = isMissionControlOpen()
  if id == 33 && mcOpen {
    postSymbolicHotKey(32)
    return
  }
  if (id == 79 || id == 81) && mcOpen {
    postSymbolicHotKey(32)
    usleep(500_000)
  }
  postSymbolicHotKey(id)
}


/// Which mouse buttons are currently held (set by the `btn` command).
private var heldButtons = Set<CGMouseButton>()

/// Move the pointer. While a button is held this MUST be a *Dragged event:
/// macOS apps only recognize a drag (moving windows, drag-and-drop, text
/// selection) from leftMouseDragged/rightMouseDragged — a plain mouseMoved
/// with the button down moved the pointer but nothing ever got dragged.
private func warp(to p: CGPoint, dx: Double = 0, dy: Double = 0) {
  let (type, button): (CGEventType, CGMouseButton) =
    heldButtons.contains(.left) ? (.leftMouseDragged, .left)
    : heldButtons.contains(.right) ? (.rightMouseDragged, .right)
    : heldButtons.contains(.center) ? (.otherMouseDragged, .center)
    : (.mouseMoved, .left)
  // After a drag the next press starts a new click series (like macOS): keep the
  // count for the matching button-up, but let the double-click window lapse.
  if type != .mouseMoved, let l = lastPress { lastPress = (l.button, l.at, -1_000, l.count) }
  if let ev = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) {
    ev.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
    ev.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
    stamp(ev, heldMods)
    ev.post(tap: .cghidEventTap)
  }
}

/// Click counting for double/triple clicks. Synthetic events always carried
/// clickState 1, so macOS never saw a double-click (open a file, select a
/// word). A press counts up when it follows the previous press of the same
/// button quickly and close by — the system's own double-click rules.
private var lastPress: (button: CGMouseButton, at: CGPoint, time: TimeInterval, count: Int64)?
private func clickCount(for button: CGMouseButton, at p: CGPoint) -> Int64 {
  let now = ProcessInfo.processInfo.systemUptime
  if let l = lastPress, l.button == button, now - l.time <= NSEvent.doubleClickInterval,
     abs(l.at.x - p.x) <= 6, abs(l.at.y - p.y) <= 6 {
    lastPress = (button, p, now, l.count + 1)
  } else {
    lastPress = (button, p, now, 1)
  }
  return lastPress!.count
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
  for hkId: Int32 in [32, 33, 36, 64, 79, 80, 81, 82] {
    _ = CGSSetSymbolicHotKeyEnabled(hkId, true)
  }
  // A previous session (or helper version) may have left a modifier stuck.
  resetModifierState()
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
  // …but only while a burst is running. After a pause the WindowServer has long
  // caught up, and the real position is the truth: someone may have moved the
  // Mac's own mouse/trackpad in between. Without this re-read the next swipe
  // on the phone snapped the pointer back to where the helper last left it,
  // while the app continued from the real position — pointer drawn in one
  // place, clicks landing in another (reproduced: 120 pt off, permanently).
  var lastWarpAt = Date.distantPast
  func resyncIfIdle() {
    if Date().timeIntervalSince(lastWarpAt) > 0.15, let real = CGEvent(source: nil)?.location {
      current = real
    }
  }
  func syncIfIdle() { resyncIfIdle(); lastWarpAt = Date() }

  while let line = readLine(strippingNewline: true) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    guard let cmd = parts.first else { continue }
    let rest = parts.count > 1 ? parts[1] : ""
    let nums = rest.split(separator: " ").map { Double($0) ?? 0 }

    switch cmd {
    case "rel":
      syncIfIdle()
      let prev = current
      current = CGPoint(x: min(max(current.x + (nums.first ?? 0), screen.minX), screen.maxX - 1),
                        y: min(max(current.y + (nums.count > 1 ? nums[1] : 0), screen.minY), screen.maxY - 1))
      warp(to: current, dx: current.x - prev.x, dy: current.y - prev.y)
    case "abs":
      lastWarpAt = Date()
      let prev = current
      let spanW = max(1.0, screen.width - 1.0)
      let spanH = max(1.0, screen.height - 1.0)
      current = CGPoint(x: min(max(screen.minX + (nums.first ?? 0) * spanW, screen.minX), screen.maxX - 1),
                        y: min(max(screen.minY + (nums.count > 1 ? nums[1] : 0) * spanH, screen.minY), screen.maxY - 1))
      warp(to: current, dx: current.x - prev.x, dy: current.y - prev.y)
    case "btn":
      // A tap after the Mac's own mouse moved must click where the pointer IS.
      resyncIfIdle()
      let which = rest.first ?? "l"
      let down = rest.hasSuffix("1")
      let button: CGMouseButton = which == "r" ? .right : which == "m" ? .center : .left
      let type: CGEventType = which == "r"
        ? (down ? .rightMouseDown : .rightMouseUp)
        : which == "m" ? (down ? .otherMouseDown : .otherMouseUp)
        : (down ? .leftMouseDown : .leftMouseUp)
      // Down counts the click; up repeats the same count (that pair is a click).
      let count: Int64 = down ? clickCount(for: button, at: current)
        : (lastPress?.button == button ? lastPress!.count : 1)
      if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
      if let ev = CGEvent(mouseEventSource: nil, mouseType: type,
                          mouseCursorPosition: current, mouseButton: button) {
        ev.setIntegerValueField(.mouseEventClickState, value: count)
        stamp(ev, heldMods)
        ev.post(tap: .cghidEventTap)
      }
    case "scroll":
      if let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                          wheel1: Int32(nums.count > 1 ? nums[1] : 0),
                          wheel2: Int32(nums.first ?? 0), wheel3: 0) {
        stamp(ev, heldMods)
        ev.post(tap: .cghidEventTap)
      }
    case "key":
      guard nums.count >= 3 else { break }
      let code = CGKeyCode(nums[0]), down = nums[1] == 1
      guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { break }
      if let mask = modifierMasks[code] {
        // A modifier key's own event carries what is held AFTER it — the app
        // sends its release with the whole chord's mods, which kept it stuck.
        if down { heldMods.insert(mask) } else { heldMods.remove(mask) }
        stamp(ev, heldMods)
        ev.post(tap: .cghidEventTap)
      } else {
        stamp(ev, flags(Int(nums[2])).union(heldMods))
        ev.post(tap: .cghidEventTap)
        // A chord sent without separate modifier presses must not linger.
        if !down { resetModifierState(posted: ev.flags) }
      }
    case "text":
      let text = unescapeText(rest)
      // Feed Unicode directly: independent of the Mac's keyboard layout.
      for chunk in text.unicodeScalars.map({ UniChar($0.value) }) {
        var c = chunk
        for down in [true, false] {
          guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
          ev.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
          stamp(ev, heldMods)
          ev.post(tap: .cghidEventTap)
        }
      }
    case "hotkey":
      if let id = Int32(rest.trimmingCharacters(in: .whitespaces)) { triggerSymbolicHotKey(id) }
    case "quit":
      exit(0)
    default:
      break
    }
  }
}

// ── Clipboard sync (--clipboard) ────────────────────────────────────────
// Shared clipboard between phone and Mac: reports every new text on the Mac's
// pasteboard as {"clip":{"text":…}} and takes {"set":"…"} lines on stdin to
// put text there. Polling changeCount is the only way — NSPasteboard has no
// change notification — and it costs nothing (an integer read, twice a second).
//
// Never reported: what password managers mark as secret or short-lived
// (nspasteboard.org convention: 1Password, Bitwarden, Apple Passwords, …), and
// what we put there ourselves (no echo back into the history).
private let skipTypes: Set<String> = [
  "org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType",
  "org.nspasteboard.AutoGeneratedType", "com.agilebits.onepassword",
]
private let maxClipChars = 100_000

func runClipboardLoop() {
  let pb = NSPasteboard.general
  var seen = pb.changeCount
  emit("{\"ready\":{\"clipboard\":true}}")

  func report(_ text: String) {
    let payload: [String: Any] = ["clip": ["text": text]]
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let line = String(data: data, encoding: .utf8) { emit(line) }
  }

  // stdin: one JSON object per line. EOF (server gone) ends the helper.
  DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
      guard let data = line.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let text = obj["set"] as? String else { continue }
      DispatchQueue.main.async {
        pb.clearContents()
        pb.setString(text, forType: .string)
        seen = pb.changeCount           // our own write: don't report it back
      }
    }
    exit(0)
  }

  let t = Timer(timeInterval: 0.5, repeats: true) { _ in
    let count = pb.changeCount
    if count == seen { return }
    seen = count
    let types = Set((pb.types ?? []).map { $0.rawValue })
    if !types.isDisjoint(with: skipTypes) { return }
    guard let text = pb.string(forType: .string),
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          text.count <= maxClipChars else { return }
    report(text)
  }
  RunLoop.main.add(t, forMode: .common)
  RunLoop.main.run()
}

import Carbon

// ── Biometric Mac Unlock (--unlock) ─────────────────────────────────────
// macOS loginwindow (Lock Screen) ignores synthetic Unicode overrides on
// virtualKey 0 (treating every char as 'a'). We therefore map each character
// to its real hardware CGKeyCode + Shift/Option modifiers using the active
// macOS keyboard layout (UCKeyTranslate) and verify via CGSessionCopyCurrentDictionary
// that the lock screen actually unlocked.
private func isMacScreenLocked() -> Bool {
  let dict = CGSessionCopyCurrentDictionary() as? [String: Any]
  return (dict?["CGSSessionScreenIsLocked"] as? Bool)
    ?? ((dict?["CGSSessionScreenIsLocked"] as? Int ?? 0) != 0)
}

private func buildCharKeyMap() -> [Character: (code: CGKeyCode, shift: Bool, option: Bool)] {
  var map: [Character: (CGKeyCode, Bool, Bool)] = [:]
  guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else {
    return map
  }
  let data = unsafeBitCast(ptr, to: CFData.self)
  guard let bytes = CFDataGetBytePtr(data) else { return map }
  let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
  let kbdType = UInt32(LMGetKbdType())
  let mainKeyCodes = (UInt16(0)..<53)
  let modCombos: [(UInt32, Bool, Bool)] = [
    (0, false, false),
    (UInt32(shiftKey >> 8), true, false),
    (UInt32(optionKey >> 8), false, true),
    (UInt32((shiftKey | optionKey) >> 8), true, true),
  ]
  for (modState, isShift, isOpt) in modCombos {
    for code in mainKeyCodes {
      var deadKeyState: UInt32 = 0
      var chars = [UniChar](repeating: 0, count: 4)
      var length: Int = 0
      let status = UCKeyTranslate(
        layout, code, UInt16(kUCKeyActionDown), modState, kbdType,
        UInt32(kUCKeyTranslateNoDeadKeysMask), &deadKeyState, 4, &length, &chars
      )
      if status == noErr && length == 1, let scalar = UnicodeScalar(chars[0]) {
        let ch = Character(scalar)
        if map[ch] == nil {
          map[ch] = (CGKeyCode(code), isShift, isOpt)
        }
      }
    }
  }
  return map
}

private func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
  guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { return }
  ev.flags = flags
  ev.post(tap: .cghidEventTap)
}

private func typePasswordOnce(_ pw: String, charMap: [Character: (code: CGKeyCode, shift: Bool, option: Bool)]) {
  // Clear any stray characters in the password box using plain Backspace (virtualKey 51)
  for _ in 0..<24 {
    postKey(51, down: true)
    postKey(51, down: false)
    usleep(4_000)
  }
  usleep(40_000)

  for ch in pw {
    if let mapped = charMap[ch] {
      var f = CGEventFlags()
      if mapped.shift  { f.insert(.maskShift) }
      if mapped.option { f.insert(.maskAlternate) }

      if mapped.shift {
        postKey(56, down: true, flags: .maskShift)
        usleep(8_000)
      }
      if mapped.option {
        postKey(58, down: true, flags: f)
        usleep(8_000)
      }

      postKey(mapped.code, down: true, flags: f)
      usleep(12_000)
      postKey(mapped.code, down: false, flags: f)
      usleep(12_000)

      if mapped.option {
        postKey(58, down: false, flags: mapped.shift ? .maskShift : [])
        usleep(8_000)
      }
      if mapped.shift {
        postKey(56, down: false, flags: [])
        usleep(8_000)
      }
      usleep(16_000)
    } else {
      // Fallback for non-mapped Unicode characters
      for scalar in String(ch).unicodeScalars {
        var u = UniChar(scalar.value)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        down?.post(tap: .cghidEventTap)
        usleep(10_000)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        up?.post(tap: .cghidEventTap)
        usleep(14_000)
      }
    }
  }

  usleep(70_000)
  // Press Return (virtualKey 36)
  postKey(36, down: true)
  usleep(20_000)
  postKey(36, down: false)
}

func runUnlock() {
  if !AXIsProcessTrusted() {
    fail("permission_input", "Bedienungshilfen sind nicht freigegeben")
  }
  guard let pw = readLine(strippingNewline: true), !pw.isEmpty else {
    fail("unlock_empty", "Kein Passwort empfangen")
  }

  var activityAssertion: IOPMAssertionID = 0
  IOPMAssertionDeclareUserActivity(
    "TMS Terminal Fingerabdruck-Entsperrung" as CFString,
    kIOPMUserActiveLocal,
    &activityAssertion)

  let wasLocked = isMacScreenLocked()
  let charMap = buildCharKeyMap()

  // Give display / loginwindow a brief moment to wake
  usleep(150_000)

  typePasswordOnce(pw, charMap: charMap)

  if !wasLocked {
    // Used for SecurityAgent dialog when screen was already unlocked
    usleep(50_000)
    exit(0)
  }

  // Wait up to 1.8s for loginwindow to unlock
  for _ in 0..<18 {
    usleep(100_000)
    if !isMacScreenLocked() {
      exit(0)
    }
  }

  // Second attempt: if the lock screen password field was collapsed ("Touch ID oder Passwort eingeben"),
  // send Return first to open/focus the password capsule, wait 350ms, then type again.
  postKey(36, down: true)
  usleep(20_000)
  postKey(36, down: false)
  usleep(350_000)

  typePasswordOnce(pw, charMap: charMap)

  for _ in 0..<22 {
    usleep(100_000)
    if !isMacScreenLocked() {
      exit(0)
    }
  }

  fail("unlock_failed", "Sperrbildschirm blieb gesperrt — bitte einmal auf das Passwortfeld tippen oder Passwort prüfen")
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
                  bitrateKbps: intArg("--bitrate", 1500),
                  localCursor: args.contains("--local-cursor"))
  }
  RunLoop.main.run()
} else if args.contains("--input") {
  runInputLoop()
} else if args.contains("--clipboard") {
  runClipboardLoop()
} else if args.contains("--unlock") {
  runUnlock()
} else {
  fail("capture_unavailable", "Betriebsart fehlt: --capture, --input oder --unlock")
}
