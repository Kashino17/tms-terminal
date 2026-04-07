/**
 * PinSetupScreen — handles three flows:
 *   mode='setup'   → set a new PIN and enable App Lock
 *   mode='change'  → set a new PIN (lock already enabled)
 *   mode='disable' → enter current PIN to disable App Lock
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Animated, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { useLockStore } from '../store/lockStore';
import { colors, fontSizes } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

type Mode = 'setup' | 'change' | 'disable';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PinSetup'>;
  route: RouteProp<RootStackParamList, 'PinSetup'>;
};

const ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['',  '0', 'del'],
];

const HEADERS: Record<Mode, { title: string; subtitle: string }[]> = {
  setup: [
    { title: 'Create PIN',   subtitle: 'Choose a 6-digit backup PIN' },
    { title: 'Confirm PIN',  subtitle: 'Enter the same PIN again to confirm' },
  ],
  change: [
    { title: 'New PIN',      subtitle: 'Choose a new 6-digit PIN' },
    { title: 'Confirm PIN',  subtitle: 'Enter the same PIN again to confirm' },
  ],
  disable: [
    { title: 'Enter PIN',    subtitle: 'Enter your PIN to disable App Lock' },
  ],
};

export function PinSetupScreen({ navigation, route }: Props) {
  const mode: Mode = (route.params?.mode as Mode) ?? 'setup';
  const insets = useSafeAreaInsets();
  const { enable, disable, changePin, verifyPin } = useLockStore();
  const { rf, rs, ri, isExpanded, isLandscape } = useResponsive();

  const [stage,    setStage]    = useState(0);   // 0 = first entry, 1 = confirm
  const [pin,      setPin]      = useState('');
  const [firstPin, setFirstPin] = useState('');  // stored from stage 0
  const [error,    setError]    = useState('');

  const shakeAnim = useRef(new Animated.Value(0)).current;

  const { title, subtitle } = HEADERS[mode][stage] ?? HEADERS[mode][0];

  const shake = useCallback(() => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12,  duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8,   duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8,  duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,   duration: 55, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const handleKey = useCallback((key: string) => {
    setError('');
    if (key === 'del') {
      setPin(p => p.slice(0, -1));
      return;
    }
    if (pin.length >= 6) return;

    const next = pin + key;
    setPin(next);
    if (next.length < 6) return;

    // All 6 digits entered
    setTimeout(async () => {
      if (mode === 'disable') {
        if (await verifyPin(next)) {
          await disable();
          navigation.goBack();
        } else {
          shake();
          setError('Incorrect PIN');
          setPin('');
        }
        return;
      }

      // setup / change — two-stage confirm flow
      if (stage === 0) {
        setFirstPin(next);
        setPin('');
        setStage(1);
      } else {
        if (next === firstPin) {
          if (mode === 'setup')  await enable(next);
          if (mode === 'change') await changePin(next);
          navigation.goBack();
        } else {
          shake();
          setError("PINs don't match — try again");
          setPin('');
          setFirstPin('');
          setStage(0);
        }
      }
    }, 80);
  }, [pin, stage, firstPin, mode, verifyPin, enable, disable, changePin, navigation, shake]);

  const dotSize = ri(14);
  const keyHeight = isLandscape ? ri(42) : ri(60);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.scrollContent, {
        paddingTop: insets.top + (isLandscape ? rs(8) : rs(16)),
        paddingHorizontal: rs(24),
        maxWidth: isExpanded ? 400 : undefined,
        alignSelf: isExpanded ? 'center' as const : undefined,
        width: isExpanded ? '100%' as unknown as number : undefined,
      }]}
      bounces={false}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Header ── */}
      <View style={[styles.header, { marginBottom: isLandscape ? rs(12) : rs(40) }]}>
        <Text style={[styles.title, { fontSize: rf(22), marginBottom: rs(8) }]}>{title}</Text>
        <Text style={[styles.subtitle, { fontSize: rf(13) }]}>{subtitle}</Text>
      </View>

      {/* ── Dots ── */}
      <Animated.View style={[styles.dotsRow, { gap: rs(16), marginBottom: rs(12), transform: [{ translateX: shakeAnim }] }]}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              { width: dotSize, height: dotSize, borderRadius: dotSize / 2 },
              i < pin.length && styles.dotFilled,
              !!error && styles.dotError,
            ]}
          />
        ))}
      </Animated.View>

      <Text style={[styles.errorText, { fontSize: rf(13), marginBottom: rs(16) }]}>{error || ' '}</Text>

      {/* Stage indicator for 2-step flows */}
      {mode !== 'disable' && (
        <View style={[styles.stageRow, { gap: rs(8), marginBottom: rs(28) }]}>
          <View style={[styles.stageDot, stage === 0 && styles.stageDotActive]} />
          <View style={[styles.stageDot, stage === 1 && styles.stageDotActive]} />
        </View>
      )}

      {/* ── Numpad ── */}
      <View style={[styles.numpad, { gap: rs(10) }]}>
        {ROWS.map((row, ri_) => (
          <View key={ri_} style={[styles.numRow, { gap: rs(10) }]}>
            {row.map((key, ki) =>
              key === '' ? (
                <View key={ki} style={[styles.numKeyPlaceholder, { height: keyHeight }]} />
              ) : (
                <TouchableOpacity
                  key={ki}
                  style={[styles.numKey, { height: keyHeight }]}
                  onPress={() => handleKey(key)}
                  activeOpacity={0.45}
                  accessibilityLabel={key === 'del' ? 'Delete' : key}
                  accessibilityRole="button"
                >
                  {key === 'del'
                    ? <Feather name="delete" size={ri(22)} color={colors.text} />
                    : <Text style={[styles.numText, { fontSize: rf(26) }]}>{key}</Text>
                  }
                </TouchableOpacity>
              ),
            )}
          </View>
        ))}
      </View>

      <View style={{ height: insets.bottom + rs(16) }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
  },
  title: {
    color: colors.text,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
    textAlign: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
  },
  dot: {
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: 'transparent',
  },
  dotFilled: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  dotError: {
    backgroundColor: colors.destructive,
    borderColor: colors.destructive,
  },
  errorText: {
    color: colors.destructive,
    height: 20,
    textAlign: 'center',
  },
  stageRow: {
    flexDirection: 'row',
  },
  stageDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  stageDotActive: {
    backgroundColor: colors.primary,
  },
  numpad: {
    width: '100%',
    justifyContent: 'center',
  },
  numRow: {
    flexDirection: 'row',
  },
  numKey: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numKeyPlaceholder: {
    flex: 1,
  },
  numText: {
    color: colors.text,
    fontWeight: '500',
  },
});
