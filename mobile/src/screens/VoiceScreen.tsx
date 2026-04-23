import React, { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, StatusBar, Text, AppState } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

import { useVoiceStore } from '../store/voiceStore';
import { AudioPlayerQueue } from '../services/AudioPlayerQueue';
import { VoiceClient } from '../services/VoiceClient';
import type { WebSocketService } from '../services/websocket.service';

import { CharacterWebView } from '../components/voice/CharacterWebView';
import { SubtitleOverlay } from '../components/voice/SubtitleOverlay';
import { VoiceControls } from '../components/voice/VoiceControls';
import { ResumeOptions } from '../components/voice/ResumeOptions';
import { StatusPill } from '../components/voice/StatusPill';
import type { RootStackParamList } from '../types/navigation.types';

type VoiceScreenRouteProp = RouteProp<RootStackParamList, 'Voice'>;

export function VoiceScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<VoiceScreenRouteProp>();
  const { wsService } = route.params;

  const phase = useVoiceStore((s) => s.phase);
  const pausedWithInterjection = useVoiceStore((s) => s.pausedWithInterjection);
  const errorBanner = useVoiceStore((s) => s.errorBanner);
  const setPhase = useVoiceStore((s) => s.setPhase);
  const setUserTranscript = useVoiceStore((s) => s.setUserTranscript);
  const appendAiDelta = useVoiceStore((s) => s.appendAiDelta);
  const markWordSpoken = useVoiceStore((s) => s.markWordSpoken);
  const setError = useVoiceStore((s) => s.setError);
  const resetTurn = useVoiceStore((s) => s.resetTurn);
  const setPausedWithInterjection = useVoiceStore((s) => s.setPausedWithInterjection);

  const audioQueue = useRef(new AudioPlayerQueue()).current;

  // VAD recorder refs
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpokenRef = useRef(false);
  const speechSustainStartRef = useRef<number | null>(null);

  // Keep a ref to the current phase so that the stable VoiceClient closure
  // can read the latest value without needing to be recreated each render.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const client = useMemo(() => {
    if (!wsService) return null;
    return new VoiceClient(wsService as WebSocketService, {
      onPhase: (p) => {
        setPhase(p);
        // Coordinate audio queue pause/resume with server phase.
        // Fire-and-forget — audioQueue methods return Promise but errors are swallowed.
        if (p === 'paused') audioQueue.pause();
        else if (p === 'speaking') audioQueue.resume();
      },
      onTranscript: (t, final) => {
        setUserTranscript(t);
        if (final && phaseRef.current === 'paused' && t.trim().length >= 20) {
          setPausedWithInterjection(true, t);
        }
      },
      onAiDelta: (t) => appendAiDelta(t),
      onTtsChunk: (_idx, audio, sentence, _isLast) => {
        if (audio) audioQueue.enqueue(audio);
        if (sentence) markWordSpoken(sentence);
      },
      onAckAudio: (_kind, audio) => audioQueue.enqueue(audio),
      onError: (msg) => setError(msg),
    });
    // wsService reference is stable for the lifetime of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsService]);

  // Auto-pause when app goes to background while AI is speaking
  useEffect(() => {
    if (!client) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && phase === 'speaking') {
        client.pause();
      }
    });
    return () => sub.remove();
  }, [client, phase]);

  useEffect(() => {
    if (!client) return;
    client.subscribe();
    client.start();
    return () => {
      client.stop();
      client.dispose();
      audioQueue.stop();
      resetTurn();
    };
  }, [client]);

  // Recorder lifecycle: start when listening, stop when not
  useEffect(() => {
    if (!client) return;
    if (phase !== 'listening') {
      // Stop any ongoing recording
      (async () => {
        if (recordingRef.current) {
          try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
          recordingRef.current = null;
        }
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        hasSpokenRef.current = false;
        speechSustainStartRef.current = null;
      })();
      return;
    }

    // Start recording for listening phase
    let cancelled = false;
    (async () => {
      try {
        const { granted } = await Audio.requestPermissionsAsync();
        if (!granted) { setError('Mikrofon-Zugriff verweigert'); return; }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

        const rec = new Audio.Recording();
        await rec.prepareToRecordAsync({
          android: {
            extension: '.wav',
            outputFormat: 3,
            audioEncoder: 1,
            audioSource: 7, // VOICE_COMMUNICATION → enables hardware AEC/NS/AGC on Android
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 256000,
          },
          ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
          web: {},
          isMeteringEnabled: true,
        } as any);

        if (cancelled) { try { await rec.stopAndUnloadAsync(); } catch {} return; }

        rec.setOnRecordingStatusUpdate(async (s) => {
          if (!('metering' in s) || typeof s.metering !== 'number') return;
          const SPEECH_THRESHOLD_DB = -32;
          const SUSTAIN_MIN_MS = 150;

          if (s.metering > SPEECH_THRESHOLD_DB) {
            if (speechSustainStartRef.current === null) {
              speechSustainStartRef.current = Date.now();
            } else if (
              !hasSpokenRef.current &&
              Date.now() - speechSustainStartRef.current >= SUSTAIN_MIN_MS
            ) {
              hasSpokenRef.current = true;
            }
            if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
          } else {
            speechSustainStartRef.current = null;
            if (hasSpokenRef.current && !silenceTimerRef.current) {
              silenceTimerRef.current = setTimeout(async () => {
                silenceTimerRef.current = null;
                try {
                  const current = recordingRef.current;
                  if (!current) return;
                  const uri = current.getURI();
                  await current.stopAndUnloadAsync();
                  recordingRef.current = null;
                  hasSpokenRef.current = false;
                  speechSustainStartRef.current = null;
                  if (uri) {
                    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                    client.sendAudioChunk(b64);
                    client.endTurn();
                  }
                } catch {
                  setError('Turn-Ende fehlgeschlagen');
                }
              }, 800);
            }
          }
        });
        rec.setProgressUpdateInterval(200);
        await rec.startAsync();
        if (cancelled) { try { await rec.stopAndUnloadAsync(); } catch {} return; }
        recordingRef.current = rec;
      } catch {
        setError('Mikrofon konnte nicht gestartet werden');
      }
    })();

    return () => {
      cancelled = true;
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      hasSpokenRef.current = false;
      speechSustainStartRef.current = null;
    };
  }, [phase, client]);

  const handlePause = () => client?.pause();
  const handleResume = () => {
    setPausedWithInterjection(false);
    client?.resume('clean');
  };
  const handleResumeInterject = () => {
    setPausedWithInterjection(false);
    client?.resume('with_interjection');
  };
  const handleCancel = () => client?.cancel();
  const handleClose = () => {
    client?.stop();
    navigation.goBack();
  };

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <CharacterWebView phase={phase} />

      <View style={styles.topbar}>
        <StatusPill phase={phase} />
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
          <Feather name="x" size={16} color="#C8BFB0" />
        </TouchableOpacity>
      </View>

      {errorBanner && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorBanner}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Feather name="x" size={14} color="#F4EFE5" />
          </TouchableOpacity>
        </View>
      )}

      <SubtitleOverlay />

      {pausedWithInterjection ? (
        <ResumeOptions
          onResumeClean={handleResume}
          onResumeInterject={handleResumeInterject}
        />
      ) : (
        <VoiceControls
          providerName="Rem"
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0807' },
  topbar: {
    position: 'absolute',
    top: 54, left: 18, right: 18,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  closeBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(28,23,19,0.55)',
    borderWidth: 1, borderColor: 'rgba(244,239,229,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  errorBanner: {
    position: 'absolute', top: 100, left: 18, right: 18,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(180,60,60,0.85)',
    zIndex: 10,
  },
  errorText: { flex: 1, color: '#F4EFE5', fontFamily: 'BricolageGrotesque_400Regular', fontSize: 13 },
});
