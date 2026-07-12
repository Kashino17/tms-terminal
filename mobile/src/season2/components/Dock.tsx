/**
 * Season 2 dock — floating glass bar with a sliding active-item pill
 * (the mockup's rubbery FLIP indicator, here via Reanimated springs).
 */
import React, { useCallback, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { SPRING_SNAPPY } from '../motion/springs';
import {
  IconServer, IconTerminal, IconManager, IconCloud, IconBrowser, IconMore, S2IconProps,
} from '../icons';

export type DockItemKey = 'server' | 'terminals' | 'manager' | 'cloud' | 'browser' | 'mehr';

const ITEMS: { key: DockItemKey; label: string; Icon: (p: S2IconProps) => React.ReactElement }[] = [
  { key: 'server', label: 'Server', Icon: IconServer },
  { key: 'terminals', label: 'Terminals', Icon: IconTerminal },
  { key: 'manager', label: 'Manager', Icon: IconManager },
  { key: 'cloud', label: 'Cloud', Icon: IconCloud },
  { key: 'browser', label: 'Browser', Icon: IconBrowser },
  { key: 'mehr', label: 'Mehr', Icon: IconMore },
];

interface DockProps {
  active: DockItemKey;
  onSelect: (key: DockItemKey) => void;
  /** Attention dots per item (e.g. pending permission prompt on terminals). */
  badges?: Partial<Record<DockItemKey, boolean>>;
}

export function Dock({ active, onSelect, badges }: DockProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const pillX = useSharedValue(0);
  const pillW = useSharedValue(0);
  const pillOpacity = useSharedValue(0);
  const layouts = useRef<Record<string, { x: number; width: number }>>({});

  const moveTo = useCallback((key: DockItemKey) => {
    const l = layouts.current[key];
    if (!l) return;
    pillX.value = withSpring(l.x, SPRING_SNAPPY);
    pillW.value = withSpring(l.width, SPRING_SNAPPY);
    pillOpacity.value = withSpring(1, SPRING_SNAPPY);
  }, [pillX, pillW, pillOpacity]);

  const onItemLayout = useCallback((key: DockItemKey) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    layouts.current[key] = { x, width };
    if (key === active) moveTo(key);
  }, [active, moveTo]);

  React.useEffect(() => { moveTo(active); }, [active, moveTo]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
    width: pillW.value,
    opacity: pillOpacity.value,
  }));

  return (
    <GlassSurface strong radius={m.radius.pill} style={styles.wrap}>
      <View style={styles.row}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pill,
            { backgroundColor: `rgba(${c.accentRgb},0.16)`, borderColor: `rgba(${c.accentRgb},0.22)` },
            pillStyle,
          ]}
        />
        {ITEMS.map(({ key, label, Icon }) => {
          const isActive = key === active;
          const color = isActive ? c.text : c.textDim;
          return (
            <Pressable
              key={key}
              onLayout={onItemLayout(key)}
              onPress={() => onSelect(key)}
              style={({ pressed }) => [styles.item, pressed && { transform: [{ scale: 0.94 }] }]}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: isActive }}
            >
              <Icon size={m.icon.md} color={color} />
              <Text style={[styles.label, { color, fontSize: m.font.micro }]}>{label}</Text>
              {badges?.[key] && <View style={[styles.itemBadge, { backgroundColor: c.warn }]} />}
            </Pressable>
          );
        })}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 6 },
  pill: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    left: 0,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  item: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minWidth: 54,
    paddingVertical: 7,
    paddingHorizontal: 2,
  },
  label: { fontWeight: '600', letterSpacing: 0.1 },
  itemBadge: { position: 'absolute', top: 6, right: 12, width: 8, height: 8, borderRadius: 4 },
});
