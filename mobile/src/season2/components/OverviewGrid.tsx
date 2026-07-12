/**
 * Season 2 ⊞ overview — strict 2-column grid of ALL sessions (user rule:
 * a lone last tile stays half-width, the empty cell remains). Tap → focus.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import type { TerminalTab } from '../../types/terminal.types';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { IconDot, IconClose } from '../icons';

interface OverviewGridProps {
  tabs: TerminalTab[];
  colors: string[];
  onSelect: (tabId: string) => void;
  onClose: () => void;
}

export function OverviewGrid({ tabs, colors: tagColors, onSelect, onClose }: OverviewGridProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;

  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={[StyleSheet.absoluteFill, styles.zone, { backgroundColor: c.bgGradient[1] }]}>
      <View style={styles.headRow}>
        <Text style={{ color: c.text, fontSize: m.font.section, fontWeight: '800' }}>Übersicht</Text>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Übersicht schließen"
          style={({ pressed }) => [styles.closeBtn, { borderColor: c.glassBorder }, pressed && { opacity: 0.6 }]}
        >
          <IconClose size={m.icon.sm} color={c.text} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.grid}>
        {tabs.map((tab, i) => (
          <AnimatedPressable
            key={tab.id}
            entering={ZoomIn.delay(Math.min(i, 12) * 30).springify().damping(15)}
            onPress={() => onSelect(tab.id)}
            style={({ pressed }) => [styles.cell, pressed && { transform: [{ scale: 0.97 }] }]}
          >
            <GlassSurface strong style={styles.tile}>
              <View style={styles.tileHead}>
                <IconDot size={9} color={tagColors[i % tagColors.length]} />
                <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.label, fontWeight: '700', flex: 1 }}>
                  {tab.title || 'Terminal'}
                </Text>
              </View>
              <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '600' }}>
                {tab.sessionId ? (tab.lastCwd ?? 'Bereit') : 'Startet…'}
                {tab.notificationCount ? '  ·  wartet' : ''}
              </Text>
            </GlassSurface>
          </AnimatedPressable>
        ))}
        {/* Strict 2-col grid: no stretching — flexBasis 50% per cell handles the
            lone-last-tile case naturally (right cell simply stays empty). */}
      </ScrollView>
    </Animated.View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const styles = StyleSheet.create({
  zone: { zIndex: 60, paddingTop: 8 },
  headRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
  },
  closeBtn: {
    width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingBottom: 140 },
  cell: { flexBasis: '50%', maxWidth: '50%', padding: 6 },
  tile: { padding: 12, minHeight: 96, justifyContent: 'space-between' },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
});
