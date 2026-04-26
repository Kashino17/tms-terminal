import React, { useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../../theme';

export type VoiceFullscreenState = 'recording' | 'processing';

interface Props {
  visible: boolean;
  state: VoiceFullscreenState;
  /** Recording time in seconds (positive). When `state==='processing'`, ignored. */
  duration: number;
  /** Called when user discards the recording. */
  onCancel: () => void;
  /** Called when user accepts — should stop and send to STT. */
  onSend: () => void;
}

/**
 * Fullscreen voice capture overlay for Manager Chat V2.
 *
 * Replaces the inline mic experience for users who want a focused, "phone-call"
 * style recording — big pulsing target, prominent timer, two-finger reach for
 * cancel/send. Falls back to a "Wird transkribiert…" state once the user hits
 * Send and the audio is on its way to Whisper.
 *
 * The pulse animation is decorative — we don't yet have real-time audio levels
 * from `Audio.Recording`, so the circle just breathes at a fixed cadence to
 * give visual confirmation that the mic is hot.
 */
export function VoiceFullscreen({ visible, state, duration, onCancel, onSend }: Props) {
  const pulse = useRef(new Animated.Value(0)).current;

  // Pulsing loop while recording. Stops cleanly when the modal closes so the
  // animation driver doesn't churn in the background.
  useEffect(() => {
    if (!visible || state !== 'recording') {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, state, pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0.05] });
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });

  const isProcessing = state === 'processing';
  const mm = Math.floor(duration / 60);
  const ss = duration % 60;
  const timeStr = `${mm}:${ss.toString().padStart(2, '0')}`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={s.overlay}>
        {/* Top status pill */}
        <View style={s.statusPill}>
          <View style={[s.statusDot, isProcessing && { backgroundColor: colors.warning }]} />
          <Text style={s.statusText}>
            {isProcessing ? 'Wird transkribiert…' : 'Aufnahme läuft'}
          </Text>
        </View>

        {/* Pulsing circle */}
        <View style={s.circleWrap}>
          <Animated.View
            style={[
              s.ring,
              { opacity: ringOpacity, transform: [{ scale: ringScale }] },
            ]}
          />
          <Animated.View style={[s.core, { transform: [{ scale }] }]}>
            <Feather
              name={isProcessing ? 'loader' : 'mic'}
              size={42}
              color="#fff"
            />
          </Animated.View>
        </View>

        {/* Duration */}
        <Text style={s.duration}>{isProcessing ? '·' : timeStr}</Text>
        <Text style={s.hint}>
          {isProcessing
            ? 'Whisper analysiert deine Aufnahme…'
            : 'Sprich frei. Tippe ✓ zum Senden, ✕ zum Verwerfen.'}
        </Text>

        {/* Controls — hidden during processing because the actions are no-ops then */}
        {!isProcessing && (
          <View style={s.controls}>
            <TouchableOpacity style={[s.ctrlBtn, s.ctrlCancel]} onPress={onCancel}>
              <Feather name="x" size={26} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={[s.ctrlBtn, s.ctrlSend]} onPress={onSend}>
              <Feather name="check" size={26} color="#fff" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(8,12,20,0.97)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  statusPill: {
    position: 'absolute',
    top: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.destructive,
  },
  statusText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },

  circleWrap: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  ring: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  core: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 24,
    elevation: 12,
  },

  duration: {
    fontFamily: fonts.mono,
    fontSize: 44,
    fontWeight: '300',
    color: colors.text,
    letterSpacing: 2,
    marginTop: 4,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 10,
    maxWidth: 280,
    lineHeight: 18,
  },

  controls: {
    position: 'absolute',
    bottom: 80,
    flexDirection: 'row',
    gap: 36,
  },
  ctrlBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  ctrlCancel: { backgroundColor: colors.destructive },
  ctrlSend: { backgroundColor: colors.accent },
});
