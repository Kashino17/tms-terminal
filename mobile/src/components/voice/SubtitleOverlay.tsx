import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useVoiceStore } from '../../store/voiceStore';

export function SubtitleOverlay() {
  const userTranscript = useVoiceStore((s) => s.userTranscript);
  const aiStreaming = useVoiceStore((s) => s.aiStreaming);
  const aiSpokenWordCount = useVoiceStore((s) => s.aiSpokenWordCount);
  const phase = useVoiceStore((s) => s.phase);

  const showUser = !!userTranscript && (phase === 'listening' || phase === 'transcribing' || phase === 'thinking');
  const showAi = !!aiStreaming && (phase === 'thinking' || phase === 'tool_call' || phase === 'speaking' || phase === 'paused');

  const words = aiStreaming.split(/(\s+)/);
  let wordIdx = 0;

  return (
    <View style={styles.container} pointerEvents="none">
      {showUser && (
        <View style={styles.userBubble}>
          <Text style={styles.userLabel}>DU</Text>
          <Text style={styles.userText}>{userTranscript}</Text>
        </View>
      )}
      {showAi && (
        <Text style={styles.subtitle}>
          {words.map((w, i) => {
            if (/^\s+$/.test(w)) return <Text key={i}>{w}</Text>;
            const isSpoken = wordIdx < aiSpokenWordCount;
            const isActive = wordIdx === aiSpokenWordCount;
            wordIdx++;
            const style = isActive ? styles.wordActive : isSpoken ? styles.wordSpoken : styles.word;
            return <Text key={i} style={style}>{w}</Text>;
          })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 180,
    paddingHorizontal: 26,
    alignItems: 'center',
    gap: 6,
  },
  subtitle: {
    fontFamily: 'Fraunces_400Regular_Italic',
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.2,
    color: '#F4EFE5',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 20,
    maxWidth: 540,
  },
  word: { color: '#F4EFE5' },
  wordSpoken: { color: '#C8BFB0' },
  wordActive: { color: '#F3B57A' },
  userBubble: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: 'rgba(20,16,13,0.5)',
    borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(244,239,229,0.08)',
    maxWidth: 440,
  },
  userLabel: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 9.5, letterSpacing: 2,
    color: '#8A8275', opacity: 0.6,
    marginBottom: 4, textTransform: 'uppercase',
  },
  userText: {
    fontFamily: 'BricolageGrotesque_400Regular',
    fontSize: 15, lineHeight: 21,
    color: '#8A8275', textAlign: 'center',
  },
});
