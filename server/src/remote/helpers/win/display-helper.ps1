# TMS Terminal — "Bildschirm aus" with the virtual display (runs as the user).
#
# Session: switch the virtual display device on (through the SYSTEM task that
# display-setup.ps1 registered), make it the ONLY active screen (like Win+P
# "second screen only": the laptop panel really goes off), give it exactly
# -Width x -Height, report, and wait. When stdin closes (session over, or the
# server died): put the previous screen layout back and switch the device off.
#
# The layout from before is kept on disk until it is restored, so -Restore
# (after a kill) and the next start can still bring the panel back. And the
# boot task switches the device off anyway, so the worst case after a crash
# is: restart the PC.
#
# stdout: {"ready":{"display":true,"width":1920,"height":1200,"name":"..."}}
#         or {"error":{"code":"...","message":"..."}}
# -List prints every display device (diagnosis). C# 5 only (PowerShell 5.1).
param([int]$Width = 1920, [int]$Height = 1200, [int]$MaxSeconds = 0, [switch]$Restore, [switch]$List)

Add-Type @"
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class TmsDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] byte[] paths, ref uint numModes, [Out] byte[] modes, IntPtr topology);
  [DllImport("user32.dll")] static extern int SetDisplayConfig(uint numPaths, byte[] paths, uint numModes, byte[] modes, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const int ATTACHED = 0x1, PRIMARY = 0x4;
  const uint QDC_ONLY_ACTIVE_PATHS = 0x2;
  const uint SDC_TOPOLOGY_INTERNAL = 0x1, SDC_TOPOLOGY_EXTERNAL = 0x8, SDC_USE_SUPPLIED = 0x20, SDC_APPLY = 0x80, SDC_ALLOW_CHANGES = 0x400;
  const int PATH_SIZE = 72, MODE_SIZE = 64; // DISPLAYCONFIG_PATH_INFO / _MODE_INFO, kept as opaque bytes
  const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
  const string TASK = "TMS Terminal Bildschirm";

  static string ConfigDir() {
    string d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tms-terminal");
    Directory.CreateDirectory(d);
    return d;
  }
  static string SavedFile() { return Path.Combine(ConfigDir(), "display-saved.txt"); }
  static string WantFile() {
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TMS Terminal", "display-want.txt");
  }
  public static bool Installed() {
    return File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "TMS Terminal", "display-installed.txt"));
  }

  static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "'"); }
  static void Out(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }
  static void Error(string code, string message) {
    Out("{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + Esc(message) + "\"}}");
  }

  // ── The virtual display among Windows' display devices ──────────────────
  static bool IsVirtual(DISPLAY_DEVICE d) {
    string s = (d.DeviceString ?? "") + " " + (d.DeviceID ?? "");
    return s.IndexOf("MttVDD", StringComparison.OrdinalIgnoreCase) >= 0
        || s.IndexOf("Virtual Display Driver", StringComparison.OrdinalIgnoreCase) >= 0;
  }
  static DISPLAY_DEVICE NewDevice() { DISPLAY_DEVICE d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE)); return d; }

  /// The virtual display's adapter entry, or null.
  static string FindVirtual(out bool attached, out bool primary) {
    attached = false; primary = false;
    for (uint i = 0; i < 32; i++) {
      DISPLAY_DEVICE d = NewDevice();
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      if (!IsVirtual(d)) continue;
      attached = (d.StateFlags & ATTACHED) != 0;
      primary = (d.StateFlags & PRIMARY) != 0;
      return d.DeviceName;
    }
    return null;
  }

  public static void ListDevices() {
    for (uint i = 0; i < 32; i++) {
      DISPLAY_DEVICE d = NewDevice();
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      DEVMODE dm = NewMode();
      string size = EnumDisplaySettings(d.DeviceName, -1, ref dm) ? dm.dmPelsWidth + "x" + dm.dmPelsHeight + "@" + dm.dmDisplayFrequency : "-";
      Out("{\"device\":{\"name\":\"" + Esc(d.DeviceName) + "\",\"string\":\"" + Esc(d.DeviceString) + "\",\"id\":\"" + Esc(d.DeviceID)
        + "\",\"flags\":" + d.StateFlags + ",\"virtual\":" + (IsVirtual(d) ? "true" : "false") + ",\"mode\":\"" + size + "\"}}");
      for (uint j = 0; j < 4; j++) {
        DISPLAY_DEVICE m = NewDevice();
        if (!EnumDisplayDevices(d.DeviceName, j, ref m, 0)) break;
        Out("{\"monitor\":{\"of\":\"" + Esc(d.DeviceName) + "\",\"string\":\"" + Esc(m.DeviceString) + "\",\"id\":\"" + Esc(m.DeviceID) + "\",\"flags\":" + m.StateFlags + "}}");
      }
    }
    Out("{\"installed\":" + (Installed() ? "true" : "false") + "}");
  }

  static DEVMODE NewMode() { DEVMODE m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return m; }

  // ── Device on/off through the SYSTEM task ───────────────────────────────
  static void Want(bool on) {
    File.WriteAllText(WantFile(), on ? "on" : "off");
    ProcessStartInfo p = new ProcessStartInfo("schtasks.exe", "/run /tn \"" + TASK + "\"");
    p.UseShellExecute = false; p.CreateNoWindow = true;
    p.RedirectStandardOutput = true; p.RedirectStandardError = true;
    using (Process proc = Process.Start(p)) {
      proc.StandardOutput.ReadToEnd(); proc.StandardError.ReadToEnd();
      proc.WaitForExit(10000);
      if (proc.ExitCode != 0) throw new Exception("Schalt-Aufgabe nicht startbar (schtasks " + proc.ExitCode + ")");
    }
  }

  // ── Screen layout before the session: saved as opaque CCD paths/modes ───
  static void SaveLayout() {
    // A crashed session (virtual display still on) left the ORIGINAL layout
    // here — that one wins. Without the virtual display it is just stale
    // (the boot task switched it off): take the current layout.
    bool att, pri;
    if (File.Exists(SavedFile()) && FindVirtual(out att, out pri) != null) return;
    uint np, nm;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm) != 0) return;
    byte[] paths = new byte[np * PATH_SIZE], modes = new byte[nm * MODE_SIZE];
    if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return;
    Array.Resize(ref paths, (int)(np * PATH_SIZE)); Array.Resize(ref modes, (int)(nm * MODE_SIZE));
    File.WriteAllText(SavedFile(), np + " " + nm + " " + Convert.ToBase64String(paths) + " " + Convert.ToBase64String(modes));
  }

  static bool RestoreLayout() {
    string f = SavedFile();
    bool done = false;
    if (File.Exists(f)) {
      try {
        string[] p = File.ReadAllText(f).Trim().Split(' ');
        uint np = uint.Parse(p[0]), nm = uint.Parse(p[1]);
        byte[] paths = Convert.FromBase64String(p[2]), modes = Convert.FromBase64String(p[3]);
        done = SetDisplayConfig(np, paths, nm, modes, SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES) == 0;
      } catch (Exception) { }
    }
    if (!done) done = SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_TOPOLOGY_INTERNAL) == 0;
    return done;
  }

  public static void RestoreAll() {
    try { SetProcessDPIAware(); } catch (Exception) { }
    try { RestoreLayout(); } catch (Exception) { }
    try { Want(false); } catch (Exception) { }
    try { File.Delete(SavedFile()); } catch (Exception) { }
  }

  static bool Wait(Func<bool> cond, int ms) {
    DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < end) { if (cond()) return true; Thread.Sleep(250); }
    return cond();
  }

  static bool SetSize(string name, int w, int h) {
    DEVMODE best = NewMode(); bool found = false;
    for (int i = 0; i < 512; i++) {
      DEVMODE m = NewMode();
      if (!EnumDisplaySettings(name, i, ref m)) break;
      if (m.dmPelsWidth != w || m.dmPelsHeight != h) continue;
      if (!found || (m.dmDisplayFrequency <= 60 && m.dmDisplayFrequency > best.dmDisplayFrequency)) { best = m; found = true; }
    }
    if (!found) return false;
    best.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
    return ChangeDisplaySettingsEx(name, ref best, IntPtr.Zero, 0, IntPtr.Zero) == 0;
  }

  public static void Run(int w, int h, int maxSeconds) {
    try { SetProcessDPIAware(); } catch (Exception) { }
    if (!Installed()) { Error("not_installed", "Virtueller Bildschirm nicht eingerichtet (tms-terminal display install)"); return; }
    bool attached = false, primary = false;
    try {
      SaveLayout();
      Want(true);
      if (!Wait(delegate () { return FindVirtual(out attached, out primary) != null; }, 15000))
        throw new Exception("Virtueller Bildschirm taucht nicht auf");
      // Only the virtual one: the laptop panel goes off, like Win+P "second screen only".
      SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_TOPOLOGY_EXTERNAL);
      string name = null;
      if (!Wait(delegate () { name = FindVirtual(out attached, out primary); return name != null && attached && primary; }, 8000))
        throw new Exception("Umschalten auf den virtuellen Bildschirm hat nicht geklappt");
      bool sized = SetSize(name, w, h);
      DEVMODE now = NewMode();
      // Let the new mode settle before reporting ready: the capture opens the
      // screen right after this line, and a screen still changing its mode
      // can make that fail.
      string settled = name;
      Wait(delegate () {
        DEVMODE m = NewMode();
        return EnumDisplaySettings(settled, -1, ref m) && (!sized || (m.dmPelsWidth == w && m.dmPelsHeight == h));
      }, 3000);
      Thread.Sleep(1000);
      EnumDisplaySettings(name, -1, ref now);
      Out("{\"ready\":{\"display\":true,\"width\":" + now.dmPelsWidth + ",\"height\":" + now.dmPelsHeight
        + ",\"sized\":" + (sized ? "true" : "false") + ",\"name\":\"" + Esc(name) + "\"}}");
    } catch (Exception e) {
      RestoreAll();
      Error("capture_unavailable", e.Message);
      return;
    }

    // Until stdin closes (or the time limit of a test run is up).
    Thread watch = new Thread(delegate () {
      try { while (Console.In.ReadLine() != null) { } } catch (Exception) { }
    });
    watch.IsBackground = true;
    watch.Start();
    if (maxSeconds > 0) watch.Join(maxSeconds * 1000); else watch.Join();
    RestoreAll();
  }
}
"@

if ($List) { [TmsDisplay]::ListDevices(); exit 0 }
if ($Restore) { [TmsDisplay]::RestoreAll(); exit 0 }
[TmsDisplay]::Run($Width, $Height, $MaxSeconds)
