import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useVoiceStore } from '../../store/voiceStore';

interface Props {
  providerName: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

export function VoiceControls({ providerName, onPause, onResume, onCancel }: Props) {
  const phase = useVoiceStore((s) => s.phase);
  const pausedWithInterjection = useVoiceStore((s) => s.pausedWithInterjection);
  const isPaused = phase === 'paused';

  if (pausedWithInterjection) return null; // ResumeOptions takes over

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.danger]} onPress={onCancel}>
          <Feather name="x" size={24} color="rgba(228,120,115,0.9)" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.primary]}
          onPress={isPaused ? onResume : onPause}
        >
          <Feather name={isPaused ? 'play' : 'pause'} size={28} color="#0a0807" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => {}}>
          <Feather name="mic" size={24} color="#F4EFE5" />
        </TouchableOpacity>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>REM</Text>
        <View style={styles.sep} />
        <Text style={styles.metaProvider}>{providerName}</Text>
      </View>
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
  },
  primary: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: '#D68B4E', borderColor: 'rgba(243,181,122,0.5)',
    shadowColor: '#D68B4E', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5, shadowRadius: 20, elevation: 12,
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
});
