import React, { useRef, useCallback } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Animated } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { ServerProfile, ServerStatus } from '../types/server.types';
import { colors, fonts } from '../theme';

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
  const connected = status?.connected ?? false;
  const latency = status?.latency;
  const color = avatarColor(server.name);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const pressIn = useCallback(() => {
    Animated.spring(scaleAnim, { toValue: 0.97, tension: 200, friction: 10, useNativeDriver: true }).start();
  }, []);

  const pressOut = useCallback(() => {
    Animated.spring(scaleAnim, { toValue: 1, tension: 150, friction: 8, useNativeDriver: true }).start();
  }, []);

  return (
    <Animated.View style={[s.card, { transform: [{ scale: scaleAnim }] }]}>
      {/* ── Main area — navigates to terminal ──────────────────── */}
      <Pressable
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onPress(); }}
        onPressIn={pressIn}
        onPressOut={pressOut}
        onLongPress={onLongPress}
        style={s.mainRow}
      >
        {/* Avatar */}
        {server.avatar ? (
          <Image source={{ uri: server.avatar }} style={[s.avatar, { backgroundColor: color }]} />
        ) : (
          <View style={[s.avatar, { backgroundColor: color }]}>
            <Text style={s.avatarText}>{initials(server.name)}</Text>
          </View>
        )}

        {/* Info */}
        <View style={s.info}>
          <View style={s.nameRow}>
            <Text style={s.name} numberOfLines={1}>{server.name}</Text>
            <View style={[s.statusDot, connected && s.statusDotOn]} />
          </View>
          <Text style={s.host} numberOfLines={1}>{server.host}:{server.port}</Text>
        </View>

        {/* Latency */}
        <View style={s.right}>
          {connected && latency != null ? (
            <Text style={[s.latency, { color: latency < 50 ? '#22C55E' : latency < 150 ? '#F59E0B' : '#EF4444' }]}>
              {latency}ms
            </Text>
          ) : (
            <Text style={s.offlineText}>{connected ? '—' : 'Offline'}</Text>
          )}
        </View>
      </Pressable>

      {/* ── Agent strip — completely separate touch target ──────── */}
      {connected && (
        <Pressable
          onPress={(e) => {
            // This is the key: the agent strip handles its own press
            // and does NOT bubble up to the main card area
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onManagerPress?.();
          }}
          style={({ pressed }) => [s.agentStrip, pressed && s.agentStripPressed]}
        >
          <View style={s.agentDot} />
          <Text style={s.agentName}>Rem</Text>
          <Text style={s.agentMsg} numberOfLines={1}>Agent bereit</Text>
          <View style={s.agentChatBtn}>
            <Feather name="message-circle" size={12} color="#A78BFA" />
            <Text style={s.agentChatText}>Chat</Text>
          </View>
        </Pressable>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#1B2336',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#243044',
    marginVertical: 6,
    overflow: 'hidden',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#475569',
  },
  statusDotOn: {
    backgroundColor: '#22C55E',
  },
  host: {
    color: '#64748B',
    fontSize: 10,
    fontFamily: fonts.mono,
    marginTop: 2,
  },
  right: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  latency: {
    fontSize: 11,
    fontFamily: fonts.mono,
    fontWeight: '600',
  },
  offlineText: {
    fontSize: 10,
    color: '#475569',
  },
  // Agent strip — fully independent touch area
  agentStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(167,139,250,0.1)',
    backgroundColor: 'rgba(167,139,250,0.04)',
  },
  agentStripPressed: {
    backgroundColor: 'rgba(167,139,250,0.1)',
  },
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#A78BFA',
  },
  agentName: {
    fontSize: 10,
    fontWeight: '600',
    color: '#A78BFA',
  },
  agentMsg: {
    flex: 1,
    fontSize: 10,
    color: '#64748B',
  },
  agentChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(167,139,250,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.15)',
  },
  agentChatText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#A78BFA',
  },
});
