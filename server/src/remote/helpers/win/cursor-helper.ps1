# TMS Terminal — pointer reporter for Windows.
#
# With a local pointer the app draws the arrow itself, instantly, instead of
# waiting for it to come back inside the video (capture + encode + network +
# decode — on Windows the pointer visibly trailed the finger). ffmpeg then
# leaves the pointer out of the picture (ddagrab draw_mouse=0) and this script
# reports where it really is, so the app can correct its prediction.
#
# One JSON line per change on stdout, normalized 0..1 to the primary monitor
# (what ddagrab output_idx=0 captures):  {"cursor":{"x":0.50000,"y":0.25000}}
# Ends when stdin closes or a write fails (the server is gone).
# C# 5 only (Windows PowerShell 5.1's Add-Type compiler).

Add-Type @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public class TmsCursor {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;

  static volatile bool done = false;

  public static void Run(int intervalMs) {
    // Physical pixels, same as the input helper — otherwise a 150 % desktop
    // reports scaled positions.
    try { SetProcessDPIAware(); } catch (Exception) { }
    // The server closing our stdin is the signal to stop.
    Thread watch = new Thread(delegate () {
      try { while (Console.In.ReadLine() != null) { } } catch (Exception) { }
      done = true;
    });
    watch.IsBackground = true;
    watch.Start();

    int lastX = int.MinValue, lastY = int.MinValue;
    System.IO.TextWriter output = Console.Out;
    while (!done) {
      POINT p;
      if (GetCursorPos(out p) && (p.X != lastX || p.Y != lastY)) {
        lastX = p.X; lastY = p.Y;
        double w = Math.Max(1, GetSystemMetrics(SM_CXSCREEN) - 1);
        double h = Math.Max(1, GetSystemMetrics(SM_CYSCREEN) - 1);
        double x = Math.Min(1.0, Math.Max(0.0, p.X / w));
        double y = Math.Min(1.0, Math.Max(0.0, p.Y / h));
        try {
          output.WriteLine("{\"cursor\":{\"x\":" + x.ToString("0.00000", CultureInfo.InvariantCulture)
            + ",\"y\":" + y.ToString("0.00000", CultureInfo.InvariantCulture) + "}}");
          output.Flush();
        } catch (Exception) { return; }
      }
      Thread.Sleep(intervalMs);
    }
  }
}
"@

[TmsCursor]::Run(15)
