import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useVoiceStore } from '../../store/voiceStore';
import type { VoicePhase } from '../../store/voiceStore';

interface HintCopy { primary: string; secondary: string; }

const HINTS: Record<VoicePhase, HintCopy> = {
  idle:          { primary: 'Tippe und sprich', secondary: 'bereit' },
  listening:     { primary: 'Sprich jetzt', secondary: 'Mikrofon aktiv' },
  transcribing:  { primary: 'Verstehe dich', secondary: 'Transkription läuft' },
  thinking:      { primary: 'Rem überlegt', secondary: 'Antwort gleich da' },
  tool_call:     { primary: 'Rem arbeitet', secondary: 'Terminal-Aktion' },
  speaking:      { primary: 'Rem antwortet', secondary: 'Mikrofon unterbricht' },
  paused:        { primary: 'Pause', secondary: 'Tippe ▶︎ zum Fortsetzen' },
};

const WARMUP: HintCopy = { primary: 'Moment…', secondary: 'Mikrofon startet' };

export function PhaseHint() {
  const phase = useVoiceStore((s) => s.phase);
  const listeningWarmup = useVoiceStore((s) => s.listeningWarmup);
  const aiStreaming = useVoiceStore((s) => s.aiStreaming);

  const copy: HintCopy =
    phase === 'listening' && listeningWarmup ? WARMUP : HINTS[phase];

  // Fade down to 0.4 while subtitle is on screen during 'speaking'
  const subtitleVisible = !!aiStreaming && (phase === 'speaking' || phase === 'thinking');
  const targetOpacity = subtitleVisible ? 0.4 : 1;

  const opacity = useRef(new Animated.Value(targetOpacity)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const keyRef = useRef<string>(copy.primary + '|' + copy.secondary);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    const nextKey = copy.primary + '|' + copy.secondary;

    // Cancel any in-flight animation so we never layer conflicting tweens.
    animRef.current?.stop();

    if (nextKey === keyRef.current) {
      // Same copy, just dim/undim for subtitle overlay case.
      animRef.current = Animated.timing(opacity, {
        toValue: targetOpacity,
        duration: 250,
        useNativeDriver: true,
      });
      animRef.current.start();
      return;
    }
    keyRef.current = nextKey;

    animRef.current = Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity,    { toValue: 0, duration: 400, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 6, duration: 400, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(translateY, { toValue: -6, duration: 0, useNativeDriver: true }),
        Animated.timing(opacity,    { toValue: targetOpacity, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]),
    ]);
    animRef.current.start();
  }, [copy.primary, copy.secondary, targetOpacity, opacity, translateY]);

  return (
    <View style={styles.container} pointerEvents="none">
      <Animated.View style={{ opacity, transform: [{ translateY }] }}>
        <Text style={styles.primary}>{copy.primary}</Text>
        <Text style={styles.secondary}>{copy.secondary}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0,
    top: '56%',
    alignItems: 'center',
    paddingHorizontal: 26,
  },
  primary: {
    fontFamily: 'Fraunces_400Regular_Italic',
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.3,
    color: '#F4EFE5',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 24,
  },
  secondary: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 9.5,
    letterSpacing: 2.1,
    textTransform: 'uppercase',
    color: '#8A8275',
    opacity: 0.75,
    textAlign: 'center',
    marginTop: 8,
  },
});
