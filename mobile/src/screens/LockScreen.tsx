import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import { Feather } from '@expo/vector-icons';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLockStore } from '../store/lockStore';
import { colors, fontSizes, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

type BioType = 'fingerprint' | 'face' | 'none';

const ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['',  '0', 'del'],
];

export function LockScreen() {
  const insets = useSafeAreaInsets();
  const { unlock, verifyPin } = useLockStore();
  const { rf, rs, ri, isExpanded, isLandscape } = useResponsive();

  const [pin,          setPin]          = useState('');
  const [error,        setError]        = useState('');
  const [mode,         setMode]         = useState<'bio' | 'pin'>('bio');
  const [bioType,      setBioType]      = useState<BioType>('none');
  const [bioAvailable, setBioAvailable] = useState(false);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  // Fade in on mount
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, []);

  // Detect biometric hardware
  useEffect(() => {
    (async () => {
      const hasHw = await LocalAuthentication.hasHardwareAsync();
      if (!hasHw) { setMode('pin'); return; }
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) { setMode('pin'); return; }
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      setBioType(
        types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
          ? 'face'
          : 'fingerprint',
      );
      setBioAvailable(true);
    })();
  }, []);

  const triggerBiometric = useCallback(async () => {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to open TMS Terminal',
        cancelLabel: 'Use PIN',
        disableDeviceFallback: true,
      });
      if (result.success) {
        unlock();
      } else if (result.error !== 'user_cancel') {
        // Biometric failed (not cancelled) → show PIN
        setMode('pin');
      }
    } catch {
      setMode('pin');
    }
  }, [unlock]);

  // Auto-trigger biometric once hardware is confirmed
  useEffect(() => {
    if (!bioAvailable) return;
    const t = setTimeout(triggerBiometric, 300);
    return () => clearTimeout(t);
  }, [bioAvailable, triggerBiometric]);

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

    if (next.length === 6) {
      setTimeout(async () => {
        if (await verifyPin(next)) {
          unlock();
        } else {
          shake();
          setError('Incorrect PIN');
          setPin('');
        }
      }, 80);
    }
  }, [pin, verifyPin, unlock, shake]);

  const bioIcon = bioType === 'face'
    ? <MaterialCommunityIcons name="face-recognition" size={ri(48)} color={colors.primary} />
    : <MaterialCommunityIcons name="fingerprint"      size={ri(48)} color={colors.primary} />;

  const bioLabel = bioType === 'face' ? 'Use Face ID' : 'Use Touch ID';

  const dotSize = ri(14);
  const keyHeight = isLandscape ? ri(44) : ri(62);
  const iconRingSize = isLandscape ? ri(48) : ri(68);
  const bioButtonSize = isLandscape ? ri(60) : ri(84);

  return (
    <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
    <ScrollView
      contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + (isLandscape ? rs(12) : rs(32)) }]}
      bounces={false}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Header ── */}
      <View style={[styles.top, { marginBottom: isLandscape ? rs(12) : rs(40) }]}>
        {!isLandscape && (
          <View style={[styles.iconRing, {
            width: iconRingSize,
            height: iconRingSize,
            borderRadius: iconRingSize / 2,
            marginBottom: rs(16),
          }]}>
            <Feather name="terminal" size={ri(30)} color={colors.primary} />
          </View>
        )}
        <Text style={[styles.appName, { fontSize: rf(22), marginBottom: rs(6) }]}>TMS Terminal</Text>
        <Text style={[styles.subtitle, { fontSize: rf(13) }]}>
          {mode === 'bio' ? 'Verify your identity' : 'Enter your PIN'}
        </Text>
      </View>

      {/* ── PIN dots ── */}
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

      <Text style={[styles.errorText, { fontSize: rf(13), marginBottom: rs(24) }]}>{error || ' '}</Text>

      {/* ── Content area ── */}
      {mode === 'bio' ? (
        <View style={styles.bioArea}>
          <TouchableOpacity
            style={[styles.bioButton, {
              width: bioButtonSize,
              height: bioButtonSize,
              borderRadius: bioButtonSize / 2,
            }]}
            onPress={triggerBiometric}
            activeOpacity={0.7}
            accessibilityLabel={bioLabel}
            accessibilityRole="button"
          >
            {bioIcon}
          </TouchableOpacity>
          <Text style={[styles.bioHint, { fontSize: rf(13) }]}>Tap to {bioLabel.toLowerCase()}</Text>
        </View>
      ) : (
        <View style={[styles.numpad, {
          paddingHorizontal: rs(24),
          gap: rs(10),
          maxWidth: isExpanded ? 400 : undefined,
          alignSelf: isExpanded ? 'center' as const : undefined,
          width: isExpanded ? '100%' as unknown as number : undefined,
        }]}>
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
      )}

      {/* ── Footer toggle ── */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + rs(24) }]}>
        {mode === 'bio' ? (
          <TouchableOpacity onPress={() => setMode('pin')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={[styles.toggleText, { fontSize: rf(15) }]}>Use PIN instead</Text>
          </TouchableOpacity>
        ) : bioAvailable ? (
          <TouchableOpacity onPress={triggerBiometric} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={[styles.toggleText, { fontSize: rf(15) }]}>{bioLabel}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
    zIndex: 9999,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  top: {
    alignItems: 'center',
  },
  iconRing: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appName: {
    color: colors.text,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
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
  bioArea: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingVertical: 24,
  },
  bioButton: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bioHint: {
    color: colors.textMuted,
  },
  numpad: {
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
  footer: {
    alignItems: 'center',
  },
  toggleText: {
    color: colors.primary,
    fontWeight: '500',
  },
});
