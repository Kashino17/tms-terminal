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
              {/* Calm color spine — same identity language as the cards. */}
              <View style={[styles.tileSpine, { backgroundColor: tagColors[i % tagColors.length], opacity: 0.55 }]} />
              <View style={styles.tileHead}>
                <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.label, fontWeight: '600', flex: 1 }}>
                  {tab.title || 'Terminal'}
                </Text>
                {!!tab.notificationCount && <View style={[styles.tileBadge, { backgroundColor: c.warn }]} />}
              </View>
              <Text numberOfLines={2} style={{ color: c.textDim, fontSize: m.font.micro, lineHeight: 15 }}>
                {tab.lastCwd ?? (tab.sessionId ? 'Bereit' : 'Startet…')}
              </Text>
              <View style={[styles.tileChip, { borderColor: c.glassBorder, backgroundColor: `rgba(${c.overlayRgb},0.05)` }]}>
                <IconDot size={7} color={tab.sessionId ? c.ok : c.warn} />
                <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '700' }}>
                  {tab.notificationCount ? 'WARTET' : tab.sessionId ? 'BEREIT' : 'STARTET'}
                </Text>
              </View>
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
  tile: { paddingLeft: 14, paddingRight: 12, paddingVertical: 12, minHeight: 118, justifyContent: 'space-between', gap: 6 },
  tileSpine: { position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  tileBadge: { width: 8, height: 8, borderRadius: 4 },
  tileChip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, paddingHorizontal: 8, height: 22, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
});
