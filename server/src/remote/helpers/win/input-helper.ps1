# TMS Terminal — input helper for Windows.
#
# Stays alive and reads commands from stdin: spawning a process per keystroke
# would cost 50-100 ms and wreck the whole latency budget. Add-Type compiles the
# C# once at startup using in-box tooling — nothing to install.

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
  // Without this flag, ABSOLUTE coordinates map to the primary monitor only —
  // on a multi-monitor box that is not necessarily the one ddagrab (output_idx=0)
  // is capturing, so the pointer would land on the wrong screen.
  const uint VIRTUALDESK = 0x4000;

  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }

  public static void MoveAbsolute(int x, int y) {
    INPUT i = new INPUT(); i.type = MOUSE;
    i.mi.dx = x; i.mi.dy = y; i.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK; Send(i);
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
  // Unicode directly: independent of the target machine's keyboard layout.
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
