import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

interface Props {
  onResumeClean: () => void;
  onResumeInterject: () => void;
}

export function ResumeOptions({ onResumeClean, onResumeInterject }: Props) {
  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.opt} onPress={onResumeClean}>
        <Feather name="play" size={14} color="#F4EFE5" />
        <Text style={styles.txt}>Weiter wie zuvor</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.opt, styles.accent]} onPress={onResumeInterject}>
        <Feather name="arrow-right" size={14} color="#0a0807" />
        <Text style={[styles.txt, styles.txtAccent]}>Mit meinem Einwand fortsetzen</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 130,
    alignItems: 'center', gap: 10, paddingHorizontal: 26,
  },
  opt: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 22, paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(28,23,19,0.75)',
    borderWidth: 1, borderColor: 'rgba(214,139,78,0.25)',
    minWidth: 240, justifyContent: 'center',
  },
  accent: { backgroundColor: '#D68B4E', borderColor: 'transparent' },
  txt: { fontFamily: 'BricolageGrotesque_500Medium', fontSize: 13.5, color: '#F4EFE5' },
  txtAccent: { color: '#0a0807' },
});
