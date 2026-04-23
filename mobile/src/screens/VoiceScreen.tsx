import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, StatusBar, Text, AppState } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as NavigationBar from 'expo-navigation-bar';

import { useVoiceStore } from '../store/voiceStore';
import type { VoicePhase } from '../store/voiceStore';
import { AudioPlayerQueue } from '../services/AudioPlayerQueue';
import { VoiceClient } from '../services/VoiceClient';
import type { WebSocketService } from '../services/websocket.service';

import { CharacterWebView } from '../components/voice/CharacterWebView';
import { SubtitleOverlay } from '../components/voice/SubtitleOverlay';
import { VoiceControls } from '../components/voice/VoiceControls';
import { ResumeOptions } from '../components/voice/ResumeOptions';
import { StatusPill } from '../components/voice/StatusPill';
import { PhaseHint } from '../components/voice/PhaseHint';
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
  const setListeningWarmup = useVoiceStore((s) => s.setListeningWarmup);

  const audioQueue = useRef(new AudioPlayerQueue()).current;

  const [closeConfirmVisible, setCloseConfirmVisible] = useState(false);
  const closeConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // VAD recorder refs
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpokenRef = useRef(false);
  const speechSustainStartRef = useRef<number | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousPhaseRef = useRef<VoicePhase>('idle');

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
        if (audio) audioQueue.enqueue(audio, sentence || null);
        // markWordSpoken fires via audioQueue.onChunkStart (wired below)
      },
      onAckAudio: (_kind, audio) => audioQueue.enqueue(audio),
      onError: (msg) => setError(msg),
    });
    // wsService reference is stable for the lifetime of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsService]);

  // True fullscreen on Android — hide the navigation bar while Voice is open
  // and restore it on exit. iOS has no nav bar; NavigationBar calls are no-ops
  // on iOS per the expo-navigation-bar docs.
  useEffect(() => {
    NavigationBar.setVisibilityAsync('hidden').catch(() => {});
    NavigationBar.setBehaviorAsync('overlay-swipe').catch(() => {});
    return () => {
      NavigationBar.setVisibilityAsync('visible').catch(() => {});
    };
  }, []);

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
    audioQueue.setOnChunkStart((sentence) => markWordSpoken(sentence));
    client.subscribe();
    client.start();
    return () => {
      audioQueue.setOnChunkStart(undefined);
      client.stop();
      client.dispose();
      audioQueue.stop();
      resetTurn();
      if (closeConfirmTimerRef.current) { clearTimeout(closeConfirmTimerRef.current); closeConfirmTimerRef.current = null; }
    };
  }, [client]);

  // Recorder lifecycle: start when listening, stop when not. Uses a 600ms
  // cooldown when transitioning from 'speaking' → 'listening' to let the
  // speaker buffer drain and hardware AEC re-calibrate.
  useEffect(() => {
    if (!client) return;

    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;

    if (phase !== 'listening') {
      // Stop any ongoing recording and pending cooldown
      (async () => {
        if (cooldownTimerRef.current) {
          clearTimeout(cooldownTimerRef.current);
          cooldownTimerRef.current = null;
        }
        setListeningWarmup(false);
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

    // phase === 'listening' — decide if we need cooldown.
    // Wait for audio queue to actually drain (TTS is usually still playing
    // after the server transitions to 'listening'), THEN 300ms room-echo buffer.
    const needsCooldown = previousPhase === 'speaking' || !audioQueue.isIdle();

    let cancelled = false;

    const startRecording = async () => {
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
            audioSource: 7, // VOICE_COMMUNICATION → hardware AEC/NS/AGC
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
                    setPhase('transcribing');
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
    };

    if (needsCooldown) {
      setListeningWarmup(true);

      const POLL_INTERVAL_MS = 80;
      const POST_DRAIN_BUFFER_MS = 300;

      const pollDrain = () => {
        if (cancelled) return;
        if (audioQueue.isIdle()) {
          // Audio has fully drained — add short buffer for room-echo decay.
          cooldownTimerRef.current = setTimeout(() => {
            cooldownTimerRef.current = null;
            if (cancelled) return;
            setListeningWarmup(false);
            startRecording();
          }, POST_DRAIN_BUFFER_MS);
          return;
        }
        cooldownTimerRef.current = setTimeout(pollDrain, POLL_INTERVAL_MS);
      };

      pollDrain();
    } else {
      startRecording();
    }

    return () => {
      cancelled = true;
      if (cooldownTimerRef.current) { clearTimeout(cooldownTimerRef.current); cooldownTimerRef.current = null; }
      setListeningWarmup(false);
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
  const handleForceTurnEnd = () => {
    audioQueue.stop();
    client?.cancel();
  };
  const handleClose = () => {
    if (closeConfirmVisible) {
      if (closeConfirmTimerRef.current) {
        clearTimeout(closeConfirmTimerRef.current);
        closeConfirmTimerRef.current = null;
      }
      client?.stop();
      navigation.goBack();
      return;
    }
    setCloseConfirmVisible(true);
    if (closeConfirmTimerRef.current) clearTimeout(closeConfirmTimerRef.current);
    closeConfirmTimerRef.current = setTimeout(() => {
      closeConfirmTimerRef.current = null;
      setCloseConfirmVisible(false);
    }, 2000);
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

      {closeConfirmVisible && (
        <View style={styles.closeConfirm} pointerEvents="none">
          <Text style={styles.closeConfirmText}>Nochmal tippen zum Beenden</Text>
        </View>
      )}

      <PhaseHint />

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
          onForceTurnEnd={handleForceTurnEnd}
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
  closeConfirm: {
    position: 'absolute',
    top: 100,
    alignSelf: 'center',
    paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(28,23,19,0.85)',
    borderWidth: 1, borderColor: 'rgba(214,139,78,0.25)',
    zIndex: 11,
  },
  closeConfirmText: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 12, letterSpacing: 1.5,
    color: '#F4EFE5', textTransform: 'uppercase',
  },
});
