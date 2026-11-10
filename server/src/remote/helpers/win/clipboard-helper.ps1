# TMS Terminal — shared clipboard on Windows (counterpart of the Mac helper's
# --clipboard mode).
#
# Listens for clipboard changes (AddClipboardFormatListener, no polling) and
# reports copied text; puts text from the phone onto the clipboard.
#
# stderr (one JSON line each, ASCII only — every non-ASCII character is \uXXXX,
# so the console code page can't garble umlauts):
#   {"ready":{"clipboard":true}}
#   {"clip":{"text":"..."}}
# stdin, one line each:
#   set <base64 of the UTF-8 text>
# Ends when stdin closes. C# 5 only (Windows PowerShell 5.1's Add-Type).

Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class TmsClipboard {
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool AddClipboardFormatListener(IntPtr hwnd);

  const int WM_CLIPBOARDUPDATE = 0x031D;

  // Never shown: only its window handle is needed for the listener.
  class Listener : Form {
    protected override void WndProc(ref Message m) {
      if (m.Msg == WM_CLIPBOARDUPDATE) OnUpdate();
      base.WndProc(ref m);
    }
  }

  static Listener win;
  static TextWriter err;
  static string ourText;   // what we just put there ourselves (no echo)
  static string lastSeen;  // Windows reports some copies twice

  static string Normalize(string t) { return t.Replace("\r\n", "\n"); }

  static string Json(string s) {
    var sb = new StringBuilder(s.Length + 16);
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\"");
      else if (c == '\\') sb.Append("\\\\");
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\t') sb.Append("\\t");
      else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.ToString();
  }

  static void Emit(string line) {
    lock (err) { err.WriteLine(line); err.Flush(); }
  }

  static void OnUpdate() {
    string t = null;
    // Another program may still hold the clipboard open for a moment.
    for (int i = 0; i < 6; i++) {
      try {
        if (!Clipboard.ContainsText()) return;
        t = Clipboard.GetText();
        break;
      } catch (Exception) { Thread.Sleep(40); }
    }
    if (string.IsNullOrEmpty(t)) return;
    t = Normalize(t);
    if (t == ourText) { ourText = null; lastSeen = t; return; }
    if (t == lastSeen) return;
    lastSeen = t;
    Emit("{\"clip\":{\"text\":\"" + Json(t) + "\"}}");
  }

  static void Put(string text) {
    ourText = text;
    lastSeen = text;
    string win32 = text.Replace("\n", "\r\n");
    for (int i = 0; i < 6; i++) {
      try { Clipboard.SetText(win32); return; } catch (Exception) { Thread.Sleep(40); }
    }
  }

  static void ReadStdin() {
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      if (!line.StartsWith("set ")) continue;
      string text;
      try { text = Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(4).Trim())); }
      catch (Exception) { continue; }
      if (text.Length == 0) continue;
      string copy = text;
      try { win.BeginInvoke(new Action(delegate { Put(copy); })); } catch (Exception) { }
    }
    try { win.BeginInvoke(new Action(delegate { Application.ExitThread(); })); } catch (Exception) { }
  }

  static void Ui() {
    win = new Listener();
    IntPtr h = win.Handle; // creates the window without showing it
    if (!AddClipboardFormatListener(h)) {
      Emit("{\"error\":{\"code\":\"listener_failed\",\"message\":\"AddClipboardFormatListener\"}}");
      return;
    }
    var reader = new Thread(ReadStdin);
    reader.IsBackground = true;
    reader.Start();
    Emit("{\"ready\":{\"clipboard\":true}}");
    Application.Run();
  }

  public static void Run() {
    err = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
    // The clipboard API wants a single-threaded apartment.
    var ui = new Thread(Ui);
    ui.SetApartmentState(ApartmentState.STA);
    ui.Start();
    ui.Join();
  }
}
"@

[TmsClipboard]::Run()
