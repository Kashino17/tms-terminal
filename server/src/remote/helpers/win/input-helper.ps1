# TMS Terminal — input helper for Windows.
#
# Stays alive and reads commands from stdin: spawning a process per keystroke
# would cost 50-100 ms and wreck the whole latency budget. Add-Type compiles the
# C# once at startup using in-box tooling — nothing to install.
#
# The read loop itself runs in C# (TmsInput.Run), not in PowerShell: the
# interpreted loop paid string splitting, casts and a switch per line, for
# every one of the ~60-120 pointer events a second — the pointer trailed the
# finger. C# 5 only (Windows PowerShell 5.1's Add-Type compiler).

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

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
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

  const uint MOUSE = 0, KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;
  // Without this flag, ABSOLUTE coordinates map to the primary monitor only —
  // on a multi-monitor box that is not necessarily the one ddagrab (output_idx=0)
  // is capturing, so the pointer would land on the wrong screen.
  const uint VIRTUALDESK = 0x4000;

  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }

  public static void MoveAbsolute(int x, int y) {
    INPUT i = new INPUT(); i.type = MOUSE;
    i.mi.dx = x; i.mi.dy = y; i.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK; Send(i);
  }
  // A relative SendInput is a "mickey" count: Windows runs it through the
  // pointer speed slider and "Enhance pointer precision", so the pointer
  // went a different distance than the app predicted (it draws the pointer
  // itself and corrects to the real position afterwards — a visible jump).
  // Instead: read the real position, add exactly dx/dy physical pixels, and
  // place it there absolutely. Same idea as the macOS helper's "rel".
  public static void MoveRelative(int dx, int dy) {
    POINT p;
    if (!GetCursorPos(out p)) return;
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = Math.Max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN)), vh = Math.Max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
    int x = Math.Min(vx + vw - 1, Math.Max(vx, p.X + dx));
    int y = Math.Min(vy + vh - 1, Math.Max(vy, p.Y + dy));
    INPUT i = new INPUT(); i.type = MOUSE;
    i.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    i.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    i.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK; Send(i);
  }
  public static void Button(string which, bool down) {
    INPUT i = new INPUT(); i.type = MOUSE;
    if (which == "r") i.mi.dwFlags = down ? RDOWN : RUP;
    else if (which == "m") i.mi.dwFlags = down ? MDOWN : MUP;
    else i.mi.dwFlags = down ? LDOWN : LUP;
    Send(i);
  }
  // I9: the wire protocol's {t:'s'} dx/dy are pixels — that is what the
  // macOS backend feeds straight into CGEvent's .pixel-unit scroll wheel
  // event, and the bridge's gesture math is calibrated against that. WHEEL
  // (and HWHEEL) instead expect multiples of WHEEL_DELTA (120 = one notch),
  // and the previous "dy * 120" treated every wire pixel as a full notch —
  // the same swipe scrolled roughly 120x further on Windows than on macOS.
  // Windows' own Precision Touchpad driver sends exactly this kind of small,
  // sub-120 mouseData for smooth scrolling (accumulated by the recipient
  // into full lines), so passing the pixel delta straight through is not
  // just "no multiplier" but the same idiom Windows itself already uses for
  // fine-grained wheel input. Shared wire unit is documented on
  // RemoteInputEvent in shared/protocol.ts.
  public static void Scroll(int dx, int dy) {
    if (dy != 0) { INPUT i = new INPUT(); i.type = MOUSE;
      i.mi.mouseData = unchecked((uint)dy); i.mi.dwFlags = WHEEL; Send(i); }
    if (dx != 0) { INPUT i = new INPUT(); i.type = MOUSE;
      i.mi.mouseData = unchecked((uint)dx); i.mi.dwFlags = HWHEEL; Send(i); }
  }
  public static void Key(ushort vk, bool down) {
    INPUT i = new INPUT(); i.type = KEYBOARD;
    i.ki.wVk = vk; i.ki.dwFlags = down ? 0 : KEYUP; Send(i);
  }
  // Unicode directly: independent of the target machine's keyboard layout.
  public static void Text(string s) {
    foreach (char c in s) {
      INPUT d = new INPUT(); d.type = KEYBOARD; d.ki.wScan = c; d.ki.dwFlags = UNICODE; Send(d);
      INPUT u = new INPUT(); u.type = KEYBOARD; u.ki.wScan = c; u.ki.dwFlags = UNICODE | KEYUP; Send(u);
    }
  }

  // I10: single-pass scan, matching the macOS helper's unescapeText exactly
  // (TmsRemoteHelper.swift) — and NOT the two sequential Replace() calls
  // this file used to have. Two sequential replacements cannot correctly
  // invert input.win32.ts's escaping (\ -> \\, then \n -> literal "\n") in
  // EITHER order: replacing "\\n" -> newline first turns a literal
  // "C:\neuer Ordner" (escaped as "C:\\neuer Ordner" on the wire) into
  // "C:\" + newline + "euer Ordner", because the still-doubled backslash's
  // second character is 'n'; de-doubling backslashes first before that
  // makes the very same "\\n" match the "\n" pattern next regardless of
  // order. Only walking the string once, consuming a backslash together
  // with exactly the character that follows it, is unambiguous. This is a
  // straight port of the Swift fix — Task 7's fix round found the identical
  // bug on macOS first.
  public static string Unescape(string s) {
    StringBuilder sb = new StringBuilder(s.Length);
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '\\' && i + 1 < s.Length) {
        i++;
        sb.Append(s[i] == 'n' ? '\n' : s[i]);
      } else {
        sb.Append(c);
      }
    }
    return sb.ToString();
  }

  static int Num(string[] n, int i) {
    int v; return (i < n.Length && int.TryParse(n[i], out v)) ? v : 0;
  }

  // One command per line, same protocol as before (see input.win32.ts).
  // Returns at end of input or on "quit".
  public static void Run() {
    // Physical pixels everywhere: GetCursorPos/GetSystemMetrics in a
    // DPI-unaware process report scaled values on a 125-200 % desktop.
    try { SetProcessDPIAware(); } catch (Exception) { }
    System.IO.TextReader input = Console.In;
    string line;
    while ((line = input.ReadLine()) != null) {
      int sp = line.IndexOf(' ');
      string cmd = sp < 0 ? line : line.Substring(0, sp);
      string rest = sp < 0 ? "" : line.Substring(sp + 1);
      string[] n = rest.Split(' ');
      try {
        switch (cmd) {
          case "abs": MoveAbsolute(Num(n, 0), Num(n, 1)); break;
          case "rel": MoveRelative(Num(n, 0), Num(n, 1)); break;
          case "btn": Button(n[0], n.Length > 1 && n[1] == "1"); break;
          case "scroll": Scroll(Num(n, 0), Num(n, 1)); break;
          case "key": Key((ushort)Num(n, 0), n.Length > 1 && n[1] == "1"); break;
          case "text": Text(Unescape(rest)); break;
          case "quit": return;
        }
      } catch (Exception) { /* one bad line must not end the session */ }
    }
  }
}
"@

# I11: the interface description promised Windows has no startup race, but
# Add-Type above compiles the embedded C# on first run, which takes real
# time — the same kind of gap the macOS Swift helper already reports
# readiness for. Without this line, input.win32.ts had nothing to wait on,
# and the first burst of input after a session starts could arrive before
# this script's read loop (below) is even running.
[Console]::Error.WriteLine('{"ready":{"input":true}}')

[TmsInput]::Run()
