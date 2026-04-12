import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import type { TerminalTab } from '../types/terminal.types';
import { tabDisplayName } from '../utils/tabDisplayName';
import { colors, fonts } from '../theme';

interface DynamicIslandProps {
  tabs: TerminalTab[];
  activeTabId: string | undefined;
  connState: 'connected' | 'connecting' | 'disconnected' | 'error';
  rtt?: number;
  serverName: string;
  onSelectTab: (tabId: string) => void;
  onAddTab: () => void;
  onGoBack: () => void;
  onBrowserPress: () => void;
  activeTabHasBrowser: boolean;
  onOpenGrid?: () => void;
}

const DOT_COLORS: Record<string, string> = {
  connected: '#22C55E',
  connecting: '#F59E0B',
  disconnected: '#EF4444',
  error: '#EF4444',
};

export function DynamicIsland({
  tabs,
  activeTabId,
  connState,
  rtt,
  serverName,
  onSelectTab,
  onAddTab,
  onGoBack,
  onBrowserPress,
  activeTabHasBrowser,
  onOpenGrid,
}: DynamicIslandProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);

  const expandAnim = useRef(new Animated.Value(0)).current;
  const chipsOpacity = useRef(new Animated.Value(0)).current;
  const dotPulse = useRef(new Animated.Value(1)).current;

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId]);
  const tabLabel = activeTab ? tabDisplayName(activeTab) : serverName;
  const dotColor = DOT_COLORS[connState] ?? '#EF4444';
  const showRtt = connState === 'connected' && rtt != null;

  // Dot pulse
  useEffect(() => {
    if (connState === 'connected' || connState === 'connecting') {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(dotPulse, { toValue: 0.4, duration: 1000, useNativeDriver: false }),
          Animated.timing(dotPulse, { toValue: 1, duration: 1000, useNativeDriver: false }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    }
    dotPulse.setValue(1);
  }, [connState]);

  // Bounce/jelly scale for the elastic effect
  const bounceScale = useRef(new Animated.Value(1)).current;

  // Toggle with jelly bounce animation
  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (next) {
      // EXPAND: squish down first, then spring open with overshoot
      Animated.sequence([
        // Quick squish (press feel)
        Animated.timing(bounceScale, { toValue: 0.92, duration: 80, useNativeDriver: false }),
        // Bounce back + expand simultaneously
        Animated.parallel([
          Animated.spring(bounceScale, { toValue: 1, tension: 180, friction: 8, useNativeDriver: false }),
          Animated.spring(expandAnim, { toValue: 1, tension: 50, friction: 7, useNativeDriver: false }),
        ]),
      ]).start();

      // Chips fade in after the morph settles
      chipsOpacity.setValue(0);
      Animated.timing(chipsOpacity, { toValue: 1, duration: 200, delay: 200, useNativeDriver: false }).start();
    } else {
      // COLLAPSE: slight expand first (rubber band), then snap closed
      Animated.sequence([
        Animated.timing(bounceScale, { toValue: 1.06, duration: 80, useNativeDriver: false }),
        Animated.parallel([
          Animated.spring(bounceScale, { toValue: 1, tension: 200, friction: 10, useNativeDriver: false }),
          Animated.spring(expandAnim, { toValue: 0, tension: 80, friction: 9, useNativeDriver: false }),
        ]),
      ]).start();
    }
  }, [expanded]);

  // Swipe-down gesture → open tab grid (Apple-style pull down)
  const onOpenGridRef = useRef(onOpenGrid);
  onOpenGridRef.current = onOpenGrid;
  const swipeTriggered = useRef(false);
  const islandScale = useRef(new Animated.Value(1)).current;

  const swipePR = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e: GestureResponderEvent, gs: PanResponderGestureState) =>
        gs.dy > 8 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,

      onPanResponderGrant: () => {
        swipeTriggered.current = false;
        Animated.spring(islandScale, { toValue: 0.95, tension: 200, friction: 12, useNativeDriver: false }).start();
      },

      onPanResponderMove: (_e: GestureResponderEvent, gs: PanResponderGestureState) => {
        if (!swipeTriggered.current && gs.dy > 40) {
          swipeTriggered.current = true;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onOpenGridRef.current?.();
        }
      },

      onPanResponderRelease: () => {
        Animated.spring(islandScale, { toValue: 1, tension: 200, friction: 12, useNativeDriver: false }).start();
      },

      onPanResponderTerminate: () => {
        Animated.spring(islandScale, { toValue: 1, tension: 200, friction: 12, useNativeDriver: false }).start();
      },
    }),
  ).current;

  // Widths
  const collapsedW = 180;
  const expandedW = screenWidth - 20;

  const animWidth = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [collapsedW, expandedW],
  });
  const animRadius = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [22, 16],
  });
  const animPadV = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [6, 10],
  });
  const animPadH = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [14, 12],
  });
  // No left animation needed — island is centered in its header container

  const isAi = (tab: TerminalTab) => tab.aiTool != null;

  return (
    <Animated.View
      {...swipePR.panHandlers}
      style={[
        s.island,
        {
          width: animWidth,
          borderRadius: animRadius,
          paddingVertical: animPadV,
          paddingHorizontal: animPadH,
          transform: [
            { scale: Animated.multiply(islandScale, bounceScale) },
          ],
        },
      ]}
    >
      {/* ── Main row ──────────────────────────────────────────────── */}
      <Pressable style={s.mainRow} onPress={toggle}>
        {/* Back */}
        <Pressable onPress={onGoBack} hitSlop={10} style={s.back}>
          <Feather name="arrow-left" size={14} color={colors.primary} />
        </Pressable>

        {/* Title */}
        <Text style={s.title} numberOfLines={1}>{tabLabel}</Text>

        {/* Connection dot */}
        <Animated.View style={[s.dot, { backgroundColor: dotColor, opacity: dotPulse }]} />

        {/* RTT */}
        {showRtt && (
          <Text style={[s.rtt, { color: dotColor }]}>{rtt! > 999 ? `${(rtt! / 1000).toFixed(1)}s` : `${rtt}ms`}</Text>
        )}

        {/* Browser badge */}
        {activeTabHasBrowser && (
          <Pressable onPress={onBrowserPress} style={s.browserBadge} hitSlop={6}>
            <Feather name="globe" size={14} color="#22C55E" />
          </Pressable>
        )}
      </Pressable>

      {/* ── Tab chips (expanded) ──────────────────────────────────── */}
      {expanded && (
        <Animated.View style={[s.chips, { opacity: chipsOpacity }]}>
          {tabs.map(tab => {
            const active = tab.id === activeTabId;
            const ai = isAi(tab);
            return (
              <Pressable
                key={tab.id}
                onPress={() => { onSelectTab(tab.id); toggle(); }}
                style={[
                  s.chip,
                  active && ai && s.chipAiActive,
                  active && !ai && s.chipActive,
                ]}
              >
                {ai && active && <Text style={{ color: '#A78BFA', fontSize: 8, marginRight: 3 }}>●</Text>}
                <Text
                  style={[s.chipText, { color: active ? '#F8FAFC' : '#64748B' }]}
                  numberOfLines={1}
                >
                  {tabDisplayName(tab)}
                </Text>
                {(tab.notificationCount ?? 0) > 0 && (
                  <View style={s.badge}>
                    <Text style={s.badgeText}>{tab.notificationCount! > 99 ? '99+' : tab.notificationCount}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}

          {/* + Button */}
          <Pressable onPress={onAddTab} style={s.addBtn}>
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>+</Text>
          </Pressable>
        </Animated.View>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  island: {
    alignSelf: 'center',
    zIndex: 100,
    backgroundColor: 'rgba(15,23,42,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  back: {
    flexShrink: 0,
    marginRight: 4,
  },
  title: {
    fontFamily: fonts.mono,
    fontWeight: '600',
    fontSize: 12,
    color: '#F8FAFC',
    flexShrink: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
  },
  rtt: {
    fontFamily: fonts.mono,
    fontWeight: '600',
    fontSize: 9,
    marginLeft: -4,
  },
  browserBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  chips: {
    flexDirection: 'row',
    gap: 4,
    paddingTop: 6,
    flexWrap: 'wrap',
  },
  chip: {
    flex: 1,
    minWidth: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  chipActive: {
    backgroundColor: 'rgba(59,130,246,0.15)',
    borderColor: 'rgba(59,130,246,0.2)',
  },
  chipAiActive: {
    backgroundColor: 'rgba(167,139,250,0.15)',
    borderColor: 'rgba(167,139,250,0.25)',
  },
  chipText: {
    fontFamily: fonts.mono,
    fontWeight: '600',
    fontSize: 10,
    textAlign: 'center',
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    fontSize: 7,
    fontWeight: '700',
    color: '#fff',
  },
  addBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingVertical: 4,
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
