import React, { useState, useEffect, memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TerminalTab } from '../types/terminal.types';
import { colors, fonts } from '../theme';
import { AI_TOOL_COLORS } from '../constants/aiTools';
import { useResponsive } from '../hooks/useResponsive';

export interface TabGridCardProps {
  tab: TerminalTab;
  outputBuffer: string;
  isActive: boolean;
  lastActivityMs: number;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

const ACTIVITY_WINDOW_MS = 3000;

function dotColor(isActive: boolean, lastActivityMs: number): string {
  if (isActive) return colors.primary;
  if (lastActivityMs > 0 && Date.now() - lastActivityMs < ACTIVITY_WINDOW_MS) return '#22c55e'; // green
  return colors.border;
}

function lineColor(line: string): string {
  if (/error|Error|ERROR|✗|failed|FAILED/.test(line)) return '#f87171'; // red
  if (/warn|Warn|WARN/.test(line)) return '#fbbf24'; // amber
  return '#4ade80'; // dim green
}

export const TabGridCard = memo(function TabGridCard({
  tab,
  outputBuffer,
  isActive,
  lastActivityMs,
  onSelect,
  onClose,
}: TabGridCardProps) {
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;

  // Local tick to force re-render when the 3-second activity window expires
  const [, setTick] = useState(0);

  useEffect(() => {
    if (isActive || lastActivityMs === 0) return;
    const remaining = ACTIVITY_WINDOW_MS - (Date.now() - lastActivityMs);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(timer);
  }, [lastActivityMs, isActive]);

  const dot = dotColor(isActive, lastActivityMs);
  const aiColor = tab.aiTool ? AI_TOOL_COLORS[tab.aiTool] : undefined;
  const lines = useMemo(
    () => outputBuffer.split('\n').filter(Boolean),
    [outputBuffer],
  );

  const dynamicStyles = useMemo(() => ({
    header: { height: rs(22), paddingHorizontal: rs(6), gap: rs(4) },
    dot: { width: rs(5), height: rs(5), borderRadius: rs(3) },
    title: { fontSize: rf(7.5) },
    aiBadge: { fontSize: rf(7) },
    body: { height: rs(80), padding: rs(5) },
    line: { fontSize: rf(7.5), lineHeight: rf(11.5) },
  }), [rf, rs]);

  return (
    <TouchableOpacity
      style={[
        styles.card,
        aiColor && !isActive ? { borderColor: aiColor } : undefined,
        isActive ? styles.cardActive : undefined,
      ]}
      onPress={() => onSelect(tab.id)}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${tab.title}`}
    >
      {/* Header */}
      <View style={[styles.header, dynamicStyles.header]}>
        <View style={[styles.dot, dynamicStyles.dot, { backgroundColor: dot }]} />
        <Text style={[styles.title, dynamicStyles.title]} numberOfLines={1}>{tab.title}</Text>
        {aiColor && tab.aiTool && (
          <Text style={[styles.aiBadge, dynamicStyles.aiBadge, { color: aiColor }]}>
            {tab.aiTool.charAt(0).toUpperCase() + tab.aiTool.slice(1)}
          </Text>
        )}
        <TouchableOpacity
          onPress={() => onClose(tab.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={`Close ${tab.title}`}
          accessibilityRole="button"
        >
          <Feather name="x" size={ri(11)} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Body — last lines of terminal output */}
      <View style={[styles.body, dynamicStyles.body]}>
        {lines.length === 0 ? (
          <Text style={[styles.line, dynamicStyles.line, { color: colors.textDim }]}>—</Text>
        ) : (
          lines.map((line, i) => (
            <Text key={String(i)} style={[styles.line, dynamicStyles.line, { color: lineColor(line) }]} numberOfLines={1}>
              {line}
            </Text>
          ))
        )}
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  cardActive: {
    borderColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  header: {
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 4,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 7.5,
    color: colors.textMuted,
    fontFamily: fonts.mono,
  },
  aiBadge: {
    fontSize: 7,
    fontFamily: fonts.mono,
    opacity: 0.85,
    flexShrink: 0,
  },
  body: {
    height: 80,
    padding: 5,
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  line: {
    fontSize: 7.5,
    lineHeight: 11.5,
    fontFamily: fonts.mono,
  },
});
