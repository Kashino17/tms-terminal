/**
 * Season 2 dictation — streamed to the server WHILE recording.
 *
 * Android records AAC-ADTS (a stream of self-contained frames), so the growing
 * file can be read and uploaded every couple of seconds; the server transcribes
 * ~60s segments in the background and after the stop only the rest is left.
 * Protocol + recovery live in ./dictationClient (unit-tested): byte-offset
 * chunks, `resume` after a reconnect, re-upload when the server lost the
 * session. The recording file is kept until a result or a final error.
 *
 * ✕ while "Transkribiere…" cancels that dictation and frees the mic at once
 * (the old hook ignored every tap while processing — the "läuft schon" lock).
 *
 * Old servers don't know `dictation:*`: no ack within 5s on a connected socket
 * → the recording goes the old way (`audio:transcribe`, whole file at once).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { Audio } from 'expo-av';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import type { WebSocketService } from '../../services/websocket.service';
import { useSettingsStore } from '../../store/settingsStore';
import { DictationUpload, type DictationIO } from './dictationClient';

export type MicState = 'idle' | 'recording' | 'processing';

const KEEP_AWAKE_TAG = 'tms-dictation';
const PUMP_INTERVAL_MS = 2000;
const ACK_WAIT_MS = 5000;
const SILENCE_RESUME_MS = 60_000;
const SILENCE_CHECK_MS = 15_000;
// Legacy path only (old server): the server heartbeats audio:progress every
// 10s once the whole upload has arrived.
const LEGACY_TIMEOUT_MS = 90_000;

const RECORDING_OPTIONS = {
  android: {
    // AAC in an ADTS stream (MediaRecorder OutputFormat.AAC_ADTS = 6,
    // AudioEncoder.AAC = 3). Unlike MP4/m4a (index at the END of the file),
    // every ADTS frame stands alone, so the file is decodable while it grows.
    // 16 kHz = Whisper's native rate, no resampling on the server.
    extension: '.aac',
    outputFormat: 6,
    audioEncoder: 3,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 96000,
  },
  ios: {
    extension: '.wav',
    audioQuality: 96,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
    outputFormat: 'lpcm',
  },
  web: {},
} as const;

// iOS writes WAV whose header is only valid once finished — upload at the end.
const STREAM_FORMAT: 'adts' | 'file' = Platform.OS === 'android' ? 'adts' : 'file';

const FALLBACK_DICTATION_SESSION_ID = '__dictation__';

interface UseDictationArgs {
  wsService: WebSocketService | null;
  sessionId: string | undefined;
  onText: (text: string) => void;
  onError?: (message: string) => void;
}

function newDictationId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function useDictation({ wsService, sessionId, onText, onError }: UseDictationArgs) {
  const [micState, setMicState] = useState<MicState>('idle');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const uriRef = useRef<string | null>(null);
  const uploadRef = useRef<DictationUpload | null>(null);
  const startedAtRef = useRef(0);
  const pumpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const legacyWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const legacySessionRef = useRef<string | null>(null);
  const effectiveSessionId = sessionId || FALLBACK_DICTATION_SESSION_ID;

  // Callbacks change every render; the socket listeners read the latest ones.
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  onTextRef.current = onText;
  onErrorRef.current = onError;

  const stopPump = useCallback(() => {
    if (pumpTimerRef.current) { clearInterval(pumpTimerRef.current); pumpTimerRef.current = null; }
  }, []);

  const clearLegacyWatchdog = useCallback(() => {
    if (legacyWatchdogRef.current) { clearTimeout(legacyWatchdogRef.current); legacyWatchdogRef.current = null; }
  }, []);

  /** Forget the current dictation and delete its recording. */
  const reset = useCallback(() => {
    stopPump();
    clearLegacyWatchdog();
    uploadRef.current = null;
    legacySessionRef.current = null;
    const uri = uriRef.current;
    uriRef.current = null;
    if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    setMicState('idle');
  }, [stopPump, clearLegacyWatchdog]);

  const deliver = useCallback((text: string) => {
    reset();
    const t = text.trim();
    // Empty must still end the page's "Transkribiere…" state for every target
    // (only onText/onError reach the page) — so it is reported, not swallowed.
    if (t) onTextRef.current(t);
    else onErrorRef.current?.('Keine Sprache erkannt');
  }, [reset]);

  const fail = useCallback((message: string) => {
    reset();
    onErrorRef.current?.(message);
  }, [reset]);

  // ── Server messages ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!wsService) return;
    return wsService.addMessageListener((raw: unknown) => {
      const m = raw as { type: string; sessionId?: string; payload?: any };

      const upload = uploadRef.current;
      if (upload && m.type.startsWith('dictation:')) {
        const outcome = upload.onServer(m);
        if (outcome === 'result') deliver(upload.text ?? '');
        else if (outcome === 'error') fail(upload.error ?? 'Transkription fehlgeschlagen');
        else if (outcome === 'restart' && upload.isEnded) upload.finish().catch(() => {});
        return;
      }

      // Legacy path (old server).
      const legacySid = legacySessionRef.current;
      if (!legacySid || m.sessionId !== legacySid) return;
      if (m.type === 'audio:transcription') deliver(m.payload?.text ?? '');
      else if (m.type === 'audio:error') fail(m.payload?.message ?? 'Transkription fehlgeschlagen');
      else if (m.type === 'audio:progress') armLegacyWatchdog();
    });
    // armLegacyWatchdog is stable (only uses refs + fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsService, deliver, fail]);

  // ── Reconnect → ask the server where the dictation stands ──────────────
  useEffect(() => {
    if (!wsService) return;
    return wsService.addStateListener((state) => {
      if (state === 'connected') uploadRef.current?.onReconnect();
    });
  }, [wsService]);

  // ── Silence watchdog: no word from the server for 60s → resume (never abort) ─
  const busy = micState !== 'idle';
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      const u = uploadRef.current;
      if (!u || u.done || !u.isEnded || wsService?.state !== 'connected') return;
      if (Date.now() - u.lastHeard > SILENCE_RESUME_MS) {
        u.lastHeard = Date.now();
        u.onReconnect();
      }
    }, SILENCE_CHECK_MS);
    return () => clearInterval(t);
  }, [busy, wsService]);

  // Keep the screen on while recording or uploading. Without this the display
  // dimmed and locked mid-sentence: Android pauses the activity on screen-off,
  // which stops the recorder, and the socket carrying the upload dies with it.
  useEffect(() => {
    if (!busy) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => { deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {}); };
  }, [busy]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopPump();
      clearLegacyWatchdog();
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, [stopPump, clearLegacyWatchdog]);

  function armLegacyWatchdog() {
    clearLegacyWatchdog();
    legacyWatchdogRef.current = setTimeout(() => {
      fail('Transkription abgebrochen (Zeitüberschreitung)');
    }, LEGACY_TIMEOUT_MS);
  }

  const makeIO = useCallback((uri: string): DictationIO => ({
    send: (msg) => wsService?.send(msg) ?? false,
    fileSize: async () => {
      const info = await FileSystem.getInfoAsync(uri);
      return info.exists && typeof (info as { size?: number }).size === 'number' ? (info as { size: number }).size : 0;
    },
    readBase64: (position, length) =>
      FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, position, length }),
    now: () => Date.now(),
  }), [wsService]);

  const sendLegacy = useCallback(async (uri: string, upload: DictationUpload) => {
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    if (uploadRef.current !== upload) return; // ✕ while reading — never send a cancelled dictation
    legacySessionRef.current = effectiveSessionId;
    uploadRef.current = null;
    wsService?.send({
      type: 'audio:transcribe',
      sessionId: effectiveSessionId,
      // `format: 'wav'` is a legacy gate string the server requires — the
      // sidecar sniffs the real container (RIFF → WAV, else ffmpeg).
      payload: { audio: base64, format: 'wav' },
    });
    armLegacyWatchdog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsService, effectiveSessionId]);

  const stop = useCallback(async () => {
    const recording = recordingRef.current;
    const upload = uploadRef.current;
    recordingRef.current = null;
    stopPump();
    setMicState('processing');
    const current = () => uploadRef.current === upload;
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
      } catch {
        // Android throws when the recorder got no audio at all (a quick tap).
        if (!current()) return;
        if (upload) wsService?.send({ type: 'dictation:cancel', payload: { id: upload.id } });
        fail('Aufnahme zu kurz');
        return;
      }
    }
    // Every await below may race ✕ (+ a new recording): only act while this
    // dictation is still the current one.
    if (!current()) return;
    try {
      const uri = uriRef.current;
      if (!uri || !upload) { reset(); return; }
      // Old server? It never acks. Give a fresh connection up to 5s from start.
      const waitUntil = startedAtRef.current + ACK_WAIT_MS;
      while (!upload.ackSeen && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 200));
      if (!current()) return;
      if (!upload.ackSeen && wsService?.state === 'connected') {
        await sendLegacy(uri, upload);
        return;
      }
      await upload.finish();
    } catch {
      if (current()) fail('Aufnahme konnte nicht gesendet werden');
    }
  }, [stopPump, reset, fail, sendLegacy, wsService]);

  const start = useCallback(async () => {
    if (!wsService) return;
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { onErrorRef.current?.('Mikrofon-Berechtigung fehlt'); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS as any);
      const uri = recording.getURI();
      if (!uri) { await recording.stopAndUnloadAsync().catch(() => {}); throw new Error('no uri'); }
      recordingRef.current = recording;
      uriRef.current = uri;
      startedAtRef.current = Date.now();
      const upload = new DictationUpload(newDictationId(), STREAM_FORMAT, false, makeIO(uri));
      uploadRef.current = upload;
      upload.begin();
      if (STREAM_FORMAT === 'adts') {
        pumpTimerRef.current = setInterval(() => { upload.pump().catch(() => {}); }, PUMP_INTERVAL_MS);
      }
      setMicState('recording');
    } catch {
      reset();
      onErrorRef.current?.('Aufnahme konnte nicht gestartet werden');
    }
  }, [wsService, makeIO, reset]);

  /** Start ↔ stop. Ignored while processing — use cancel() to abandon that. */
  const toggle = useCallback(async () => {
    if (micState === 'recording') return stop();
    if (micState === 'idle') return start();
  }, [micState, start, stop]);

  /** Throw the current dictation away — recording or processing — and free the mic now. */
  const cancel = useCallback(async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    const upload = uploadRef.current;
    uploadRef.current = null; // late messages for it are ignored from here on
    stopPump();
    if (upload && !upload.done) wsService?.send({ type: 'dictation:cancel', payload: { id: upload.id } });
    if (recording) await recording.stopAndUnloadAsync().catch(() => {});
    reset();
  }, [wsService, reset, stopPump]);

  return { micState, toggle, cancel };
}
