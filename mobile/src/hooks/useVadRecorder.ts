import { useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

export interface VadRecorderConfig {
  silenceMs?: number;           // default 800ms
  silenceDb?: number;           // default -40 dB
  chunkMs?: number;             // default 200ms (metering interval)
  onChunk?: (base64Pcm: string) => void;
  onSpeechStart?: () => void;
  onSilenceDetected?: () => void;
}

export function useVadRecorder(enabled: boolean, cfg: VadRecorderConfig = {}) {
  const {
    silenceMs = 800,
    silenceDb = -40,
    chunkMs = 200,
    onSpeechStart,
    onSilenceDetected,
  } = cfg;

  const [status, setStatus] = useState<'idle' | 'listening' | 'speaking' | 'error'>('idle');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpokenRef = useRef(false);
  const onSpeechStartRef = useRef(onSpeechStart);
  const onSilenceDetectedRef = useRef(onSilenceDetected);

  useEffect(() => { onSpeechStartRef.current = onSpeechStart; }, [onSpeechStart]);
  useEffect(() => { onSilenceDetectedRef.current = onSilenceDetected; }, [onSilenceDetected]);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    start().catch((e) => { console.warn('VAD start failed', e); setStatus('error'); });
    return () => { stop(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  async function start() {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) { setStatus('error'); return; }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync({
      android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
      ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
      web: {},
      isMeteringEnabled: true,
    } as any);

    rec.setOnRecordingStatusUpdate((s) => {
      if (!('metering' in s) || typeof s.metering !== 'number') return;
      const db = s.metering;
      if (db > silenceDb) {
        if (!hasSpokenRef.current) { hasSpokenRef.current = true; setStatus('speaking'); onSpeechStartRef.current?.(); }
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      } else if (hasSpokenRef.current && !silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => { onSilenceDetectedRef.current?.(); }, silenceMs);
      }
    });
    rec.setProgressUpdateInterval(chunkMs);
    await rec.startAsync();
    recordingRef.current = rec;
    setStatus('listening');
    hasSpokenRef.current = false;

    // V1: onChunk is reserved for a future expo-av streaming upgrade; unused now.
  }

  async function stop() {
    try {
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync();
        recordingRef.current = null;
      }
    } catch {}
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    setStatus('idle');
  }

  /** Stop recording and return the base64-encoded WAV. */
  async function finish(): Promise<string | null> {
    try {
      const rec = recordingRef.current;
      if (!rec) return null;
      await rec.stopAndUnloadAsync();
      recordingRef.current = null;
      const uri = rec.getURI();
      if (!uri) return null;
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      setStatus('idle');
      return b64;
    } catch { return null; }
  }

  return { status, finish };
}
