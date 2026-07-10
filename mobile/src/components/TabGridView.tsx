import React, { useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, Modal, Animated, Platform, StatusBar,
} from 'react-native';
import { TabGridCard } from './TabGridCard';
import { TerminalTab } from '../types/terminal.types';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

const COLUMN_GAP = 7;
const PADDING = 10;

export interface TabGridViewProps {
  visible: boolean;
  tabs: TerminalTab[];
  outputBuffers: Record<string, string>;
  lastActivity: Record<string, number>;
  translateY: Animated.Value;
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
}

export function TabGridView({
  visible,
  tabs,
  outputBuffers,
  lastActivity,
  onClose,
  onSelectTab,
  onCloseTab,
  onAddTab,
  translateY,
}: TabGridViewProps) {
  const responsive = useResponsive();
  const { rf, rs } = responsive;

  const scaledGap = rs(COLUMN_GAP);
  const scaledPadding = rs(PADDING);

  const dynamicStyles = useMemo(() => ({
    header: { height: rs(50), paddingHorizontal: rs(16) },
    cancelText: { fontSize: rf(13) },
    headerTitle: { fontSize: rf(14) },
    doneBtnPad: { paddingHorizontal: rs(12), paddingVertical: rs(4) },
    doneText: { fontSize: rf(13) },
    listContent: { padding: scaledPadding, paddingBottom: 0 },
    columnWrapper: { gap: scaledGap, marginBottom: scaledGap },
    bottomBar: { height: rs(48) },
    newTabBarBtn: { paddingHorizontal: rs(20), paddingVertical: rs(8) },
    newTabBarText: { fontSize: rf(13) },
  }), [rf, rs, scaledGap, scaledPadding]);

  const renderItem = useCallback(({ item }: { item: TerminalTab }) => {
    return (
      <TabGridCard
        tab={item}
        outputBuffer={outputBuffers[item.id] ?? ''}
        isActive={item.active}
        lastActivityMs={lastActivity[item.id] ?? 0}
        onSelect={onSelectTab}
        onClose={onCloseTab}
      />
    );
  }, [outputBuffers, lastActivity, onSelectTab, onCloseTab]);

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="none"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={onClose}
    >
      <Animated.View style={[
        StyleSheet.absoluteFill,
        {
          transform: [{ translateY }],
          backgroundColor: colors.bg,
          paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
        },
      ]}>
        {/* Header */}
        <View style={[styles.header, dynamicStyles.header]}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Text style={[styles.cancelText, dynamicStyles.cancelText]}>Abbrechen</Text>
          </TouchableOpacity>
          <Text style={[styles.headerTitle, dynamicStyles.headerTitle]}>{tabs.length} Terminals</Text>
          <TouchableOpacity onPress={onClose} style={[styles.headerBtn, styles.headerBtnRight]}>
            <View style={[styles.doneBtn, dynamicStyles.doneBtnPad]}>
              <Text style={[styles.doneText, dynamicStyles.doneText]}>Fertig</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Grid */}
        <FlatList
          key={String(responsive.gridColumns)}
          data={tabs}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={responsive.gridColumns}
          style={styles.list}
          contentContainerStyle={dynamicStyles.listContent}
          columnWrapperStyle={dynamicStyles.columnWrapper}
          showsVerticalScrollIndicator={false}
          getItemLayout={(_data, index) => {
            const rowIndex = Math.floor(index / responsive.gridColumns);
            const itemHeight = rs(104); // header 22 + body 80 + border 2
            const rowGap = scaledGap;
            return {
              length: itemHeight,
              offset: scaledPadding + rowIndex * (itemHeight + rowGap),
              index,
            };
          }}
        />

        {/* Bottom bar */}
        <View style={[styles.bottomBar, dynamicStyles.bottomBar]}>
          <TouchableOpacity style={[styles.newTabBarBtn, dynamicStyles.newTabBarBtn]} onPress={onAddTab}>
            <Text style={[styles.newTabBarText, dynamicStyles.newTabBarText]}>+ Neuer Tab</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Header
  header: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  headerBtn: {
    minWidth: 80,
  },
  headerBtnRight: {
    alignItems: 'flex-end',
  },
  cancelText: {
    fontSize: 13,
    color: colors.primary,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    fontFamily: fonts.mono,
  },
  doneBtn: {
    backgroundColor: 'rgba(59,130,246,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.25)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  doneText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
  },
  // Grid
  list: {
    flex: 1,
  },
  listContent: {
    padding: PADDING,
    paddingBottom: 0,
  },
  columnWrapper: {
    gap: COLUMN_GAP,
    marginBottom: COLUMN_GAP,
  },
  // Bottom bar
  bottomBar: {
    height: 48,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  newTabBarBtn: {
    backgroundColor: 'rgba(59,130,246,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.2)',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  newTabBarText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  },
});
