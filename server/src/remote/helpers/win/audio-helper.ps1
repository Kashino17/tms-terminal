# TMS Terminal — sound reporter for Windows ("Ton aufs Handy").
#
# Captures everything the default output device plays (WASAPI loopback) and
# writes it as raw 32-bit float stereo PCM to stdout; the server encodes it to
# Opus with ffmpeg (see ogg.ts). While it runs, the output device is muted so
# the room hears nothing — the previous mute state is written to disk first
# and put back when the helper ends (also by `-Restore` after a kill).
#
# stderr: {"ready":{"audio":true,"rate":48000}} once capturing, or
#         {"error":{"code":"capture_unavailable","message":"..."}}
# Ends when stdin closes. C# 5 only (Windows PowerShell 5.1's Add-Type).
param([switch]$Restore)

Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class TmsMMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITmsMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out ITmsMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITmsMMDevice {
  int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITmsAudioClient {
  int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  int GetBufferSize(out uint frames);
  int GetStreamLatency(out long latency);
  int GetCurrentPadding(out uint padding);
  int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  int GetMixFormat(out IntPtr format);
  int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  int Start();
  int Stop();
  int Reset();
  int SetEventHandle(IntPtr handle);
  int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITmsAudioCaptureClient {
  int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  int ReleaseBuffer(uint frames);
  int GetNextPacketSize(out uint frames);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITmsAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, ref Guid context);
  int SetMasterVolumeLevelScalar(float level, ref Guid context);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
  int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  int GetChannelVolumeLevel(uint channel, out float level);
  int GetChannelVolumeLevelScalar(uint channel, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

public class TmsAudio {
  const int SHARED = 0;
  const uint LOOPBACK = 0x00020000;
  const uint CLSCTX_ALL = 23;
  const uint SILENT = 0x2;
  static readonly Guid IID_AudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
  static readonly Guid IID_CaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
  static readonly Guid IID_EndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
  static readonly Guid FLOAT_SUBTYPE = new Guid("00000003-0000-0010-8000-00aa00389b71");

  static volatile bool done = false;

  static string MuteFile() {
    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tms-terminal");
    Directory.CreateDirectory(dir);
    return Path.Combine(dir, "audio-mute.txt");
  }

  static void Error(string message) {
    Console.Error.WriteLine("{\"error\":{\"code\":\"capture_unavailable\",\"message\":\"" + message.Replace("\"", "'") + "\"}}");
  }

  static ITmsMMDevice DefaultOutput() {
    ITmsMMDeviceEnumerator en = (ITmsMMDeviceEnumerator)new TmsMMDeviceEnumeratorCom();
    ITmsMMDevice dev;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0 /* render */, 0 /* console */, out dev));
    return dev;
  }

  static ITmsAudioEndpointVolume Volume(ITmsMMDevice dev) {
    object o;
    Guid iid = IID_EndpointVolume;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o));
    return (ITmsAudioEndpointVolume)o;
  }

  /// Puts back a mute state a killed session left behind.
  public static void RestoreMute() {
    try {
      string f = MuteFile();
      if (!File.Exists(f)) return;
      bool was = File.ReadAllText(f).Trim() == "1";
      Guid ctx = Guid.Empty;
      Volume(DefaultOutput()).SetMute(was, ref ctx);
      File.Delete(f);
    } catch (Exception) { }
  }

  public static void Run() {
    RestoreMute();
    ITmsMMDevice dev;
    ITmsAudioClient client;
    ITmsAudioCaptureClient capture;
    int channels, rate, bits;
    bool isFloat;
    try {
      dev = DefaultOutput();
      object o;
      Guid iid = IID_AudioClient;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o));
      client = (ITmsAudioClient)o;
      IntPtr fmt;
      Marshal.ThrowExceptionForHR(client.GetMixFormat(out fmt));
      int tag = Marshal.ReadInt16(fmt, 0) & 0xffff;
      channels = Marshal.ReadInt16(fmt, 2);
      rate = Marshal.ReadInt32(fmt, 4);
      bits = Marshal.ReadInt16(fmt, 14);
      isFloat = tag == 3;
      if (tag == 0xFFFE) {
        byte[] g = new byte[16];
        Marshal.Copy(new IntPtr(fmt.ToInt64() + 24), g, 0, 16);
        isFloat = new Guid(g) == FLOAT_SUBTYPE;
      }
      if (!(isFloat && bits == 32) && bits != 16) { Error("Tonformat nicht unterstuetzt (" + bits + " Bit)"); return; }
      Marshal.ThrowExceptionForHR(client.Initialize(SHARED, LOOPBACK, 2000000, 0, fmt, IntPtr.Zero));
      Guid cid = IID_CaptureClient;
      Marshal.ThrowExceptionForHR(client.GetService(ref cid, out o));
      capture = (ITmsAudioCaptureClient)o;
    } catch (Exception e) {
      Error("Ton-Abgriff nicht moeglich: " + e.Message);
      return;
    }

    // Mute the room — the previous state goes to disk first.
    ITmsAudioEndpointVolume vol = null;
    bool wasMuted = false;
    try {
      vol = Volume(dev);
      vol.GetMute(out wasMuted);
      File.WriteAllText(MuteFile(), wasMuted ? "1" : "0");
      Guid ctx = Guid.Empty;
      vol.SetMute(true, ref ctx);
    } catch (Exception) { vol = null; }

    Thread watch = new Thread(delegate () {
      try { while (Console.In.ReadLine() != null) { } } catch (Exception) { }
      done = true;
    });
    watch.IsBackground = true;
    watch.Start();

    Stream output = Console.OpenStandardOutput();
    try {
      Marshal.ThrowExceptionForHR(client.Start());
      Console.Error.WriteLine("{\"ready\":{\"audio\":true,\"rate\":" + rate + "}}");
      int bytesPerSample = bits / 8;
      byte[] outBuf = new byte[0];
      while (!done) {
        Thread.Sleep(10);
        uint next;
        while (!done && capture.GetNextPacketSize(out next) == 0 && next > 0) {
          IntPtr data; uint frames, flags; ulong dp, qp;
          if (capture.GetBuffer(out data, out frames, out flags, out dp, out qp) != 0) break;
          int need = (int)frames * 8;
          if (outBuf.Length < need) outBuf = new byte[need];
          if ((flags & SILENT) != 0) {
            Array.Clear(outBuf, 0, need);
          } else {
            byte[] raw = new byte[(int)frames * channels * bytesPerSample];
            Marshal.Copy(data, raw, 0, raw.Length);
            for (int i = 0; i < (int)frames; i++) {
              float l, r;
              int at = i * channels * bytesPerSample;
              if (bits == 32) {
                l = BitConverter.ToSingle(raw, at);
                r = channels > 1 ? BitConverter.ToSingle(raw, at + 4) : l;
              } else {
                l = BitConverter.ToInt16(raw, at) / 32768f;
                r = channels > 1 ? BitConverter.ToInt16(raw, at + 2) / 32768f : l;
              }
              Buffer.BlockCopy(BitConverter.GetBytes(l), 0, outBuf, i * 8, 4);
              Buffer.BlockCopy(BitConverter.GetBytes(r), 0, outBuf, i * 8 + 4, 4);
            }
          }
          capture.ReleaseBuffer(frames);
          output.Write(outBuf, 0, need);
        }
        output.Flush();
      }
    } catch (Exception) {
      // stdout gone (server ended) or the device went away: just end.
    } finally {
      try { client.Stop(); } catch (Exception) { }
      if (vol != null) {
        try { Guid ctx = Guid.Empty; vol.SetMute(wasMuted, ref ctx); File.Delete(MuteFile()); } catch (Exception) { }
      }
    }
  }
}
"@

if ($Restore) { [TmsAudio]::RestoreMute(); exit 0 }
[TmsAudio]::Run()
