import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Switch,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';
import { useLockStore } from '../store/lockStore';
import { colors, fonts, fontSizes, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'>;
};

export function SettingsScreen({ navigation }: Props) {
  const { isEnabled, isUnlocked } = useLockStore();
  const { rf, rs, ri, isExpanded } = useResponsive();

  const handleLockToggle = () => {
    if (isEnabled) {
      // Disable: require current PIN first
      navigation.navigate('PinSetup', { mode: 'disable' });
    } else {
      // Enable: set a new PIN
      navigation.navigate('PinSetup', { mode: 'setup' });
    }
  };

  const handleChangePin = () => {
    navigation.navigate('PinSetup', { mode: 'change' });
  };

  const handleClearData = () => {
    Alert.alert(
      'Clear All Data',
      'This will remove all saved servers and settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await AsyncStorage.clear();
            Alert.alert('Done', 'All data cleared. Restart the app.');
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <View style={[
        styles.content,
        {
          padding: rs(16),
          maxWidth: isExpanded ? 500 : undefined,
          alignSelf: isExpanded ? 'center' as const : undefined,
          width: isExpanded ? '100%' as unknown as number : undefined,
        },
      ]}>
        {/* ── Security ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Security</Text>

          <View style={styles.card}>
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={handleLockToggle}
              activeOpacity={0.7}
              accessibilityRole="switch"
              accessibilityState={{ checked: isEnabled }}
            >
              <View style={styles.rowLeft}>
                <Feather name="lock" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>App Lock</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Face ID / Touch ID + PIN</Text>
                </View>
              </View>
              <Switch
                value={isEnabled}
                onValueChange={handleLockToggle}
                trackColor={{ false: colors.border, true: colors.primary + '88' }}
                thumbColor={isEnabled ? colors.primary : colors.textDim}
              />
            </TouchableOpacity>

            {isEnabled && (
              <>
                <View style={[styles.separator, { marginHorizontal: rs(16) }]} />
                <TouchableOpacity
                  style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
                  onPress={handleChangePin}
                  activeOpacity={0.7}
                >
                  <View style={styles.rowLeft}>
                    <Feather name="key" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                    <Text style={[styles.label, { fontSize: rf(16) }]}>Change PIN</Text>
                  </View>
                  <Feather name="chevron-right" size={ri(16)} color={colors.textDim} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* ── About ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>About</Text>
          <View style={styles.card}>
            <View style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}>
              <Text style={[styles.label, { fontSize: rf(16) }]}>Version</Text>
              <Text style={[styles.value, { fontSize: rf(16) }]}>1.0.0</Text>
            </View>
          </View>
        </View>

        {/* ── Data ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Data</Text>
          <TouchableOpacity style={[styles.dangerButton, { padding: rs(14) }]} onPress={handleClearData}>
            <Text style={[styles.dangerText, { fontSize: rf(16) }]}>Clear All Data</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {},
  section: {},
  sectionTitle: {
    color: colors.primary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  rowSub: {
    color: colors.textMuted,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
  },
  label: {
    color: colors.text,
  },
  value: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
  },
  dangerButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.destructive,
  },
  dangerText: {
    color: colors.destructive,
    fontWeight: '500',
  },
});
