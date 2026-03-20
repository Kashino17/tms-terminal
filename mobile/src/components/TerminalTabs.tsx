import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  TextInput,
  TextStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TerminalTab } from '../types/terminal.types';
import { colors, fonts } from '../theme';
import { AI_TOOL_COLORS } from '../constants/aiTools';
import { useResponsive } from '../hooks/useResponsive';

interface Props {
  tabs: TerminalTab[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, newName: string) => void;
  onOpenGrid?: () => void;
}

import { tabDisplayName } from '../utils/tabDisplayName';

export function TerminalTabs({ tabs, onSelect, onClose, onAdd, onRename, onOpenGrid }: Props) {
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;
  const [renaming, setRenaming] = useState<{ tabId: string; value: string } | null>(null);

  const handleLongPress = (tab: TerminalTab) => {
    setRenaming({ tabId: tab.id, value: tabDisplayName(tab) });
  };

  const confirmRename = () => {
    if (renaming && renaming.value.trim()) {
      onRename(renaming.tabId, renaming.value.trim());
    }
    setRenaming(null);
  };

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.scroll, { paddingHorizontal: rs(8), paddingVertical: rs(6), gap: rs(4) }]} accessibilityRole={'tablist' as any}>
        {tabs.map((tab) => {
          const aiColor = tab.aiTool ? AI_TOOL_COLORS[tab.aiTool] : undefined;
          const aiLabelStyle: TextStyle | undefined = aiColor
            ? { fontSize: rf(9), color: aiColor, opacity: 0.8, marginLeft: rs(2) }
            : undefined;
          return (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.tab,
                { paddingLeft: rs(12), paddingRight: rs(6), paddingVertical: rs(8), gap: rs(4) },
                tab.active && styles.activeTab,
                aiColor != null && { borderColor: aiColor },
              ]}
              onPress={() => onSelect(tab.id)}
              onLongPress={() => handleLongPress(tab)}
              delayLongPress={400}
              accessibilityRole={'tab' as any}
              accessibilityState={{ selected: tab.active }}
              accessibilityLabel={`${tabDisplayName(tab)}${tab.aiTool ? `, ${tab.aiTool}` : ''}`}
            >
              <Text style={[styles.tabText, { fontSize: rf(13) }, tab.active && styles.activeTabText]} numberOfLines={1}>
                {tabDisplayName(tab)}
              </Text>
              {aiColor && tab.aiTool && (
                <Text style={aiLabelStyle}>
                  {tab.aiTool.charAt(0).toUpperCase() + tab.aiTool.slice(1)}
                </Text>
              )}
              <TouchableOpacity
                style={[styles.closeBtn, { paddingHorizontal: rs(10) }]}
                onPress={() => onClose(tab.id)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityLabel="Close tab"
                accessibilityRole="button"
              >
                <Feather name="x" size={ri(14)} color={tab.active ? colors.textMuted : colors.textDim} />
              </TouchableOpacity>
              {!!tab.notificationCount && tab.notificationCount > 0 && (
                <View style={[styles.badge, { width: rs(18), height: rs(18), borderRadius: rs(9) }]}>
                  <Text style={[styles.badgeText, { fontSize: rf(11), lineHeight: rf(13) }]}>
                    {tab.notificationCount > 9 ? '9+' : String(tab.notificationCount)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
        {onOpenGrid && (
          <TouchableOpacity
            style={[styles.gridButton, { paddingHorizontal: rs(10), paddingVertical: rs(8) }]}
            onPress={() => onOpenGrid()}
            accessibilityLabel="Tab overview"
            accessibilityRole="button"
          >
            <Feather name="layout" size={ri(16)} color={colors.textDim} />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.addButton, { paddingHorizontal: rs(14), paddingVertical: rs(8) }]} onPress={onAdd} accessibilityLabel="New tab" accessibilityRole="button">
          <Feather name="plus" size={ri(18)} color={colors.primary} />
        </TouchableOpacity>
      </ScrollView>

      {/* Rename modal */}
      <Modal visible={!!renaming} transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setRenaming(null)}>
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>Rename Tab</Text>
            <TextInput
              style={styles.modalInput}
              value={renaming?.value ?? ''}
              onChangeText={(text) => setRenaming((prev) => (prev ? { ...prev, value: text } : null))}
              onSubmitEditing={confirmRename}
              autoFocus
              selectTextOnFocus
              maxLength={30}
              placeholderTextColor={colors.textDim}
              selectionColor={colors.primary}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalBtn} onPress={() => setRenaming(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirmBtn]} onPress={confirmRename}>
                <Text style={styles.modalConfirmText}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scroll: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: 'transparent',
    minWidth: 80,
    gap: 4,
    borderWidth: 0,
  },
  activeTab: {
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabText: {
    color: colors.textDim,
    fontSize: 13,
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
  activeTabText: {
    color: colors.text,
  },
  closeBtn: {
    paddingHorizontal: 10,
  },
  addButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── Notification badge ───────────────────
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#000000',
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  // ── Rename modal ──────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: 280,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 14,
    textAlign: 'center',
  },
  modalInput: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.mono,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: colors.border,
  },
  modalConfirmBtn: {
    backgroundColor: colors.primary,
  },
  modalCancelText: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: '500',
  },
  modalConfirmText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
});
