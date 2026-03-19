import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import {
  checkForUpdate,
  downloadAndInstall,
  getCurrentVersion,
  formatSize,
} from '../services/updater.service';

export function UpdateBanner() {
  const { rf, rs, ri } = useResponsive();
  const [update, setUpdate] = useState<{
    version: string;
    changelog: string;
    downloadUrl: string;
    size: number;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkForUpdate().then(setUpdate).catch(() => {});
  }, []);

  const handleUpdate = useCallback(() => {
    if (!update) return;
    downloadAndInstall(update.downloadUrl).catch(() => {});
  }, [update]);

  if (!update || dismissed) return null;

  return (
    <View style={[styles.banner, { padding: rs(12), gap: rs(10) }]}>
      <View style={styles.row}>
        <Feather name="download-cloud" size={ri(20)} color={colors.accent} />
        <View style={styles.textCol}>
          <Text style={[styles.title, { fontSize: rf(13) }]}>
            Update verfügbar: {update.version}
          </Text>
          <Text style={[styles.subtitle, { fontSize: rf(11) }]} numberOfLines={2}>
            {update.changelog.split('\n')[0]} · {formatSize(update.size)}
          </Text>
          <Text style={[styles.current, { fontSize: rf(10) }]}>
            Aktuell: v{getCurrentVersion()}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setDismissed(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="x" size={ri(16)} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.updateBtn, { paddingVertical: rs(10) }]}
        onPress={handleUpdate}
        activeOpacity={0.7}
      >
        <Feather name="download" size={ri(14)} color={colors.bg} />
        <Text style={[styles.updateBtnText, { fontSize: rf(13) }]}>Jetzt updaten</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
  },
  current: {
    color: colors.textDim,
    fontFamily: fonts.mono,
  },
  updateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: 10,
  },
  updateBtnText: {
    color: colors.bg,
    fontWeight: '700',
  },
});
