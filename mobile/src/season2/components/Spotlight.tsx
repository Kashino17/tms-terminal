/**
 * Season 2 Spotlight — universal search overlay (mockup feature). Opened via
 * long-press on the Dynamic Island. Indexes terminal sessions, season2
 * screens and quick actions; fuzzy-ish case-insensitive substring match.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInUp, SlideOutUp } from 'react-native-reanimated';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { IconDot, IconSearch, IconTerminal, IconCloud, IconBrowser, IconManager, IconSun, IconBack } from '../icons';

export interface SpotlightEntry {
  id: string;
  label: string;
  sub?: string;
  kind: 'session' | 'screen' | 'action';
  color?: string;
  run: () => void;
}

interface SpotlightProps {
  entries: SpotlightEntry[];
  onClose: () => void;
}

export function Spotlight({ entries, onClose }: SpotlightProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.label.toLowerCase().includes(q) || e.sub?.toLowerCase().includes(q));
  }, [entries, query]);

  const iconFor = (e: SpotlightEntry) => {
    if (e.kind === 'session') return <IconDot size={10} color={e.color ?? c.accent} />;
    if (e.label.includes('Cloud')) return <IconCloud size={m.icon.sm} color={c.textDim} />;
    if (e.label.includes('Browser')) return <IconBrowser size={m.icon.sm} color={c.textDim} />;
    if (e.label.includes('Manager')) return <IconManager size={m.icon.sm} color={c.textDim} />;
    if (e.label.includes('Design') || e.label.includes('Hell') || e.label.includes('Dunkel')) return <IconSun size={m.icon.sm} color={c.textDim} />;
    if (e.label.includes('Klassisch')) return <IconBack size={m.icon.sm} color={c.textDim} />;
    return <IconTerminal size={m.icon.sm} color={c.textDim} />;
  };

  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={[StyleSheet.absoluteFill, styles.zone, { backgroundColor: c.scrim }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Spotlight schließen" />
      <Animated.View entering={SlideInUp.springify().damping(17)} exiting={SlideOutUp.duration(160)} style={styles.panelWrap}>
        <GlassSurface strong radius={m.radius.lg} style={styles.panel}>
          <View style={[styles.searchRow, { borderBottomColor: `rgba(${c.overlayRgb},0.08)` }]}>
            <IconSearch size={m.icon.sm} color={c.textDim} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Terminals, Bereiche, Aktionen…"
              placeholderTextColor={c.textDim}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, color: c.text, fontSize: m.font.body, paddingVertical: 10 }}
            />
          </View>
          <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
            {results.map((e) => (
              <Pressable
                key={e.id}
                onPress={() => { onClose(); e.run(); }}
                style={({ pressed }) => [styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.06)` }, pressed && { opacity: 0.7 }]}
              >
                {iconFor(e)}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.body, fontWeight: '600' }}>{e.label}</Text>
                  {e.sub != null && <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.micro }}>{e.sub}</Text>}
                </View>
              </Pressable>
            ))}
            {results.length === 0 && (
              <Text style={{ color: c.textDim, fontSize: m.font.caption, textAlign: 'center', paddingVertical: 18 }}>
                Nichts gefunden.
              </Text>
            )}
          </ScrollView>
        </GlassSurface>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  zone: { zIndex: 45, paddingTop: 70 },
  panelWrap: { alignItems: 'center', paddingHorizontal: 14 },
  panel: { width: '100%', maxWidth: 480, paddingHorizontal: 6, paddingBottom: 6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
