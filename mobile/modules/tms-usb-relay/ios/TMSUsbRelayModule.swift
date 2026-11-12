import ExpoModulesCore
import UIKit
import Network

/// DeX cable monitor, iPad side.
///
/// The Fold (USB host) speaks Apple's usbmux protocol and opens TCP streams to this device's
/// loopback port 8769 — no network interface is involved. We collect those streams in a pool.
/// The app itself (RN fetch + WebView WebSocket) talks to 127.0.0.1:8768; every such local
/// connection is spliced 1:1 onto one pooled Fold stream, which the Fold in turn splices onto its
/// DeX server. For the JS side the Fold therefore simply appears at 127.0.0.1:8768.
public class TMSUsbRelayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TMSUsbRelay")

    Function("start") { () -> Bool in
      UsbRelay.shared.start()
      return true
    }

    Function("status") { () -> [String: Any] in
      UsbRelay.shared.status()
    }

    Events("onDexInput")

    /// DeX monitor on/off: native capture of keyboard, trackpad hover and trackpad scrolling,
    /// plus hidden home indicator / deferred edge gestures. WKWebView never sees hardware keys
    /// (without a focused text field), trackpad hover or indirect scrolling, so this has to be
    /// native. Events go to JS as `onDexInput` and from there into the remote session.
    AsyncFunction("setDexInput") { (enabled: Bool) in
      DexInputCapture.shared.emit = { [weak self] ev in self?.sendEvent("onDexInput", ev) }
      DexInputCapture.shared.setEnabled(enabled)
    }.runOnQueue(.main)

    OnAppEntersForeground {
      // iOS tears down listening sockets while the app is suspended (screen locked) without the
      // listener ever reporting .failed — rebuild them, or the Fold's dials stay refused.
      UsbRelay.shared.restart()
    }
  }
}

// MARK: - DeX input capture

final class DexInputCapture: NSObject, UIGestureRecognizerDelegate {
  static let shared = DexInputCapture()

  var emit: (([String: Any]) -> Void)?
  private(set) var enabled = false
  private var hover: UIHoverGestureRecognizer?
  private var scroll: UIPanGestureRecognizer?
  private var lastScroll = CGPoint.zero
  private var pendingHover: CGPoint?
  private var hoverTimer: Timer?

  func setEnabled(_ on: Bool) {
    guard on != enabled else { return }
    enabled = on
    UIApplication.swizzlePressesForDex()
    guard let window = Self.keyWindow() else { return }
    if on {
      let h = UIHoverGestureRecognizer(target: self, action: #selector(onHover(_:)))
      h.delegate = self
      h.cancelsTouchesInView = false
      window.addGestureRecognizer(h)
      hover = h

      // Indirect scrolling only (trackpad two-finger, mouse wheel); finger touches stay with the page.
      let p = UIPanGestureRecognizer(target: self, action: #selector(onScroll(_:)))
      p.allowedScrollTypesMask = .all
      p.allowedTouchTypes = []
      p.delegate = self
      p.cancelsTouchesInView = false
      window.addGestureRecognizer(p)
      scroll = p

      hoverTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
        guard let self = self, let pt = self.pendingHover else { return }
        self.pendingHover = nil
        self.emit?(["t": "hover", "x": Double(pt.x), "y": Double(pt.y)])
      }
    } else {
      if let h = hover { window.removeGestureRecognizer(h) }
      if let p = scroll { window.removeGestureRecognizer(p) }
      hover = nil
      scroll = nil
      hoverTimer?.invalidate()
      hoverTimer = nil
    }
    DexChrome.apply(hidden: on, window: window)
  }

  @objc private func onHover(_ g: UIHoverGestureRecognizer) {
    guard enabled, let v = g.view else { return }
    pendingHover = g.location(in: v)
  }

  @objc private func onScroll(_ g: UIPanGestureRecognizer) {
    guard enabled, let v = g.view else { return }
    let t = g.translation(in: v)
    switch g.state {
    case .began:
      lastScroll = t
    case .changed:
      let dx = t.x - lastScroll.x, dy = t.y - lastScroll.y
      lastScroll = t
      // Server divides by 40 (same scale as the web wheel handler's deltaY / 20).
      if abs(dx) >= 0.5 || abs(dy) >= 0.5 {
        emit?(["t": "s", "dx": Int((dx * 2).rounded()), "dy": Int((dy * 2).rounded())])
      }
    default:
      lastScroll = .zero
    }
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }

  /// Hardware key → remote input. Printable text without shortcut modifiers goes as text
  /// (respects the iPad's keyboard layout, e.g. German Z/Y), everything else as a key code.
  /// Returns true when the press was consumed.
  func handle(press: UIPress, down: Bool) -> Bool {
    guard enabled, let key = press.key else { return false }
    let f = key.modifierFlags
    let mods: [String: Bool] = [
      "s": f.contains(.shift), "c": f.contains(.control),
      "a": f.contains(.alternate), "m": f.contains(.command),
    ]
    let code = Self.domCode(key.keyCode)
    let chars = key.characters
    let shortcut = f.contains(.control) || f.contains(.command)
    let isPrintable = !chars.isEmpty && chars.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7F }
      && code != "Enter" && code != "Tab" && code != "Backspace"
    if isPrintable && !shortcut && code != "Space" {
      if down { emit?(["t": "x", "s": chars]) }
      return true
    }
    guard let c = code else { return true }
    emit?(["t": "k", "c": c, "d": down, "mods": mods])
    return true
  }

  static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow } ?? UIApplication.shared.windows.first
  }

  /// UIKeyboardHIDUsage → KeyboardEvent.code names (what the Fold server maps to Android keys).
  static func domCode(_ k: UIKeyboardHIDUsage) -> String? {
    let v = k.rawValue
    switch v {
    case 0x04...0x1D: return "Key" + String(UnicodeScalar(UInt8(65 + v - 0x04)))
    case 0x1E...0x26: return "Digit\(v - 0x1D)"
    case 0x27: return "Digit0"
    case 0x3A...0x45: return "F\(v - 0x39)"
    default: break
    }
    let table: [Int: String] = [
      0x28: "Enter", 0x29: "Escape", 0x2A: "Backspace", 0x2B: "Tab", 0x2C: "Space",
      0x2D: "Minus", 0x2E: "Equal", 0x2F: "BracketLeft", 0x30: "BracketRight", 0x31: "Backslash",
      0x33: "Semicolon", 0x34: "Quote", 0x35: "Backquote", 0x36: "Comma", 0x37: "Period",
      0x38: "Slash", 0x39: "CapsLock", 0x49: "Insert", 0x4A: "Home", 0x4B: "PageUp",
      0x4C: "Delete", 0x4D: "End", 0x4E: "PageDown", 0x4F: "ArrowRight", 0x50: "ArrowLeft",
      0x51: "ArrowDown", 0x52: "ArrowUp", 0x64: "IntlBackslash",
      0xE0: "ControlLeft", 0xE1: "ShiftLeft", 0xE2: "AltLeft", 0xE3: "MetaLeft",
      0xE4: "ControlRight", 0xE5: "ShiftRight", 0xE6: "AltRight", 0xE7: "MetaRight",
    ]
    return table[v]
  }
}

// MARK: - presses: swallow hardware keys while the DeX monitor runs

extension UIApplication {
  private static var dexSwizzled = false

  static func swizzlePressesForDex() {
    guard !dexSwizzled else { return }
    dexSwizzled = true
    guard let orig = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.sendEvent(_:))),
          let repl = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.tms_dexSendEvent(_:)))
    else { return }
    method_exchangeImplementations(orig, repl)
  }

  @objc func tms_dexSendEvent(_ event: UIEvent) {
    if DexInputCapture.shared.enabled, let pe = event as? UIPressesEvent {
      var consumed = false
      for press in pe.allPresses {
        switch press.phase {
        case .began: consumed = DexInputCapture.shared.handle(press: press, down: true) || consumed
        case .ended, .cancelled: consumed = DexInputCapture.shared.handle(press: press, down: false) || consumed
        default: consumed = consumed || press.key != nil
        }
      }
      if consumed { return }
    }
    tms_dexSendEvent(event)  // swizzled: calls the original sendEvent
  }
}

// MARK: - full screen chrome (home indicator, edge gestures)

enum DexChrome {
  static var hidden = false

  /// Swaps the root view controller's class for a subclass that hides the home indicator and
  /// defers system edge gestures (a stray swipe needs a second swipe). Status bar is handled in JS.
  static func apply(hidden on: Bool, window: UIWindow) {
    hidden = on
    guard let vc = window.rootViewController else { return }
    if on, type(of: vc) == UIViewController.self {
      object_setClass(vc, DexRootViewController.self)
    }
    vc.setNeedsUpdateOfHomeIndicatorAutoHidden()
    vc.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
  }
}

final class DexRootViewController: UIViewController {
  override var prefersHomeIndicatorAutoHidden: Bool { DexChrome.hidden }
  override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { DexChrome.hidden ? .all : [] }
}

final class UsbRelay {
  static let shared = UsbRelay()

  static let foldPort: UInt16 = 8769
  static let localPort: UInt16 = 8768

  private let queue = DispatchQueue(label: "com.tms.terminal.usbrelay")
  private var foldListener: NWListener?
  private var localListener: NWListener?
  private var pool: [NWConnection] = []
  private var activePairs = 0
  private var lastFoldSeen: Date?

  func start() {
    queue.async { self.ensureListeners() }
  }

  func restart() {
    queue.async {
      self.foldListener?.cancel()
      self.localListener?.cancel()
      self.foldListener = nil
      self.localListener = nil
      self.pool.forEach { $0.cancel() }
      self.pool.removeAll()
      self.ensureListeners()
    }
  }

  func status() -> [String: Any] {
    queue.sync {
      [
        "listening": foldListener != nil && localListener != nil,
        "idleStreams": pool.count,
        "activeStreams": activePairs,
        "foldSeenAgoMs": lastFoldSeen.map { Int(Date().timeIntervalSince($0) * 1000) } ?? -1,
      ]
    }
  }

  // MARK: listeners

  private func ensureListeners() {
    if foldListener == nil {
      foldListener = makeListener(port: Self.foldPort) { [weak self] conn in self?.acceptFold(conn) }
    }
    if localListener == nil {
      localListener = makeListener(port: Self.localPort) { [weak self] conn in self?.acceptLocal(conn) }
    }
  }

  private func makeListener(port: UInt16, onConnection: @escaping (NWConnection) -> Void) -> NWListener? {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    guard let listener = try? NWListener(using: params) else { return nil }
    listener.newConnectionHandler = onConnection
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      guard let self = self else { return }
      switch state {
      case .failed, .cancelled:
        // Typically after the app was suspended: drop and rebuild on the next start().
        if self.foldListener === listener { self.foldListener = nil }
        if self.localListener === listener { self.localListener = nil }
        self.queue.asyncAfter(deadline: .now() + 1) { self.ensureListeners() }
      default:
        break
      }
    }
    listener.start(queue: queue)
    return listener
  }

  // MARK: Fold streams (usbmux → 127.0.0.1:8769)

  private func acceptFold(_ conn: NWConnection) {
    lastFoldSeen = Date()
    conn.stateUpdateHandler = { [weak self, weak conn] state in
      guard let self = self, let conn = conn else { return }
      switch state {
      case .ready:
        self.pool.append(conn)
      case .failed, .cancelled:
        self.pool.removeAll { $0 === conn }
      default:
        break
      }
    }
    conn.start(queue: queue)
  }

  // MARK: local clients (app → 127.0.0.1:8768)

  private func acceptLocal(_ local: NWConnection) {
    guard !pool.isEmpty else {
      // No Fold on the cable: refuse fast so discovery probes fail immediately.
      local.cancel()
      return
    }
    let fold = pool.removeFirst()
    activePairs += 1
    var closed = false
    let closeBoth = { [weak self] in
      guard !closed else { return }
      closed = true
      self?.activePairs -= 1
      local.cancel()
      fold.cancel()
    }
    local.stateUpdateHandler = { state in
      switch state {
      case .ready:
        self.pump(from: local, to: fold, onClose: closeBoth)
        self.pump(from: fold, to: local, onClose: closeBoth)
      case .failed, .cancelled:
        closeBoth()
      default:
        break
      }
    }
    fold.stateUpdateHandler = { state in
      if case .failed = state { closeBoth() }
      if case .cancelled = state { closeBoth() }
    }
    local.start(queue: queue)
  }

  /// Copies bytes one way; the next receive only starts once the send was processed (back-pressure).
  private func pump(from: NWConnection, to: NWConnection, onClose: @escaping () -> Void) {
    from.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
      if let data = data, !data.isEmpty {
        to.send(content: data, completion: .contentProcessed { sendError in
          if sendError != nil || isComplete {
            onClose()
          } else {
            self?.pump(from: from, to: to, onClose: onClose)
          }
        })
        return
      }
      if isComplete || error != nil {
        onClose()
      } else {
        self?.pump(from: from, to: to, onClose: onClose)
      }
    }
  }
}
