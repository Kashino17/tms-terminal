import React, { useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useVoiceStore } from '../../store/voiceStore';

interface Props {
  providerName: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onForceTurnEnd: () => void;
}

const DEFAULT_PROVIDER = 'Rem';

export function VoiceControls({ providerName, onPause, onResume, onCancel, onForceTurnEnd }: Props) {
  const phase = useVoiceStore((s) => s.phase);
  const pausedWithInterjection = useVoiceStore((s) => s.pausedWithInterjection);
  const isPaused = phase === 'paused';

  if (pausedWithInterjection) return null;

  // Primary button — icon crossfade + rotate on state change
  const iconOpacityA = useRef(new Animated.Value(isPaused ? 0 : 1)).current;
  const iconOpacityB = useRef(new Animated.Value(isPaused ? 1 : 0)).current;
  const iconRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    iconRotate.setValue(-8);
    Animated.parallel([
      Animated.timing(iconOpacityA, { toValue: isPaused ? 0 : 1, duration: 250, useNativeDriver: true }),
      Animated.timing(iconOpacityB, { toValue: isPaused ? 1 : 0, duration: 250, useNativeDriver: true, delay: 100 }),
      Animated.timing(iconRotate,   { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
    ]).start();
  }, [isPaused, iconOpacityA, iconOpacityB, iconRotate]);

  // Primary button — scale + ripple on press
  const pressScale = useRef(new Animated.Value(1)).current;
  const [ripples, setRipples] = useState<{ id: number; scale: Animated.Value; opacity: Animated.Value }[]>([]);
  const rippleIdRef = useRef(0);

  const triggerRipple = () => {
    const id = ++rippleIdRef.current;
    const scale = new Animated.Value(0);
    const opacity = new Animated.Value(0.35);
    setRipples((r) => [...r, { id, scale, opacity }]);
    Animated.parallel([
      Animated.timing(scale,   { toValue: 1.8, duration: 450, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0,   duration: 450, useNativeDriver: true }),
    ]).start(() => {
      setRipples((r) => r.filter((x) => x.id !== id));
    });
  };

  const handlePrimaryPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    triggerRipple();
    Animated.sequence([
      Animated.timing(pressScale, { toValue: 0.93, duration: 80,  useNativeDriver: true }),
      Animated.spring(pressScale, { toValue: 1,    useNativeDriver: true }),
    ]).start();
    if (isPaused) onResume(); else onPause();
  };

  // Mic button — force turn end, enabled only during speaking/thinking
  const micEnabled = phase === 'speaking' || phase === 'thinking';
  const handleMicPress = () => {
    if (!micEnabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onForceTurnEnd();
  };

  const rotateDeg = iconRotate.interpolate({ inputRange: [-8, 0], outputRange: ['-8deg', '0deg'] });
  const showMeta = providerName !== DEFAULT_PROVIDER;

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.danger]} onPress={onCancel}>
          <Feather name="x" size={24} color="rgba(228,120,115,0.9)" />
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.85}
          style={styles.primaryTouch}
          onPress={handlePrimaryPress}
        >
          <Animated.View style={[styles.btn, styles.primary, { transform: [{ scale: pressScale }] }]}>
            {ripples.map((r) => (
              <Animated.View
                key={r.id}
                pointerEvents="none"
                style={[
                  styles.ripple,
                  { opacity: r.opacity, transform: [{ scale: r.scale }] },
                ]}
              />
            ))}
            <Animated.View style={{ position: 'absolute', opacity: iconOpacityA, transform: [{ rotate: rotateDeg }] }}>
              <Feather name="pause" size={28} color="#0a0807" />
            </Animated.View>
            <Animated.View style={{ position: 'absolute', opacity: iconOpacityB, transform: [{ rotate: rotateDeg }] }}>
              <Feather name="play" size={28} color="#0a0807" />
            </Animated.View>
          </Animated.View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.btn, !micEnabled && styles.btnDisabled]}
          onPress={handleMicPress}
          activeOpacity={micEnabled ? 0.7 : 1}
        >
          <Feather name="mic" size={24} color={micEnabled ? '#F4EFE5' : 'rgba(244,239,229,0.45)'} />
          {micEnabled && <Text style={styles.micLabel}>unterbrechen</Text>}
        </TouchableOpacity>
      </View>
      {showMeta && (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>REM</Text>
          <View style={styles.sep} />
          <Text style={styles.metaProvider}>{providerName}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 40,
    alignItems: 'center', gap: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  btn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(28,23,19,0.7)',
    borderWidth: 1, borderColor: 'rgba(244,239,229,0.14)',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  primaryTouch: {
    width: 78, height: 78, borderRadius: 39,
    alignItems: 'center', justifyContent: 'center',
  },
  primary: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: '#D68B4E', borderColor: 'rgba(243,181,122,0.5)',
    shadowColor: '#D68B4E', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5, shadowRadius: 20, elevation: 12,
  },
  ripple: {
    position: 'absolute',
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: '#F3B57A',
  },
  danger: {},
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaLabel: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 11.5, letterSpacing: 2,
    color: '#8A8275', textTransform: 'uppercase',
  },
  metaProvider: {
    fontFamily: 'Fraunces_400Regular_Italic',
    fontSize: 13, letterSpacing: 0.3,
    color: '#C8BFB0',
  },
  sep: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#8A8275', opacity: 0.5 },
  micLabel: {
    position: 'absolute',
    bottom: -18,
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 8.5, letterSpacing: 1.8,
    color: '#8A8275', textTransform: 'uppercase',
    opacity: 0.75,
  },
});
