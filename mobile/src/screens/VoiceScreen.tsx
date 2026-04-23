import React, { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, StatusBar, Text } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';

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
