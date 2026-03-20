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
import { TerminalTab, TabCategory, ServerType } from '../types/terminal.types';
import { colors, fonts } from '../theme';
import { AI_TOOL_COLORS } from '../constants/aiTools';
import { SERVER_TYPE_COLORS, SERVER_TYPE_LABELS } from '../utils/serverDetector';
import { useResponsive } from '../hooks/useResponsive';
import { tabDisplayName } from '../utils/tabDisplayName';
import { ActionSheet, ActionSheetOption } from './ActionSheet';

interface Props {
  tabs: TerminalTab[];
  connected?: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, newName: string) => void;
  onOpenGrid?: () => void;
  onChangeCategory?: (tabId: string, category: TabCategory, serverType?: ServerType) => void;
}

export function TerminalTabs({ tabs, connected = false, onSelect, onClose, onAdd, onRename, onOpenGrid, onChangeCategory }: Props) {
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;
  const [renaming, setRenaming] = useState<{ tabId: string; value: string } | null>(null);
  const [categorySheet, setCategorySheet] = useState<{ tabId: string; tabName: string } | null>(null);

  // Split tabs into groups
  const aiTabs = useMemo(() => tabs.filter(t => t.category === 'ai'), [tabs]);
  const serverTabs = useMemo(() => tabs.filter(t => t.category === 'server'), [tabs]);
  const shellTabs = useMemo(() => tabs.filter(t => !t.category || t.category === 'shell'), [tabs]);

  const handleLongPress = (tab: TerminalTab) => {
    setRenaming({ tabId: tab.id, value: tabDisplayName(tab) });
  };

  const handleServerLongPress = (tab: TerminalTab) => {
    setCategorySheet({ tabId: tab.id, tabName: tabDisplayName(tab) });
  };

  const confirmRename = () => {
    if (renaming && renaming.value.trim()) {
      onRename(renaming.tabId, renaming.value.trim());
    }
    setRenaming(null);
  };

  const categorySheetOptions: ActionSheetOption[] = useMemo(() => {
    if (!categorySheet || !onChangeCategory) return [];
    const tabId = categorySheet.tabId;
    return [
      {
        label: 'Frontend',
        icon: 'monitor' as keyof typeof Feather.glyphMap,
        color: SERVER_TYPE_COLORS.frontend,
        onPress: () => onChangeCategory(tabId, 'server', 'frontend'),
      },
      {
        label: 'Backend',
        icon: 'server' as keyof typeof Feather.glyphMap,
        color: SERVER_TYPE_COLORS.backend,
        onPress: () => onChangeCategory(tabId, 'server', 'backend'),
      },
      {
        label: 'Database',
        icon: 'database' as keyof typeof Feather.glyphMap,
        color: SERVER_TYPE_COLORS.database,
        onPress: () => onChangeCategory(tabId, 'server', 'database'),
      },
      {
        label: 'Server',
        icon: 'hard-drive' as keyof typeof Feather.glyphMap,
        color: SERVER_TYPE_COLORS.server,
        onPress: () => onChangeCategory(tabId, 'server', 'server'),
      },
      {
        label: 'Shell (kein Server)',
        icon: 'terminal' as keyof typeof Feather.glyphMap,
        onPress: () => onChangeCategory(tabId, 'shell'),
      },
    ];
  }, [categorySheet, onChangeCategory]);

  // ── Badge sub-component ──────────────────────────────────────────────
  const renderBadge = (tab: TerminalTab) => {
    if (!tab.notificationCount || tab.notificationCount <= 0) return null;
    return (
      <View style={[styles.badge, { width: rs(18), height: rs(18), borderRadius: rs(9) }]}>
        <Text style={[styles.badgeText, { fontSize: rf(11), lineHeight: rf(13) }]}>
          {tab.notificationCount > 9 ? '9+' : String(tab.notificationCount)}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* ── Level 1: AI tabs | separator | Shell tabs | grid | add ── */}
      <View style={styles.level1}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.scroll, { paddingHorizontal: rs(8), paddingVertical: rs(6), gap: rs(4) }]}
          accessibilityRole={'tablist' as any}
        >
          {/* AI tabs - left side */}
          {aiTabs.map((tab) => {
            const aiColor = tab.aiTool ? AI_TOOL_COLORS[tab.aiTool] : colors.primary;
            const aiLabelStyle: TextStyle = {
              fontSize: rf(9),
              color: aiColor,
              opacity: 0.8,
              marginLeft: rs(2),
            };
            return (
              <TouchableOpacity
                key={tab.id}
                style={[
                  styles.tab,
                  { paddingLeft: rs(12), paddingRight: rs(6), paddingVertical: rs(8), gap: rs(4) },
                  { borderLeftWidth: 3, borderLeftColor: aiColor },
                  tab.active && [styles.activeTab, { borderBottomColor: aiColor }],
                ]}
                onPress={() => onSelect(tab.id)}
                onLongPress={() => handleLongPress(tab)}
                delayLongPress={400}
                accessibilityRole={'tab' as any}
                accessibilityState={{ selected: tab.active }}
                accessibilityLabel={`${tabDisplayName(tab)}${tab.aiTool ? `, ${tab.aiTool}` : ''}`}
              >
                <Text
                  style={[styles.tabText, { fontSize: rf(13) }, tab.active && styles.activeTabText]}
                  numberOfLines={1}
                >
                  {tabDisplayName(tab)}
                </Text>
                {tab.aiTool && (
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
                {renderBadge(tab)}
              </TouchableOpacity>
            );
          })}

          {/* Separator - only if both AI and shell tabs exist */}
          {aiTabs.length > 0 && shellTabs.length > 0 && (
            <View style={[styles.separator, { marginHorizontal: rs(6), height: rs(24) }]} />
          )}

          {/* Shell tabs - right side */}
          {shellTabs.map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.tab,
                { paddingLeft: rs(12), paddingRight: rs(6), paddingVertical: rs(8), gap: rs(4) },
                tab.active && styles.activeTab,
              ]}
              onPress={() => onSelect(tab.id)}
              onLongPress={() => handleLongPress(tab)}
              delayLongPress={400}
              accessibilityRole={'tab' as any}
              accessibilityState={{ selected: tab.active }}
              accessibilityLabel={tabDisplayName(tab)}
            >
              <Text
                style={[styles.tabText, { fontSize: rf(13) }, tab.active && styles.activeTabText]}
                numberOfLines={1}
              >
                {tabDisplayName(tab)}
              </Text>
              <TouchableOpacity
                style={[styles.closeBtn, { paddingHorizontal: rs(10) }]}
                onPress={() => onClose(tab.id)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityLabel="Close tab"
                accessibilityRole="button"
              >
                <Feather name="x" size={ri(14)} color={tab.active ? colors.textMuted : colors.textDim} />
              </TouchableOpacity>
              {renderBadge(tab)}
            </TouchableOpacity>
          ))}

          {/* Grid + Add buttons */}
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
          <TouchableOpacity
            style={[styles.addButton, { paddingHorizontal: rs(14), paddingVertical: rs(8) }]}
            onPress={onAdd}
            accessibilityLabel="New tab"
            accessibilityRole="button"
          >
            <Feather name="plus" size={ri(18)} color={colors.primary} />
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* ── Level 2: Server tabs (only when servers detected) ── */}
      {serverTabs.length > 0 && (
        <View style={styles.level2}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[styles.serverScroll, { paddingHorizontal: rs(8), paddingVertical: rs(4), gap: rs(6) }]}
          >
            {serverTabs.map((tab) => {
              const typeColor = tab.serverType ? SERVER_TYPE_COLORS[tab.serverType] ?? colors.textDim : colors.textDim;
              const typeLabel = tab.serverType ? SERVER_TYPE_LABELS[tab.serverType] ?? 'Server' : 'Server';
              const displayLabel = tab.serverPort ? `${typeLabel}:${tab.serverPort}` : typeLabel;
              const dotColor = (connected && !!tab.sessionId) ? colors.accent : colors.textDim;

              return (
                <TouchableOpacity
                  key={tab.id}
                  style={[
                    styles.serverTab,
                    {
                      paddingHorizontal: rs(10),
                      paddingVertical: rs(5),
                      borderRadius: rs(14),
                      gap: rs(5),
                    },
                    tab.active && { backgroundColor: typeColor + '26' }, // 15% opacity hex
                  ]}
                  onPress={() => onSelect(tab.id)}
                  onLongPress={() => handleServerLongPress(tab)}
                  delayLongPress={400}
                  accessibilityRole={'tab' as any}
                  accessibilityState={{ selected: tab.active }}
                  accessibilityLabel={`${tabDisplayName(tab)}, ${displayLabel}`}
                >
                  {/* Colored dot */}
                  <View
                    style={[
                      styles.serverDot,
                      { width: rs(8), height: rs(8), borderRadius: rs(4), backgroundColor: dotColor },
                    ]}
                  />
                  <Text
                    style={[
                      styles.serverTabText,
                      { fontSize: rf(12) },
                      tab.active && { color: typeColor, fontWeight: '600' },
                    ]}
                    numberOfLines={1}
                  >
                    {displayLabel}
                  </Text>
                  <TouchableOpacity
                    style={[styles.serverCloseBtn, { paddingLeft: rs(4) }]}
                    onPress={() => onClose(tab.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                    accessibilityLabel="Close tab"
                    accessibilityRole="button"
                  >
                    <Feather name="x" size={ri(12)} color={tab.active ? typeColor : colors.textDim} />
                  </TouchableOpacity>
                  {renderBadge(tab)}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

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

      {/* Server type ActionSheet */}
      <ActionSheet
        visible={!!categorySheet}
        title="Server-Typ aendern"
        subtitle={categorySheet?.tabName}
        options={categorySheetOptions}
        onClose={() => setCategorySheet(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  // ── Level 1 ────────────────────────────────
  level1: {},
  scroll: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
    alignItems: 'center',
  },
  separator: {
    width: 1,
    backgroundColor: colors.border,
    alignSelf: 'center',
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
  // ── Level 2 (server tabs) ──────────────────
  level2: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  serverScroll: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 6,
    alignItems: 'center',
  },
  serverTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  serverDot: {},
  serverTabText: {
    color: colors.textDim,
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
  serverCloseBtn: {},
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
