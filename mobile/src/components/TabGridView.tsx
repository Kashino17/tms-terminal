import React, { useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, Modal, Animated, Platform, StatusBar, Easing,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TabGridCard } from './TabGridCard';
import { TerminalTab } from '../types/terminal.types';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

const COLUMN_GAP = 8;
const PADDING = 12;

export interface TabGridViewProps {
  visible: boolean;
  tabs: TerminalTab[];
  outputBuffers: Record<string, string>;
  lastActivity: Record<string, number>;
  translateY: Animated.Value; // kept for compat but we use our own anims
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
}: TabGridViewProps) {
  const responsive = useResponsive();

  // Liquid morph animation values
  const morphProgress = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      morphProgress.setValue(0);
      contentOpacity.setValue(0);

      // Phase 1: Morph from island pill to fullscreen (fast spring)
      Animated.spring(morphProgress, {
        toValue: 1,
        tension: 65,
        friction: 10,
        useNativeDriver: false,
      }).start();

      // Phase 2: Content fades in after morph starts
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 250,
        delay: 120,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const dismiss = useCallback(() => {
    // Reverse: content fades out first, then morph back
    Animated.timing(contentOpacity, {
      toValue: 0,
      duration: 120,
      useNativeDriver: true,
    }).start();

    Animated.timing(morphProgress, {
      toValue: 0,
      duration: 280,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    }).start(() => onClose());
  }, [onClose]);

  const handleSelect = useCallback((tabId: string) => {
    // Quick fade then close
    Animated.timing(contentOpacity, {
      toValue: 0,
      duration: 80,
      useNativeDriver: true,
    }).start();

    Animated.timing(morphProgress, {
      toValue: 0,
      duration: 220,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      onSelectTab(tabId);
      onClose();
    });
  }, [onSelectTab, onClose]);

  // Interpolations for the liquid morph effect
  // Start: small pill at top center (like the island)
  // End: fullscreen rectangle
  const morphBorderRadius = morphProgress.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [22, 16, 0],
  });

  const morphTop = morphProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  const morphHorizontal = morphProgress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [60, 20, 0],
  });

  const morphHeight = morphProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [40, 100], // percentage-like, used as flex basis
  });

  const morphScaleY = morphProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.06, 1],
  });

  const morphOpacity = morphProgress.interpolate({
    inputRange: [0, 0.15],
    outputRange: [0, 1],
  });

  const bgOpacity = morphProgress.interpolate({
    inputRange: [0, 0.4],
    outputRange: [0, 1],
  });

  const renderItem = useCallback(({ item }: { item: TerminalTab }) => {
    return (
      <TabGridCard
        tab={item}
        outputBuffer={outputBuffers[item.id] ?? ''}
        isActive={item.active}
        lastActivityMs={lastActivity[item.id] ?? 0}
        onSelect={(id) => handleSelect(id)}
        onClose={onCloseTab}
      />
    );
  }, [outputBuffers, lastActivity, handleSelect, onCloseTab]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="none"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={dismiss}
    >
      {/* Background fade */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, opacity: bgOpacity }]} />

      {/* Morphing container — starts as pill, expands to fullscreen */}
      <Animated.View
        style={[
          s.morphContainer,
          {
            top: morphTop,
            left: morphHorizontal,
            right: morphHorizontal,
            borderRadius: morphBorderRadius,
            opacity: morphOpacity,
            transform: [{ scaleY: morphScaleY }],
            paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
          },
        ]}
      >
        {/* Header */}
        <Animated.View style={[s.header, { opacity: contentOpacity }]}>
          <TouchableOpacity onPress={dismiss} style={s.headerBtn}>
            <Text style={s.cancelText}>Abbrechen</Text>
          </TouchableOpacity>
          <View style={s.headerCenter}>
            <Feather name="grid" size={14} color={colors.textDim} />
            <Text style={s.headerTitle}>{tabs.length} Terminals</Text>
          </View>
          <TouchableOpacity onPress={dismiss} style={[s.headerBtn, { alignItems: 'flex-end' }]}>
            <View style={s.doneBtn}>
              <Text style={s.doneText}>Fertig</Text>
            </View>
          </TouchableOpacity>
        </Animated.View>

        {/* Grid */}
        <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
          <FlatList
            key={String(responsive.gridColumns)}
            data={tabs}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            numColumns={responsive.gridColumns}
            style={s.list}
            contentContainerStyle={{ padding: PADDING, paddingBottom: 80 }}
            columnWrapperStyle={{ gap: COLUMN_GAP, marginBottom: COLUMN_GAP }}
            showsVerticalScrollIndicator={false}
          />
        </Animated.View>

        {/* Bottom bar */}
        <Animated.View style={[s.bottomBar, { opacity: contentOpacity }]}>
          <TouchableOpacity style={s.addBtn} onPress={onAddTab}>
            <Feather name="plus" size={16} color={colors.primary} />
            <Text style={s.addText}>Neuer Tab</Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  morphContainer: {
    position: 'absolute',
    bottom: 0,
    backgroundColor: colors.bg,
    overflow: 'hidden',
    transformOrigin: 'top center',
  },
  header: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  headerBtn: {
    minWidth: 80,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cancelText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '500',
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
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  doneText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
  bottomBar: {
    height: 52,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(59,130,246,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.2)',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  addText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
    fontFamily: fonts.mono,
  },
});
