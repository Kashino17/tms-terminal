import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Animated, StyleSheet,
  Pressable, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

export interface ActionSheetOption {
  label: string;
  icon?: keyof typeof Feather.glyphMap;
  color?: string;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  title?: string;
  subtitle?: string;
  options: ActionSheetOption[];
  onClose: () => void;
}

export function ActionSheet({ visible, title, subtitle, options, onClose }: Props) {
  const { rf, rs, ri } = useResponsive();
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 120, friction: 14 }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      slideAnim.setValue(0);
      fadeAnim.setValue(0);
    }
  }, [visible]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => onClose());
  };

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [300, 0],
  });

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss}>
      <Pressable style={styles.backdrop} onPress={dismiss}>
        <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]} />
      </Pressable>

      <Animated.View
        style={[
          styles.sheet,
          {
            transform: [{ translateY }],
            paddingBottom: rs(Platform.OS === 'ios' ? 34 : 16),
            paddingHorizontal: rs(16),
          },
        ]}
      >
        <View style={styles.handle} />

        {(title || subtitle) && (
          <View style={[styles.header, { paddingVertical: rs(12), paddingHorizontal: rs(4) }]}>
            {title && <Text style={[styles.title, { fontSize: rf(15) }]}>{title}</Text>}
            {subtitle && (
              <Text style={[styles.subtitle, { fontSize: rf(11) }]} numberOfLines={2}>{subtitle}</Text>
            )}
          </View>
        )}

        <View style={[styles.optionList, { gap: rs(2) }]}>
          {options.map((opt, i) => {
            const color = opt.destructive ? colors.destructive : opt.color ?? colors.text;
            return (
              <TouchableOpacity
                key={i}
                style={[styles.option, { paddingVertical: rs(14), paddingHorizontal: rs(16) }]}
                onPress={() => { dismiss(); setTimeout(opt.onPress, 200); }}
                activeOpacity={0.6}
              >
                {opt.icon && (
                  <Feather name={opt.icon} size={ri(18)} color={color} style={{ marginRight: rs(12) }} />
                )}
                <Text style={[styles.optionText, { fontSize: rf(14), color }]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          style={[styles.cancelBtn, { paddingVertical: rs(14), marginTop: rs(8) }]}
          onPress={dismiss}
          activeOpacity={0.6}
        >
          <Text style={[styles.cancelText, { fontSize: rf(14) }]}>Abbrechen</Text>
        </TouchableOpacity>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 8,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
    marginBottom: 8,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    color: colors.text,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textDim,
    fontFamily: fonts.mono,
    marginTop: 4,
  },
  optionList: {},
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
  },
  optionText: {
    fontWeight: '500',
  },
  cancelBtn: {
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: colors.border,
  },
  cancelText: {
    color: colors.textMuted,
    fontWeight: '600',
  },
});
