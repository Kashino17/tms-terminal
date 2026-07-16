/**
 * Season 2 dictation — records via expo-av and transcribes through the
 * server's Whisper pipeline, mirroring the classic TerminalToolbar contract
 * exactly: `audio:transcribe` (base64 wav, 16kHz mono) → `audio:progress`
 * keep-alives → `audio:transcription` | `audio:error`. Includes the same
 * inactivity watchdog so the spinner can never hang forever.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import type { WebSocketService } from '../../services/websocket.service';
import { useSettingsStore } from '../../store/settingsStore';

export type MicState = 'idle' | 'recording' | 'processing';

const TRANSCRIPTION_TIMEOUT_MS = 25000;

const RECORDING_OPTIONS = {
  android: {
    // AAC in an MP4/m4a container. Android's MediaRecorder cannot emit RIFF
    // WAV, so the server decodes this via ffmpeg (see whisper_sidecar_mlx.py).
    // MediaRecorder constants: outputFormat 2 = MPEG_4, audioEncoder 3 = AAC.
    // (Previously outputFormat 3 / encoder 1 = AMR_NB — 8 kHz narrowband,
    //  poor transcription accuracy, and mislabelled `.wav`.)
    extension: '.m4a',
    outputFormat: 2,
    audioEncoder: 3,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
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

interface UseDictationArgs {
  wsService: WebSocketService | null;
  sessionId: string | undefined;
  onText: (text: string) => void;
  onError?: (message: string) => void;
}

export function useDictation({ wsService, sessionId, onText, onError }: UseDictationArgs) {
  const [micState, setMicState] = useState<MicState>('idle');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicePromptEnhanceEnabled = useSettingsStore((s) => s.voicePromptEnhanceEnabled);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      setMicState('idle');
      onError?.('Transkription abgebrochen (Zeitüberschreitung)');
    }, TRANSCRIPTION_TIMEOUT_MS);
  }, [clearWatchdog, onError]);

  // Server responses for THIS session only.
  useEffect(() => {
    if (!wsService || !sessionId) return;
    return wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: any };
      if (m.sessionId !== sessionId) return;
      if (m.type === 'audio:transcription') {
        clearWatchdog();
        setMicState('idle');
        const text = (m.payload?.text ?? '').trim();
        if (text) onText(text);
      } else if (m.type === 'audio:progress') {
        setMicState('processing');
        armWatchdog();
      } else if (m.type === 'audio:error') {
        clearWatchdog();
        setMicState('idle');
        onError?.(m.payload?.message ?? 'Transkription fehlgeschlagen');
      }
    });
  }, [wsService, sessionId, onText, onError, armWatchdog, clearWatchdog]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      clearWatchdog();
    };
  }, [clearWatchdog]);

  const toggle = useCallback(async () => {
    if (micState === 'processing' || !wsService || !sessionId) return;

    if (micState === 'recording') {
      setMicState('processing');
      try {
        const recording = recordingRef.current;
        if (!recording) { setMicState('idle'); return; }
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        recordingRef.current = null;
        if (!uri) { setMicState('idle'); return; }
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.deleteAsync(uri, { idempotent: true });
        wsService.send({
          type: 'audio:transcribe',
          sessionId,
          // `format: 'wav'` is a legacy gate string the server requires — the
          // sidecar sniffs the real container by magic bytes (RIFF→WAV else
          // ffmpeg), so iOS PCM-WAV and Android AAC/m4a both decode correctly.
          payload: { audio: base64, format: 'wav', enhance: voicePromptEnhanceEnabled },
        });
        armWatchdog();
      } catch {
        setMicState('idle');
        onError?.('Aufnahme konnte nicht gesendet werden');
      }
      return;
    }

    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { onError?.('Mikrofon-Berechtigung fehlt'); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS as any);
      recordingRef.current = recording;
      setMicState('recording');
    } catch {
      setMicState('idle');
      onError?.('Aufnahme konnte nicht gestartet werden');
    }
  }, [micState, wsService, sessionId, voicePromptEnhanceEnabled, armWatchdog, onError]);

  return { micState, toggle };
}
