import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAutoApproveStore } from '../store/autoApproveStore';
import { useTerminalStore } from '../store/terminalStore';
import { colors, fonts } from '../theme';
import { AI_TOOL_COLORS } from '../constants/aiTools';
import { useResponsive } from '../hooks/useResponsive';
import { tabDisplayName } from '../utils/tabDisplayName';

interface Props {
  serverId: string;
}

export function AutoApprovePanel({ serverId }: Props) {
  const { rf, rs, ri } = useResponsive();
  const tabs = useTerminalStore((s) => s.tabs[serverId] || []);
  const { enabled, running, toggle } = useAutoApproveStore();

  const connectedTabs = tabs.filter((t) => t.sessionId);

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="check-circle" size={ri(14)} color={colors.accent} />
        <Text style={[s.title, { fontSize: rf(13) }]}>Auto Approve</Text>
      </View>
      <View style={s.divider} />

      {/* Body */}
      <View style={s.body}>
        {connectedTabs.length === 0 ? (
          <View style={s.empty}>
            <Feather name="monitor" size={28} color={colors.border} />
            <Text style={s.emptyText}>Keine aktiven Terminals</Text>
          </View>
        ) : (
          connectedTabs.map((tab) => {
            const sid    = tab.sessionId!;
            const isOn   = enabled[sid] ?? false;
            const isRun  = running[sid] ?? false;
            const aiColor = tab.aiTool ? (AI_TOOL_COLORS[tab.aiTool] ?? '#585b70') : '#585b70';

            return (
              <TouchableOpacity
                key={tab.id}
                style={[s.row, isOn && s.rowOn]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  toggle(sid);
                }}
                activeOpacity={0.75}
                accessibilityRole={'switch' as any}
                accessibilityState={{ checked: isOn }}
                accessibilityLabel={tabDisplayName(tab) + ' auto approve'}
              >
                {/* Left: name + AI tool badge */}
                <View style={s.rowLeft}>
                  <Text style={[s.tabName, isOn && s.tabNameOn]} numberOfLines={1}>
                    {tabDisplayName(tab)}
                  </Text>
                  {tab.aiTool && (
                    <View style={[s.aiBadge, { backgroundColor: aiColor + '22', borderColor: aiColor + '55' }]}>
                      <Text style={[s.aiText, { color: aiColor }]}>
                        {tab.aiTool.toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Right: "sending…" + toggle */}
                <View style={s.rowRight}>
                  {isRun && <Feather name="corner-down-left" size={12} color={colors.warning} />}
                  <View style={[s.track, isOn && s.trackOn]}>
                    <View style={[s.knob, isOn && s.knobOn]} />
                  </View>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </View>

      {/* Footer hint */}
      {connectedTabs.length > 0 && (
        <View style={[s.footer, { paddingHorizontal: rs(12), paddingVertical: rs(8) }]}>
          <Text style={[s.footerText, { fontSize: rf(9) }]}>Tippt ↵ Enter sobald eine Bestätigung erkannt wird</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 7,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },
  body: {
    padding: 10,
    gap: 6,
    flex: 1,
  },

  // ── Empty state
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyText: {
    color: colors.textDim,
    fontSize: 12,
  },

  // ── Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowOn: {
    borderColor: 'rgba(34,197,94,0.4)',
    backgroundColor: 'rgba(34,197,94,0.04)',
  },
  rowLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginRight: 8,
    overflow: 'hidden',
  },
  tabName: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
  tabNameOn: {
    color: colors.text,
  },
  aiBadge: {
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
    flexShrink: 0,
  },
  aiText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  // ── Toggle
  track: {
    width: 34,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.border,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  trackOn: {
    backgroundColor: colors.accent,
  },
  knob: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.textMuted,
  },
  knobOn: {
    alignSelf: 'flex-end',
    backgroundColor: colors.bg,
  },

  // ── Footer
  footer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(51,65,85,0.5)',
  },
  footerText: {
    color: colors.textDim,
    fontSize: 9,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
