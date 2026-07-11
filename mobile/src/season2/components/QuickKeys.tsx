/**
 * Season 2 quick keys — round glass orbs sending REAL control bytes to the
 * PTY (^C, Esc, Tab, arrows, Ctrl+L clear) plus jump-to-bottom. Sits between
 * the terminal pane and the input row of the active session.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useS2Theme } from '../theme/tokens';
import { IconArrowDown, IconTrash } from '../icons';

interface QuickKeysProps {
  onKey: (data: string) => void;
  onJumpBottom: () => void;
}

const KEYS: { label: string; data: string; accent?: boolean }[] = [
  { label: '^C', data: '\x03', accent: true },
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
];

export function QuickKeys({ onKey, onJumpBottom }: QuickKeysProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;

  const orb = (pressed: boolean, accent?: boolean) => [
    styles.orb,
    {
      borderColor: accent ? `rgba(${'239,68,68'},0.45)` : c.glassBorder,
      backgroundColor: accent ? 'rgba(239,68,68,0.12)' : `rgba(${c.overlayRgb},0.06)`,
    },
    pressed && { opacity: 0.6, transform: [{ scale: 0.92 }] },
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="always"
    >
      {KEYS.map((k) => (
        <Pressable key={k.label} onPress={() => onKey(k.data)} style={({ pressed }) => orb(pressed, k.accent)}>
          <Text style={[styles.label, { color: k.accent ? c.err : c.text, fontSize: m.font.caption }]}>{k.label}</Text>
        </Pressable>
      ))}
      <Pressable onPress={() => onKey('\x0c')} accessibilityLabel="Bildschirm leeren" style={({ pressed }) => orb(pressed)}>
        <IconTrash size={m.icon.sm} color={c.textDim} />
      </Pressable>
      <Pressable onPress={onJumpBottom} accessibilityLabel="Nach unten springen" style={({ pressed }) => orb(pressed)}>
        <IconArrowDown size={m.icon.sm} color={c.accent} />
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  orb: {
    minWidth: 44, height: 44, borderRadius: 22, paddingHorizontal: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  label: { fontWeight: '700', fontFamily: undefined },
});
