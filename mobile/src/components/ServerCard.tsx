import React, { useMemo } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ServerProfile, ServerStatus } from '../types/server.types';
import { ConnectionStatus } from './ConnectionStatus';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

const AVATAR_SIZE = 44;
const AVATAR_COLORS = [
  '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B',
  '#10B981', '#06B6D4', '#EF4444', '#F97316',
];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

interface Props {
  server: ServerProfile;
  status?: ServerStatus;
  onPress: () => void;
  onLongPress: () => void;
  onAvatarPress?: () => void;
  onManagerPress?: () => void;
}

export function ServerCard({ server, status, onPress, onLongPress, onAvatarPress, onManagerPress }: Props) {
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;
  const avatarSz = responsive.avatarSize;

  const dynamicStyles = useMemo(() => ({
    card: { padding: rs(18), marginVertical: rs(6) },
    row: { gap: rs(12) },
    avatarWrap: { width: avatarSz, height: avatarSz },
    avatar: { width: avatarSz, height: avatarSz, borderRadius: avatarSz / 2 },
    avatarText: { fontSize: rf(16) },
    cameraBadge: { width: rs(18), height: rs(18), borderRadius: rs(9) },
    name: { fontSize: rf(18) },
    host: { fontSize: rf(14) },
    headerMargin: { marginBottom: rs(4) },
  }), [rf, rs, avatarSz]);

  return (
    <TouchableOpacity
      style={[styles.card, dynamicStyles.card, { borderLeftColor: status?.connected ? colors.accent : colors.border }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
      accessibilityLabel={`${server.name}, ${status?.connected ? 'Connected' : 'Disconnected'}, ${server.host}:${server.port}`}
      accessibilityRole="button"
      accessibilityHint="Double tap to connect"
    >
      <View style={[styles.row, dynamicStyles.row]}>
        <TouchableOpacity
          onPress={onAvatarPress}
          activeOpacity={0.75}
          disabled={!onAvatarPress}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityLabel={`Change profile picture for ${server.name}`}
          accessibilityRole="button"
        >
          <View style={dynamicStyles.avatarWrap}>
            {server.avatar ? (
              <Image source={{ uri: server.avatar }} style={dynamicStyles.avatar} />
            ) : (
              <View style={[dynamicStyles.avatar, { backgroundColor: avatarColor(server.name), alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={[styles.avatarText, dynamicStyles.avatarText]}>{initials(server.name)}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>

        <View style={styles.info}>
          <View style={[styles.header, dynamicStyles.headerMargin]}>
            <Text style={[styles.name, dynamicStyles.name]}>{server.name}</Text>
            <ConnectionStatus state={status?.connected ? 'connected' : 'disconnected'} />
          </View>
          <Text style={[styles.host, dynamicStyles.host]}>{server.host}:{server.port}</Text>
        </View>

        <Feather name="chevron-right" size={ri(16)} color={colors.textDim} />
      </View>
      {onManagerPress && (
        <TouchableOpacity
          style={[styles.managerBtn, { width: rs(28), height: rs(28), borderRadius: rs(14) }]}
          onPress={onManagerPress}
          hitSlop={6}
          accessibilityLabel="Manager Agent"
        >
          <Feather name="cpu" size={ri(13)} color={colors.textMuted} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 18,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
  host: {
    color: colors.textMuted,
    fontSize: 14,
    fontFamily: fonts.mono,
  },
  managerBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    backgroundColor: '#243044',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
});
