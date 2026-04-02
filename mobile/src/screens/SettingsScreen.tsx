import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Switch, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';
import { useLockStore } from '../store/lockStore';
import { useSettingsStore, IDLE_THRESHOLD_OPTIONS } from '../store/settingsStore';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { useCloudProjectsStore } from '../store/cloudProjectsStore';
import { TERMINAL_THEMES, getThemeById } from '../constants/terminalThemes';
import { colors, fonts, fontSizes, spacing } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { getCurrentVersion, checkForPreviousVersion, downloadAndInstall, formatSize } from '../services/updater.service';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'>;
};

export function SettingsScreen({ navigation }: Props) {
  const { isEnabled, isUnlocked } = useLockStore();
  const { rf, rs, ri, isExpanded } = useResponsive();
  const { idleThresholdSeconds, setIdleThreshold, terminalTheme, setTerminalTheme } = useSettingsStore();
  const { tokens, notificationsEnabled, pollingIntervalMs, setNotificationsEnabled, setPollingIntervalMs, clearPlatform } = useCloudAuthStore();
  const { clearCache } = useCloudProjectsStore();
  const [idlePickerVisible, setIdlePickerVisible] = useState(false);
  const [themePickerVisible, setThemePickerVisible] = useState(false);
  const [pollingPickerVisible, setPollingPickerVisible] = useState(false);
  const [prevVersion, setPrevVersion] = useState<{ version: string; downloadUrl: string; size: number } | null>(null);
  const [prevVersionLoading, setPrevVersionLoading] = useState(true);

  useEffect(() => {
    checkForPreviousVersion().then(setPrevVersion).catch(() => {}).finally(() => setPrevVersionLoading(false));
  }, []);

  const currentIdleLabel = IDLE_THRESHOLD_OPTIONS.find((o) => o.value === idleThresholdSeconds)?.label ?? `${idleThresholdSeconds}s`;
  const currentThemeName = getThemeById(terminalTheme).name;

  const POLLING_OPTIONS = [
    { label: '1 Min', value: 60_000 },
    { label: '2 Min', value: 120_000 },
    { label: '5 Min', value: 300_000 },
  ];
  const currentPollingLabel = POLLING_OPTIONS.find((o) => o.value === pollingIntervalMs)?.label ?? '2 Min';

  const maskToken = (token: string | null) => {
    if (!token) return null;
    return token.slice(0, 8) + '…';
  };

  const handleDisconnectPlatform = (platform: 'render' | 'vercel') => {
    clearPlatform(platform);
    clearCache(platform);
  };

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

        {/* ── Notifications ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Benachrichtigungen</Text>

          <View style={styles.card}>
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={() => setIdlePickerVisible(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Benachrichtigung bei Inaktivität"
            >
              <View style={styles.rowLeft}>
                <Feather name="bell" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Inaktivitäts-Benachrichtigung</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Push wenn Terminal idle ist</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.value, { fontSize: rf(14), marginRight: rs(4) }]}>{currentIdleLabel}</Text>
                <Feather name="chevron-right" size={ri(16)} color={colors.textDim} />
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Idle threshold picker modal */}
        <Modal
          visible={idlePickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setIdlePickerVisible(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setIdlePickerVisible(false)}>
            <View style={[styles.modalContent, { padding: rs(8), maxWidth: isExpanded ? 400 : 320 }]}>
              <Text style={[styles.modalTitle, { fontSize: rf(16), paddingHorizontal: rs(12), paddingVertical: rs(12) }]}>Benachrichtigung bei Inaktivität</Text>
              {IDLE_THRESHOLD_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.modalOption, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
                  onPress={() => { setIdleThreshold(option.value); setIdlePickerVisible(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.modalOptionText, { fontSize: rf(15) }]}>{option.label}</Text>
                  {idleThresholdSeconds === option.value && (
                    <Feather name="check" size={ri(18)} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Modal>

        {/* ── Terminal ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Terminal</Text>

          <View style={styles.card}>
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={() => setThemePickerVisible(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Terminal-Theme"
            >
              <View style={styles.rowLeft}>
                <Feather name="droplet" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Terminal-Theme</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Farbschema des Terminals</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.value, { fontSize: rf(14), marginRight: rs(4) }]}>{currentThemeName}</Text>
                <Feather name="chevron-right" size={ri(16)} color={colors.textDim} />
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Theme picker modal */}
        <Modal
          visible={themePickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setThemePickerVisible(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setThemePickerVisible(false)}>
            <View style={[styles.modalContent, { padding: rs(8), maxWidth: isExpanded ? 400 : 320 }]}>
              <Text style={[styles.modalTitle, { fontSize: rf(16), paddingHorizontal: rs(12), paddingVertical: rs(12) }]}>Terminal-Theme</Text>
              {TERMINAL_THEMES.map((theme) => (
                <TouchableOpacity
                  key={theme.id}
                  style={[styles.modalOption, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
                  onPress={() => { setTerminalTheme(theme.id); setThemePickerVisible(false); }}
                  activeOpacity={0.7}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <View style={[styles.themePreview, { backgroundColor: theme.colors.background, borderColor: colors.border }]}>
                      <Text style={{ color: theme.colors.green, fontSize: rf(8), fontFamily: fonts.mono }}>$</Text>
                      <Text style={{ color: theme.colors.foreground, fontSize: rf(8), fontFamily: fonts.mono }}> ~</Text>
                    </View>
                    <Text style={[styles.modalOptionText, { fontSize: rf(15) }]}>{theme.name}</Text>
                  </View>
                  {terminalTheme === theme.id && (
                    <Feather name="check" size={ri(18)} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Modal>

        {/* ── Cloud ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Cloud</Text>

          <View style={styles.card}>
            {/* Render row */}
            <View style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}>
              <View style={styles.rowLeft}>
                <Feather name="box" size={ri(18)} color="#4353FF" style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Render</Text>
                  {tokens.render ? (
                    <Text style={[styles.rowSub, { fontSize: rf(11) }]}>{maskToken(tokens.render)} · Verbunden</Text>
                  ) : (
                    <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Nicht verbunden</Text>
                  )}
                </View>
              </View>
              {tokens.render && (
                <TouchableOpacity
                  onPress={() => handleDisconnectPlatform('render')}
                  activeOpacity={0.7}
                  style={{ paddingHorizontal: rs(10), paddingVertical: rs(6), backgroundColor: colors.border, borderRadius: 8 }}
                >
                  <Text style={{ color: colors.textMuted, fontSize: rf(13), fontWeight: '500' }}>Trennen</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={[styles.separator, { marginHorizontal: rs(16) }]} />

            {/* Vercel row */}
            <View style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}>
              <View style={styles.rowLeft}>
                <Feather name="triangle" size={ri(18)} color="#FFFFFF" style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Vercel</Text>
                  {tokens.vercel ? (
                    <Text style={[styles.rowSub, { fontSize: rf(11) }]}>{maskToken(tokens.vercel)} · Verbunden</Text>
                  ) : (
                    <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Nicht verbunden</Text>
                  )}
                </View>
              </View>
              {tokens.vercel && (
                <TouchableOpacity
                  onPress={() => handleDisconnectPlatform('vercel')}
                  activeOpacity={0.7}
                  style={{ paddingHorizontal: rs(10), paddingVertical: rs(6), backgroundColor: colors.border, borderRadius: 8 }}
                >
                  <Text style={{ color: colors.textMuted, fontSize: rf(13), fontWeight: '500' }}>Trennen</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={[styles.separator, { marginHorizontal: rs(16) }]} />

            {/* Deploy-Alerts toggle */}
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={() => setNotificationsEnabled(!notificationsEnabled)}
              activeOpacity={0.7}
              accessibilityRole="switch"
              accessibilityState={{ checked: notificationsEnabled }}
            >
              <View style={styles.rowLeft}>
                <Feather name="bell" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Deploy-Alerts</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Push bei Deploy-Ereignissen</Text>
                </View>
              </View>
              <Switch
                value={notificationsEnabled}
                onValueChange={setNotificationsEnabled}
                trackColor={{ false: colors.border, true: colors.primary + '88' }}
                thumbColor={notificationsEnabled ? colors.primary : colors.textDim}
              />
            </TouchableOpacity>

            <View style={[styles.separator, { marginHorizontal: rs(16) }]} />

            {/* Polling-Intervall selector */}
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={() => setPollingPickerVisible(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Polling-Intervall"
            >
              <View style={styles.rowLeft}>
                <Feather name="refresh-cw" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Polling-Intervall</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Abfrageintervall für Deploys</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.value, { fontSize: rf(14), marginRight: rs(4) }]}>{currentPollingLabel}</Text>
                <Feather name="chevron-right" size={ri(16)} color={colors.textDim} />
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Polling interval picker modal */}
        <Modal
          visible={pollingPickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setPollingPickerVisible(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setPollingPickerVisible(false)}>
            <View style={[styles.modalContent, { padding: rs(8), maxWidth: isExpanded ? 400 : 320 }]}>
              <Text style={[styles.modalTitle, { fontSize: rf(16), paddingHorizontal: rs(12), paddingVertical: rs(12) }]}>Polling-Intervall</Text>
              {POLLING_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.modalOption, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
                  onPress={() => { setPollingIntervalMs(option.value); setPollingPickerVisible(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.modalOptionText, { fontSize: rf(15) }]}>{option.label}</Text>
                  {pollingIntervalMs === option.value && (
                    <Feather name="check" size={ri(18)} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Modal>

        {/* ── Version ── */}
        <View style={[styles.section, { marginBottom: rs(28) }]}>
          <Text style={[styles.sectionTitle, { fontSize: rf(11), marginBottom: rs(10) }]}>Version</Text>
          <View style={styles.card}>
            <View style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}>
              <View style={styles.rowLeft}>
                <Feather name="info" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <Text style={[styles.label, { fontSize: rf(16) }]}>Aktuell</Text>
              </View>
              <Text style={[styles.value, { fontSize: rf(16) }]}>v{getCurrentVersion()}</Text>
            </View>

            <View style={[styles.separator, { marginHorizontal: rs(16) }]} />

            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14), opacity: prevVersion ? 1 : 0.4 }]}
              onPress={() => {
                if (!prevVersion) return;
                Alert.alert(
                  'Version wiederherstellen',
                  `Wirklich auf ${prevVersion.version} zuruecksetzen?\n\nDie APK (${formatSize(prevVersion.size)}) wird heruntergeladen und installiert.`,
                  [
                    { text: 'Abbrechen', style: 'cancel' },
                    {
                      text: 'Wiederherstellen',
                      onPress: () => downloadAndInstall(prevVersion.downloadUrl),
                    },
                  ],
                );
              }}
              activeOpacity={prevVersion ? 0.7 : 1}
              disabled={!prevVersion && !prevVersionLoading}
            >
              <View style={styles.rowLeft}>
                <Feather name="rotate-ccw" size={ri(18)} color={prevVersion ? colors.warning : colors.textDim} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Vorherige Version</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>
                    {prevVersionLoading
                      ? 'Wird geladen...'
                      : prevVersion
                        ? `${prevVersion.version} · ${formatSize(prevVersion.size)}`
                        : 'Keine vorherige Version verfuegbar'}
                  </Text>
                </View>
              </View>
              {prevVersionLoading
                ? <ActivityIndicator size="small" color={colors.textDim} />
                : prevVersion
                  ? <Feather name="download" size={ri(16)} color={colors.textDim} />
                  : null
              }
            </TouchableOpacity>
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    width: '85%',
  },
  modalTitle: {
    color: colors.text,
    fontWeight: '700',
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
  },
  modalOptionText: {
    color: colors.text,
  },
  themePreview: {
    width: 32,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    marginRight: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
