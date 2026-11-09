# TMS Terminal — curtain for Windows ("Bildschirm am Gerät verdunkeln").
#
# A black, click-through, always-on-top window over every monitor that the
# screen capture is told to leave out (SetWindowDisplayAffinity
# WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+): the phone sees the desktop, the
# room sees black. Plus the backlight turned down — DDC/CI for external
# monitors, WMI for laptop panels. The previous brightness goes to disk first
# and comes back when the helper ends (also by `-Restore` after a kill).
#
# The mouse pointer is drawn by Windows above every window, the curtain too —
# so all standard pointer shapes are swapped for an empty one while it is up
# (the phone draws its own pointer; the video leaves it out anyway). Putting
# the user's pointers back = reloading the scheme (SPI_SETCURSORS), also by
# `-Restore` and on the next start, in case the helper was killed.
#
# If the window can't be excluded from the capture, it is NOT shown — it would
# black out the remote picture too.
#
# stdout: {"ready":{"curtain":true}} or {"error":{"code":"capture_unavailable","message":"..."}}
# Ends when stdin closes. C# 5 only (Windows PowerShell 5.1's Add-Type).
param([switch]$Restore)

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Management @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class TmsCurtain {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr inst, int xHot, int yHot, int w, int h, byte[] andMask, byte[] xorMask);
  [DllImport("user32.dll")] static extern IntPtr CopyIcon(IntPtr icon);
  [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr cursor, uint id);
  [DllImport("user32.dll")] static extern bool DestroyCursor(IntPtr cursor);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr data, uint winIni);

  delegate bool MonitorEnum(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnum cb, IntPtr data);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PHYSICAL_MONITOR { public IntPtr handle; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string description; }
  [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);
  [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);
  [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr monitor, out uint min, out uint current, out uint max);
  [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr monitor, uint value);

  const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
  const int WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x8000000;
  const uint LWA_ALPHA = 0x2;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
  const int SW_SHOWNOACTIVATE = 4;
  const uint SPI_SETCURSORS = 0x57;
  // OCR_NORMAL, IBEAM, WAIT, CROSS, UP, SIZENWSE, SIZENESW, SIZEWE, SIZENS,
  // SIZEALL, NO, HAND, APPSTARTING, HELP, PIN, PERSON.
  static readonly uint[] POINTERS = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651, 32671, 32672 };

  class Curtain : Form {
    public bool Excluded;
    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        // Click-through (layered + transparent): remote clicks reach the apps below.
        cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
        return cp;
      }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      SetLayeredWindowAttributes(Handle, 0, 255, LWA_ALPHA);
      Excluded = SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE);
    }
  }

  static string BrightnessFile() {
    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tms-terminal");
    Directory.CreateDirectory(dir);
    return Path.Combine(dir, "curtain-brightness.txt");
  }

  static string PointerFile() {
    return Path.Combine(Path.GetDirectoryName(BrightnessFile()), "curtain-pointer.txt");
  }

  // ── Pointer: every standard shape becomes an empty 32x32 cursor ─────────
  static void HidePointer() {
    byte[] andMask = new byte[128];
    for (int i = 0; i < andMask.Length; i++) andMask[i] = 0xFF; // AND 1 + XOR 0 = screen unchanged
    byte[] xorMask = new byte[128];
    IntPtr blank = CreateCursor(IntPtr.Zero, 0, 0, 32, 32, andMask, xorMask);
    if (blank == IntPtr.Zero) return;
    File.WriteAllText(PointerFile(), "1"); // before the swap: a kill in between still restores
    foreach (uint id in POINTERS) {
      IntPtr copy = CopyIcon(blank); // SetSystemCursor takes ownership of (destroys) its handle
      if (copy != IntPtr.Zero && !SetSystemCursor(copy, id)) DestroyCursor(copy);
    }
    DestroyCursor(blank);
  }

  static void RestorePointer() {
    try {
      string f = PointerFile();
      if (!File.Exists(f)) return;
      SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0);
      File.Delete(f);
    } catch (Exception) { }
  }

  /// Everything a killed curtain may have left behind.
  public static void Restore() {
    RestorePointer();
    RestoreBrightness();
  }

  // ── Brightness: "ddc <index> <value>" / "wmi <value>" per line ──────────
  static List<PHYSICAL_MONITOR[]> PhysicalMonitors() {
    List<PHYSICAL_MONITOR[]> all = new List<PHYSICAL_MONITOR[]>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr dc, IntPtr r, IntPtr d) {
      uint n;
      if (GetNumberOfPhysicalMonitorsFromHMONITOR(m, out n) && n > 0) {
        PHYSICAL_MONITOR[] pm = new PHYSICAL_MONITOR[n];
        if (GetPhysicalMonitorsFromHMONITOR(m, n, pm)) all.Add(pm);
      }
      return true;
    }, IntPtr.Zero);
    return all;
  }

  static void ForEachDdc(Action<int, IntPtr> act) {
    List<PHYSICAL_MONITOR[]> all = PhysicalMonitors();
    int index = 0;
    foreach (PHYSICAL_MONITOR[] group in all) {
      foreach (PHYSICAL_MONITOR pm in group) { try { act(index, pm.handle); } catch (Exception) { } index++; }
      DestroyPhysicalMonitors((uint)group.Length, group);
    }
  }

  static void Dim() {
    List<string> saved = new List<string>();
    List<KeyValuePair<IntPtr, uint>> lowest = new List<KeyValuePair<IntPtr, uint>>();
    List<PHYSICAL_MONITOR[]> all = PhysicalMonitors();
    int index = 0;
    foreach (PHYSICAL_MONITOR[] group in all) {
      foreach (PHYSICAL_MONITOR pm in group) {
        uint min, cur, max;
        if (GetMonitorBrightness(pm.handle, out min, out cur, out max)) {
          saved.Add("ddc " + index + " " + cur);
          lowest.Add(new KeyValuePair<IntPtr, uint>(pm.handle, min));
        }
        index++;
      }
    }
    try {
      using (ManagementObjectSearcher s = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
        foreach (ManagementObject o in s.Get()) { saved.Add("wmi " + o["CurrentBrightness"]); break; }
    } catch (Exception) { }
    if (saved.Count == 0) { foreach (PHYSICAL_MONITOR[] g in all) DestroyPhysicalMonitors((uint)g.Length, g); return; }
    File.WriteAllLines(BrightnessFile(), saved.ToArray());
    foreach (KeyValuePair<IntPtr, uint> kv in lowest) { try { SetMonitorBrightness(kv.Key, kv.Value); } catch (Exception) { } }
    foreach (PHYSICAL_MONITOR[] g in all) DestroyPhysicalMonitors((uint)g.Length, g);
    SetWmi(0);
  }

  static void SetWmi(int value) {
    try {
      using (ManagementObjectSearcher s = new ManagementObjectSearcher("root\\WMI", "SELECT * FROM WmiMonitorBrightnessMethods"))
        foreach (ManagementObject o in s.Get()) o.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)value });
    } catch (Exception) { }
  }

  public static void RestoreBrightness() {
    try {
      string f = BrightnessFile();
      if (!File.Exists(f)) return;
      Dictionary<int, uint> ddc = new Dictionary<int, uint>();
      int wmi = -1;
      foreach (string line in File.ReadAllLines(f)) {
        string[] p = line.Split(' ');
        uint v; int i;
        if (p.Length == 3 && p[0] == "ddc" && int.TryParse(p[1], out i) && uint.TryParse(p[2], out v)) ddc[i] = v;
        else if (p.Length == 2 && p[0] == "wmi" && int.TryParse(p[1], out i)) wmi = i;
      }
      ForEachDdc(delegate (int index, IntPtr h) { uint v; if (ddc.TryGetValue(index, out v)) SetMonitorBrightness(h, v); });
      if (wmi >= 0) SetWmi(wmi);
      File.Delete(f);
    } catch (Exception) { }
  }

  public static void Run() {
    try { SetProcessDPIAware(); } catch (Exception) { }
    Restore();
    List<Curtain> curtains = new List<Curtain>();
    foreach (Screen s in Screen.AllScreens) {
      Curtain c = new Curtain();
      c.FormBorderStyle = FormBorderStyle.None;
      c.BackColor = Color.Black;
      c.StartPosition = FormStartPosition.Manual;
      c.Bounds = s.Bounds;
      c.ShowInTaskbar = false;
      c.TopMost = true;
      IntPtr unused = c.Handle; // create the window (and set the affinity) before showing it
      curtains.Add(c);
    }
    foreach (Curtain c in curtains) {
      if (!c.Excluded) {
        Console.Out.WriteLine("{\"error\":{\"code\":\"capture_unavailable\",\"message\":\"Verdunkeln braucht Windows 10 (2004) oder neuer\"}}");
        Console.Out.Flush();
        return;
      }
    }
    foreach (Curtain c in curtains) c.Show();
    // The server starts this process hidden (no console window popping up on
    // the PC). Windows applies that startup "hidden" to the process's FIRST
    // ShowWindow call — which is the first curtain's. Showing again fixes it.
    foreach (Curtain c in curtains) ShowWindow(c.Handle, SW_SHOWNOACTIVATE);
    try { HidePointer(); } catch (Exception) { }
    Console.Out.WriteLine("{\"ready\":{\"curtain\":true}}");
    Console.Out.Flush();

    Thread dim = new Thread(Dim);
    dim.IsBackground = true;
    dim.Start();

    // Other always-on-top windows may come up later: stay above them.
    System.Windows.Forms.Timer keep = new System.Windows.Forms.Timer();
    keep.Interval = 1000;
    keep.Tick += delegate (object sender, EventArgs e) {
      foreach (Curtain c in curtains) SetWindowPos(c.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    };
    keep.Start();

    Curtain first = curtains[0];
    Thread watch = new Thread(delegate () {
      try { while (Console.In.ReadLine() != null) { } } catch (Exception) { }
      try { first.BeginInvoke(new MethodInvoker(delegate () { Application.ExitThread(); })); } catch (Exception) { }
    });
    watch.IsBackground = true;
    watch.Start();

    try { Application.Run(); }
    finally {
      dim.Join(3000);
      Restore();
    }
  }
}
"@

if ($Restore) { [TmsCurtain]::Restore(); exit 0 }
[TmsCurtain]::Run()
