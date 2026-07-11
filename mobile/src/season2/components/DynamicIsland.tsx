/**
 * Season 2 Dynamic Island — compact centered glass pill living in a
 * RESERVED top zone (never overlaps content). Tap → spring-morphs into
 * the detail card (sessions, connection, prayer, theme, back-to-classic).
 */
import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  useAnimatedStyle, useSharedValue, withSpring, withTiming, interpolate,
} from 'react-native-reanimated';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { SPRING_GENTLE, TIMING_EXIT, TIMING_FADE, SPRING_SNAPPY } from '../motion/springs';
import { IconSignal, IconPrayerMoon, IconSun, IconDot, IconBack } from '../icons';

export interface IslandSessionRow {
  id: string;
  title: string;
  color: string;
  statusLabel: string;
}

interface DynamicIslandProps {
  statusLabel: string;
  statusKind: 'live' | 'ok' | 'warn' | 'idle';
  latencyMs: number | null;
  prayerLabel: string | null;
  sessions: IslandSessionRow[];
  onSessionPress: (id: string) => void;
  onBackToClassic: () => void;
}

const COLLAPSED_H = 40;
const EXPANDED_MAX_H = 420;

export function DynamicIsland({
  statusLabel, statusKind, latencyMs, prayerLabel, sessions, onSessionPress, onBackToClassic,
}: DynamicIslandProps) {
  const { theme, toggleTheme } = useS2Theme();
  const { c, m } = theme;
  const { width: winW } = useWindowDimensions();
  const open = useSharedValue(0);
  const [expanded, setExpanded] = React.useState(false);

  const collapsedW = Math.min(winW * 0.92, 400);
  const expandedW = Math.min(winW * 0.94, 480);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      open.value = next ? withSpring(1, SPRING_GENTLE) : withTiming(0, TIMING_EXIT);
      return next;
    });
  }, [open]);

  const shellStyle = useAnimatedStyle(() => ({
    width: interpolate(open.value, [0, 1], [collapsedW, expandedW]),
    height: interpolate(open.value, [0, 1], [COLLAPSED_H, EXPANDED_MAX_H]),
  }));

  const bodyStyle = useAnimatedStyle(() => ({
    opacity: interpolate(open.value, [0, 0.5, 1], [0, 0, 1]),
    transform: [{ translateY: interpolate(open.value, [0, 1], [-6, 0]) }],
  }));

  const dotColor =
    statusKind === 'live' ? c.accent : statusKind === 'ok' ? c.ok : statusKind === 'warn' ? c.warn : c.textDim;

  return (
    <View style={styles.zone} pointerEvents="box-none">
      <Animated.View style={[styles.shell, shellStyle]}>
        <GlassSurface strong radius={expanded ? m.radius.lg : m.radius.pill} style={StyleSheet.absoluteFill}>
          <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel="Status – Details öffnen/schließen">
            <View style={[styles.compactRow, { height: COLLAPSED_H }]}>
              <View style={[styles.dot, { backgroundColor: dotColor }]} />
              <Text numberOfLines={1} style={[styles.statusLabel, { color: c.text, fontSize: m.font.label }]}>
                {statusLabel}
              </Text>
              <View style={styles.metrics}>
                <IconSignal size={m.icon.sm} color={c.ok} />
                <Text style={[styles.metric, { color: c.ok, fontSize: m.font.caption }]}>
                  {latencyMs != null ? `${latencyMs} ms` : '—'}
                </Text>
                {prayerLabel != null && (
                  <>
                    <View style={[styles.divider, { backgroundColor: c.glassBorder }]} />
                    <IconPrayerMoon size={m.icon.sm} color={c.textDim} />
                    <Text style={[styles.metric, { color: c.textDim, fontSize: m.font.caption }]}>{prayerLabel}</Text>
                  </>
                )}
              </View>
            </View>
          </Pressable>

          <Animated.View style={[styles.body, bodyStyle]} pointerEvents={expanded ? 'auto' : 'none'}>
            <Text style={[styles.h4, { color: c.textDim }]}>AKTIVE SITZUNGEN</Text>
            {sessions.length === 0 && (
              <Text style={{ color: c.textDim, fontSize: m.font.caption, paddingVertical: 6 }}>
                Keine Sitzungen — erst Server verbinden
              </Text>
            )}
            {sessions.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => { toggle(); onSessionPress(s.id); }}
                style={({ pressed }) => [styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }, pressed && { opacity: 0.7 }]}
              >
                <IconDot size={10} color={s.color} />
                <Text numberOfLines={1} style={[styles.rowName, { color: c.text, fontSize: m.font.label }]}>{s.title}</Text>
                <Text style={{ color: c.textDim, fontSize: m.font.caption }}>{s.statusLabel}</Text>
              </Pressable>
            ))}

            <Text style={[styles.h4, { color: c.textDim }]}>ERSCHEINUNGSBILD</Text>
            <Pressable onPress={toggleTheme} style={({ pressed }) => [styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }, pressed && { opacity: 0.7 }]}>
              <IconSun size={m.icon.sm} color={c.accent} />
              <Text style={[styles.rowName, { color: c.text, fontSize: m.font.label }]}>
                {theme.name === 'dark' ? 'Dunkel' : 'Hell (Outdoor)'}
              </Text>
              <Text style={{ color: c.textDim, fontSize: m.font.caption }}>Antippen zum Wechseln</Text>
            </Pressable>

            <Pressable onPress={onBackToClassic} style={({ pressed }) => [styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }, pressed && { opacity: 0.7 }]}>
              <IconBack size={m.icon.sm} color={c.textDim} />
              <Text style={[styles.rowName, { color: c.text, fontSize: m.font.label }]}>Zurück zu Klassisch</Text>
            </Pressable>
          </Animated.View>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  zone: { alignItems: 'center' },
  shell: { overflow: 'hidden' },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { flex: 1, fontWeight: '600' },
  metrics: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metric: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 14, marginHorizontal: 5 },
  body: { paddingHorizontal: 16, paddingBottom: 14 },
  h4: { fontSize: 10.5, fontWeight: '600', letterSpacing: 1, marginTop: 14, marginBottom: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowName: { flex: 1, fontWeight: '600' },
});
