import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { VoicePhase } from '../../store/voiceStore';

const LABELS: Record<VoicePhase, string> = {
  idle: 'Bereit',
  listening: 'Hört zu',
  transcribing: 'Transkribiert',
  thinking: 'Denkt nach',
  tool_call: 'Arbeitet mit Tools',
  speaking: 'Rem spricht',
  paused: 'Pause',
};

const COLORS: Record<VoicePhase, string> = {
  idle: '#D68B4E',
  listening: '#88D4A0',
  transcribing: '#E8A94C',
  thinking: '#E8A94C',
  tool_call: '#B5A1EA',
  speaking: '#D68B4E',
  paused: '#9AA2A8',
};

export function StatusPill({ phase }: { phase: VoicePhase }) {
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: COLORS[phase], shadowColor: COLORS[phase] }]} />
      <Text style={styles.label}>{LABELS[phase]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingLeft: 10, paddingRight: 14, paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(28,23,19,0.55)',
    borderWidth: 1, borderColor: 'rgba(214,139,78,0.2)',
  },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 1, shadowRadius: 12,
  },
  label: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 12.5, letterSpacing: 0.4,
    color: '#C8BFB0', textTransform: 'uppercase',
  },
});
