import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { ConnectionState } from '../types/websocket.types';
import type { ConnectionQuality } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

interface Props {
  state: ConnectionState;
  rtt?: number;
  quality?: ConnectionQuality;
  jitter?: number;
}

const STATE_CONFIG: Record<ConnectionState, { dot: string; label: string; pulse: boolean }> = {
  connected:    { dot: colors.accent,      label: 'LIVE', pulse: true  },
  connecting:   { dot: colors.warning,     label: 'SYNC', pulse: true  },
  disconnected: { dot: colors.destructive, label: 'OFF',  pulse: false },
  error:        { dot: colors.destructive, label: 'ERR',  pulse: false },
};

const QUALITY_COLORS: Record<ConnectionQuality, string> = {
  good: colors.accent,     // green
  fair: colors.warning,    // yellow
  poor: '#FF8C00',         // orange
  bad:  colors.destructive, // red
};

export function ConnectionStatus({ state, rtt, quality = 'good', jitter }: Props) {
  const { rf, rs } = useResponsive();
  const opacity = useRef(new Animated.Value(1)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  const config = STATE_CONFIG[state];

  const dynamicStyles = useMemo(() => ({
    pill: { gap: rs(5), paddingHorizontal: rs(9), paddingVertical: rs(4) },
    dot: { width: rs(6), height: rs(6), borderRadius: rs(3) },
    label: { fontSize: rf(10) },
  }), [rf, rs]);

  useEffect(() => {
    loopRef.current?.stop();
    loopRef.current = null;
    if (config.pulse) {
      loopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.25, duration: 900, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1,    duration: 900, useNativeDriver: true }),
        ]),
      );
      loopRef.current.start();
    } else {
      opacity.stopAnimation();
      opacity.setValue(1);
    }
    return () => {
      loopRef.current?.stop();
      loopRef.current = null;
    };
  }, [state]);

  const showRtt = state === 'connected' && rtt !== undefined;
  const rttColor = showRtt ? QUALITY_COLORS[quality] : colors.textDim;

  return (
    <View style={[styles.pill, dynamicStyles.pill, { borderColor: config.dot + '55' }]}>
      <Animated.View style={[styles.dot, dynamicStyles.dot, { backgroundColor: config.dot, opacity }]} />
      <Text style={[styles.label, dynamicStyles.label, { color: config.dot }]}>{config.label}</Text>
      {showRtt && (
        <Text style={[styles.label, dynamicStyles.label, { color: rttColor }]}>
          {rtt! > 999 ? `${(rtt! / 1000).toFixed(1)}s` : `${rtt}ms`}
        </Text>
      )}
      {showRtt && jitter !== undefined && jitter > 30 && (
        <Text style={[styles.label, dynamicStyles.label, { color: colors.textDim }]}>
          ±{jitter}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.mono,
    letterSpacing: 0.8,
  },
});
