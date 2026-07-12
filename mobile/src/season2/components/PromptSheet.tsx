/**
 * Season 2 permission sheet — appears when the server detects an AI-tool
 * permission prompt (`terminal:prompt_detected`) and the terminal's
 * Auto-Approve is OFF. Shows the source terminal, anchors ABOVE the dock,
 * and answers with a real Enter keystroke into that PTY.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { IconDot } from '../icons';

export interface PendingPrompt {
  sessionId: string;
  title: string;
  color: string;
}

interface PromptSheetProps {
  prompt: PendingPrompt;
  onApprove: () => void;
  onDismiss: () => void;
  onEnableAuto: () => void;
  bottomOffset: number;
}

export function PromptSheet({ prompt, onApprove, onDismiss, onEnableAuto, bottomOffset }: PromptSheetProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;

  const btn = (pressed: boolean, tint?: string) => [
    styles.btn,
    { borderColor: c.glassBorder, backgroundColor: tint ?? `rgba(${c.overlayRgb},0.05)` },
    pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] },
  ];

  return (
    <View pointerEvents="box-none" style={[styles.zone, { bottom: bottomOffset }]}>
      <Animated.View entering={SlideInDown.springify().damping(16)} exiting={SlideOutDown.duration(180)} style={{ width: '100%', alignItems: 'center' }}>
      <GlassSurface strong radius={m.radius.lg} style={styles.panel}>
        <View style={styles.head}>
          <IconDot size={10} color={prompt.color} />
          <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.label, fontWeight: '700', flex: 1 }}>
            {prompt.title}
          </Text>
        </View>
        <Text style={{ color: c.textDim, fontSize: m.font.body, marginBottom: 14 }}>
          Berechtigungs-Anfrage erkannt — erlauben?
        </Text>
        <View style={styles.actions}>
          <Pressable onPress={onApprove} style={({ pressed }) => btn(pressed, `rgba(${c.accentRgb},0.18)`)}>
            <Text style={{ color: c.accent, fontSize: m.font.label, fontWeight: '700' }}>Ja</Text>
          </Pressable>
          <Pressable onPress={onDismiss} style={({ pressed }) => btn(pressed)}>
            <Text style={{ color: c.err, fontSize: m.font.label, fontWeight: '700' }}>Ignorieren</Text>
          </Pressable>
          <Pressable onPress={onEnableAuto} style={({ pressed }) => btn(pressed)}>
            <Text style={{ color: c.ok, fontSize: m.font.label, fontWeight: '700' }}>⚡ Auto an</Text>
          </Pressable>
        </View>
      </GlassSurface>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  zone: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30 },
  panel: { width: '92%', maxWidth: 480, padding: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1, minHeight: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: 8,
  },
});
