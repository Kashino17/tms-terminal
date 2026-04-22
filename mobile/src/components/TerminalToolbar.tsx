import React, { useState, useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Keyboard, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { WebSocketService } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { useSettingsStore } from '../store/settingsStore';

export const TOOLBAR_HEIGHT = 44;

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  rangeActive?: boolean;
  onRangeToggle?: () => void;
  onScrollToBottom?: () => void;
  onTranscription?: (text: string) => void;
  onTranscriptionError?: (message: string) => void;
}

export function TerminalToolbar({ sessionId, wsService, rangeActive = false, onRangeToggle, onScrollToBottom, onTranscription, onTranscriptionError }: Props) {
  const { rf, rs, ri } = useResponsive();
  const bottomAnim = useRef(new Animated.Value(0)).current;
  const [arrowsOpen, setArrowsOpen] = useState(false);
  const audioInputEnabled = useSettingsStore((s) => s.audioInputEnabled);
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [micError, setMicError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const showSub = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(bottomAnim, { toValue: e.endCoordinates.height, duration: e.duration > 0 ? e.duration : 220, useNativeDriver: false }).start();
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(bottomAnim, { toValue: 0, duration: e.duration > 0 ? e.duration : 220, useNativeDriver: false }).start();
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  useEffect(() => {
    if (micState === 'recording' || micState === 'processing') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.5, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [micState]);

  // Safety watchdog: if the server goes silent, reset the button after 60s.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (micState === 'processing') {
      watchdogRef.current = setTimeout(() => {
        console.warn('[mic] watchdog fired — server never responded');
        setMicState('idle');
        setMicError('Transkription reagiert nicht. Bitte erneut versuchen.');
        setTimeout(() => setMicError(null), 4000);
      }, 60_000);
    }
    return () => {
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    };
  }, [micState]);

  useEffect(() => {
    return wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: any };
      if (m.sessionId !== sessionId) return;
      if (m.type === 'audio:transcription') {
        setMicState('idle');
        setMicError(null);
        onTranscription?.(m.payload?.text ?? '');
      } else if (m.type === 'audio:error') {
        // busy = another transcription is still running; ignore silently, don't flip state.
        if (m.payload?.busy) return;
        setMicState('idle');
        const errMsg = m.payload?.message ?? 'Transkription fehlgeschlagen';
        setMicError(errMsg);
        setTimeout(() => setMicError(null), 4000);
        onTranscriptionError?.(errMsg);
      }
    });
  }, [wsService, sessionId, onTranscription, onTranscriptionError]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    };
  }, []);

  const send = (seq: string, action?: string) => {
    if (!sessionId) return;
    if (action === 'clear') { wsService.send({ type: 'terminal:clear', sessionId }); return; }
    wsService.send({ type: 'terminal:input', sessionId, payload: { data: seq } });
  };

  const handleMicPress = async () => {
    if (micState === 'processing') return;

    if (micState === 'recording') {
      // Stop recording and send
      if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
      setMicState('processing');
      try {
        const recording = recordingRef.current;
        if (!recording) { setMicState('idle'); return; }
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        recordingRef.current = null;
        if (!uri || !sessionId) { setMicState('idle'); return; }

        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.deleteAsync(uri, { idempotent: true });

        wsService.send({
          type: 'audio:transcribe',
          sessionId,
          payload: { audio: base64, format: 'wav' },
        });
      } catch (err) {
        console.warn('[mic] Error stopping recording:', err);
        setMicState('idle');
      }
      return;
    }

    // Start recording
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { console.warn('[mic] Permission denied'); return; }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync({
        android: {
          extension: '.wav',
          outputFormat: 3,
          audioEncoder: 1,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000,
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
      });

      recordingRef.current = recording;
      setRecordingDuration(0);
      setMicState('recording');
      durationTimerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      console.warn('[mic] Error starting recording:', err);
      setMicState('idle');
    }
  };

  const h = rs(36);
  const sm = ri(14);  // small icon
  const lg = ri(18);  // large icon for prominent buttons
  const fontSz = rf(11);
  const btnW = rs(40);

  // Compact arrow button
  const Arrow = ({ icon, seq }: { icon: string; seq: string }) => (
    <TouchableOpacity style={[s.arrowBtn, { width: h, height: h }]} onPress={() => send(seq)} activeOpacity={0.6}>
      <Feather name={icon as any} size={sm} color={colors.textMuted} />
    </TouchableOpacity>
  );

  // Small key button (flex: 1, for the middle keys)
  const Key = ({ label, seq, icon, action, accent }: { label: string; seq: string; icon?: string; action?: string; accent?: string }) => (
    <TouchableOpacity
      style={[s.key, { height: h, minWidth: rs(28) }]}
      onPress={() => send(seq, action)}
      activeOpacity={0.6}
      accessibilityLabel={label}
    >
      {icon
        ? <Feather name={icon as any} size={sm} color={accent || colors.text} />
        : <Text style={[s.keyText, { fontSize: fontSz }, accent ? { color: accent } : null]}>{label}</Text>
      }
    </TouchableOpacity>
  );

  // Large prominent button (fixed width, bigger icon)
  const BigBtn = ({ icon, onPress, color, active, activeColor }: { icon: string; onPress?: () => void; color: string; active?: boolean; activeColor?: string }) => (
    <TouchableOpacity
      style={[s.bigBtn, { height: h, width: btnW }, active && activeColor ? { backgroundColor: activeColor + '18', borderWidth: StyleSheet.hairlineWidth, borderColor: activeColor } : null]}
      onPress={onPress}
      activeOpacity={0.6}
    >
      <Feather name={icon as any} size={lg} color={active && activeColor ? activeColor : color} />
    </TouchableOpacity>
  );

  return (
    <Animated.View style={[s.bar, { bottom: bottomAnim, height: rs(TOOLBAR_HEIGHT), paddingHorizontal: rs(5), gap: rs(3) }]} accessibilityRole={'toolbar' as any}>
      {/* ── D-Pad toggle ─────────────────────────────── */}
      <TouchableOpacity
        style={[s.dpadToggle, { height: h, width: h }, arrowsOpen && s.dpadToggleActive]}
        onPress={() => setArrowsOpen((v) => !v)}
        activeOpacity={0.6}
      >
        <Feather name="navigation" size={sm} color={arrowsOpen ? colors.primary : colors.textDim} />
      </TouchableOpacity>

      {arrowsOpen && (
        <View style={[s.arrowGroup, { gap: rs(2) }]}>
          <Arrow icon="chevron-up" seq={'\x1b[A'} />
          <Arrow icon="chevron-down" seq={'\x1b[B'} />
          <Arrow icon="chevron-left" seq={'\x1b[D'} />
          <Arrow icon="chevron-right" seq={'\x1b[C'} />
          <TouchableOpacity
            style={[s.arrowBtn, { width: h, height: h }, rangeActive && { backgroundColor: colors.accent + '18', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent }]}
            onPress={onRangeToggle}
            activeOpacity={0.6}
          >
            <Feather name="scissors" size={sm} color={rangeActive ? colors.accent : colors.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      <View style={s.sep} />

      {/* ── Action keys ──────────────────────────────── */}
      <View style={[s.actionKeys, { gap: rs(3) }]}>
        <Key label="Esc" seq={'\x1b'} />
        <Key label="^C" seq={'\x03'} accent={colors.destructive} />
        <Key label="" seq="" icon="trash" action="clear" />
        <Key label="" seq={'\x15'} icon="delete" />
      </View>

      <View style={s.sep} />

      {/* ── Prominent buttons: Mic, Scroll, Enter ────── */}
      {audioInputEnabled && micError && micState === 'idle' && (
        <View style={[s.errorBar, { height: h }]}>
          <Feather name="alert-circle" size={sm} color={colors.destructive} />
          <Text style={[s.keyText, { fontSize: fontSz, color: colors.destructive, flex: 1 }]} numberOfLines={1}>{micError}</Text>
        </View>
      )}
      {audioInputEnabled && !micError && micState === 'processing' && (
        <Animated.View style={[s.processingBar, { height: h, opacity: pulseAnim }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[s.keyText, { fontSize: fontSz, color: colors.primary }]}>Transkribiert…</Text>
        </Animated.View>
      )}
      {audioInputEnabled && !micError && micState !== 'processing' && (
        <>
          <Animated.View style={{ opacity: micState === 'recording' ? pulseAnim : 1 }}>
            <TouchableOpacity
              style={[
                s.bigBtn,
                { height: h, width: btnW },
                micState === 'recording' && { backgroundColor: 'rgba(239,68,68,0.15)', borderWidth: StyleSheet.hairlineWidth, borderColor: '#ef4444' },
              ]}
              onPress={handleMicPress}
              activeOpacity={0.6}
            >
              <Feather name="mic" size={lg} color={micState === 'recording' ? '#ef4444' : colors.textDim} />
            </TouchableOpacity>
          </Animated.View>
          {micState === 'recording' && (
            <Text style={[s.keyText, { fontSize: fontSz, color: '#ef4444', minWidth: rs(28), textAlign: 'center' }]}>
              {Math.floor(recordingDuration / 60)}:{String(recordingDuration % 60).padStart(2, '0')}
            </Text>
          )}
        </>
      )}
      <BigBtn icon="chevrons-down" onPress={onScrollToBottom} color={colors.info} />
      <BigBtn icon="corner-down-left" onPress={() => send('\r')} color={colors.text} />
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: TOOLBAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    zIndex: 50,
  },
  dpadToggle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  dpadToggleActive: {
    backgroundColor: 'rgba(59,130,246,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
  },
  arrowGroup: {
    flexDirection: 'row',
    flexShrink: 1,
  },
  actionKeys: {
    flex: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  arrowBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  key: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  keyText: {
    color: colors.text,
    fontWeight: '700',
    fontFamily: fonts.mono,
    letterSpacing: 0.3,
  },
  bigBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.destructive,
    flex: 1,
  },
  processingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(59,130,246,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
  },
  sep: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: colors.border,
    marginHorizontal: 2,
  },
});
