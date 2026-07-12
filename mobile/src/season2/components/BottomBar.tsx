/**
 * Season 2 bottom bar — DUAL MODE (user requirement):
 *  • 'nav'     — the 6 app sections (Server, Terminals, Manager, Cloud, Browser, Mehr)
 *  • 'context' — tools for the CURRENT screen (browser: devtools/network/…,
 *                terminals: orbs/quick keys, …)
 * Long-press the bar and swipe LEFT → nav mode; swipe RIGHT → context mode.
 * The connections/server start screen only ever shows nav mode (no context tools).
 */
import React, { useCallback, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, LayoutChangeEvent, ScrollView } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, FadeIn, FadeOut } from 'react-native-reanimated';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { SPRING_SNAPPY } from '../motion/springs';
import {
  IconServer, IconTerminal, IconManager, IconCloud, IconBrowser, IconMore, S2IconProps,
} from '../icons';

export type DockItemKey = 'server' | 'terminals' | 'manager' | 'cloud' | 'browser' | 'mehr';
export type BarMode = 'nav' | 'context';

/** One tool button in context mode. */
export interface ContextAction {
  id: string;
  label: string;
  icon: (p: S2IconProps) => React.ReactElement;
  active?: boolean;
  onPress: () => void;
}

const NAV_ITEMS: { key: DockItemKey; label: string; Icon: (p: S2IconProps) => React.ReactElement }[] = [
  { key: 'server', label: 'Server', Icon: IconServer },
  { key: 'terminals', label: 'Terminals', Icon: IconTerminal },
  { key: 'manager', label: 'Manager', Icon: IconManager },
  { key: 'cloud', label: 'Cloud', Icon: IconCloud },
  { key: 'browser', label: 'Browser', Icon: IconBrowser },
  { key: 'mehr', label: 'Mehr', Icon: IconMore },
];

interface BottomBarProps {
  mode: BarMode;
  onModeChange: (mode: BarMode) => void;
  active: DockItemKey;
  onSelect: (key: DockItemKey) => void;
  /** Context tools for the current screen; empty ⇒ context mode unavailable. */
  contextActions: ContextAction[];
  badges?: Partial<Record<DockItemKey, boolean>>;
}

export function BottomBar({ mode, onModeChange, active, onSelect, contextActions, badges }: BottomBarProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const pillX = useSharedValue(0);
  const pillW = useSharedValue(0);
  const pillOpacity = useSharedValue(0);
  const layouts = useRef<Record<string, { x: number; width: number }>>({});
  const gesture = useRef<{ x: number; long: boolean } | null>(null);
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canContext = contextActions.length > 0;
  const showContext = mode === 'context' && canContext;

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

  React.useEffect(() => { if (!showContext) moveTo(active); }, [active, moveTo, showContext]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
    width: pillW.value,
    opacity: pillOpacity.value,
  }));

  // Long-press + horizontal swipe switches modes (left → nav, right → context).
  const onBarPointerDown = (e: any) => {
    gesture.current = { x: e.nativeEvent.pageX, long: false };
    longTimer.current = setTimeout(() => {
      if (gesture.current) gesture.current.long = true;
    }, 320);
  };
  const onBarPointerUp = (e: any) => {
    if (longTimer.current) { clearTimeout(longTimer.current); longTimer.current = null; }
    const g = gesture.current;
    gesture.current = null;
    if (!g || !g.long) return;
    const dx = e.nativeEvent.pageX - g.x;
    if (dx < -40) onModeChange('nav');
    else if (dx > 40 && canContext) onModeChange('context');
  };

  return (
    <View
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => false}
      onResponderGrant={onBarPointerDown}
      onResponderRelease={onBarPointerUp}
      onResponderTerminate={() => { if (longTimer.current) clearTimeout(longTimer.current); gesture.current = null; }}
    >
      <GlassSurface strong radius={m.radius.pill} style={styles.wrap}>
        {showContext ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.contextRow}
              keyboardShouldPersistTaps="always"
            >
              {contextActions.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={a.onPress}
                  accessibilityLabel={a.label}
                  style={({ pressed }) => [
                    styles.contextBtn,
                    {
                      borderColor: a.active ? `rgba(${c.accentRgb},0.5)` : c.glassBorder,
                      backgroundColor: a.active ? `rgba(${c.accentRgb},0.16)` : `rgba(${c.overlayRgb},0.05)`,
                    },
                    pressed && { opacity: 0.65, transform: [{ scale: 0.94 }] },
                  ]}
                >
                  <a.icon size={m.icon.md} color={a.active ? c.accent : c.text} />
                  <Text numberOfLines={1} style={[styles.label, { color: a.active ? c.accent : c.textDim, fontSize: m.font.micro }]}>
                    {a.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={styles.row}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.pill,
                { backgroundColor: `rgba(${c.accentRgb},0.16)`, borderColor: `rgba(${c.accentRgb},0.22)` },
                pillStyle,
              ]}
            />
            {NAV_ITEMS.map(({ key, label, Icon }) => {
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
          </Animated.View>
        )}

        {/* Mode hint — a tiny grabber that also tells you the bar is switchable. */}
        {canContext && (
          <View style={styles.hintRow}>
            <View style={[styles.hintDot, { backgroundColor: showContext ? c.textDim : c.accent, opacity: showContext ? 0.4 : 1 }]} />
            <View style={[styles.hintDot, { backgroundColor: showContext ? c.accent : c.textDim, opacity: showContext ? 1 : 0.4 }]} />
          </View>
        )}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center', paddingBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 6 },
  contextRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 6 },
  contextBtn: {
    minWidth: 58, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 3,
    paddingHorizontal: 10, borderWidth: StyleSheet.hairlineWidth * 2,
  },
  pill: {
    position: 'absolute', top: 6, bottom: 6, left: 0,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2,
  },
  item: {
    alignItems: 'center', justifyContent: 'center', gap: 3,
    minWidth: 54, paddingVertical: 7, paddingHorizontal: 2, zIndex: 1,
  },
  label: { fontWeight: '600', letterSpacing: 0.1 },
  itemBadge: { position: 'absolute', top: 4, right: 10, width: 8, height: 8, borderRadius: 4 },
  hintRow: { flexDirection: 'row', alignSelf: 'center', gap: 5, paddingBottom: 4 },
  hintDot: { width: 5, height: 5, borderRadius: 3 },
});
