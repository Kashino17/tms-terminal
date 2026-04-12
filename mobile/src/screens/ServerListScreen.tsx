import React, { useEffect, useCallback, useState, useRef } from 'react';
import { View, FlatList, Text, TouchableOpacity, Alert, StyleSheet, Animated } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useServerStore } from '../store/serverStore';
import { ServerCard } from '../components/ServerCard';
import { ServerProfile } from '../types/server.types';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { ActionSheet, ActionSheetOption } from '../components/ActionSheet';
import { UpdateBanner } from '../components/UpdateBanner';
import * as Clipboard from 'expo-clipboard';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

export function ServerListScreen({ navigation }: Props) {
  const { servers, statuses, loading, loadServers, deleteServer, updateServer, setStatus } = useServerStore();
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;
  const fabScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  // Ping all servers when screen focuses to show accurate connection status
  const pingAll = useCallback(async () => {
    const currentServers = useServerStore.getState().servers;
    await Promise.all(
      currentServers.map(async (server) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const start = Date.now();
        try {
          const res = await fetch(
            `http://${server.host}:${server.port}/health`,
            { signal: controller.signal },
          );
          clearTimeout(timeout);
          if (res.ok) {
            setStatus(server.id, { connected: true, latency: Date.now() - start });
          } else {
            setStatus(server.id, { connected: false });
          }
        } catch {
          clearTimeout(timeout);
          setStatus(server.id, { connected: false });
        }
      }),
    );
  }, [setStatus]);

  // Reload + re-ping when screen focuses
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      loadServers();
      pingAll();
    });
    return unsubscribe;
  }, [navigation, pingAll]);

  const handlePress = useCallback((server: ServerProfile) => {
    navigation.navigate('Terminal', {
      serverId: server.id,
      serverName: server.name,
      serverHost: server.host,
      serverPort: server.port,
      token: server.token ?? '',
    });
  }, [navigation]);

  const [actionSheet, setActionSheet] = useState<{
    title?: string; subtitle?: string; options: ActionSheetOption[];
  } | null>(null);

  const handleLongPress = useCallback((server: ServerProfile) => {
    setActionSheet({
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      options: [
        { label: 'Bearbeiten', icon: 'edit-2', onPress: () => navigation.navigate('AddServer', { server: server as any }) },
        { label: 'Adresse kopieren', icon: 'copy', onPress: () => Clipboard.setStringAsync(`${server.host}:${server.port}`) },
        { label: 'Server löschen', icon: 'trash-2', destructive: true, onPress: () => deleteServer(server.id) },
      ],
    });
  }, [deleteServer, navigation]);

  // Avatar tap now opens the connection (same as card tap)
  const handleAvatarPress = useCallback((server: ServerProfile) => {
    handlePress(server);
  }, [handlePress]);

  const renderItem = useCallback(({ item }: { item: ServerProfile }) => (
    <ServerCard
      server={item}
      status={statuses[item.id]}
      onPress={() => handlePress(item)}
      onLongPress={() => handleLongPress(item)}
      onAvatarPress={() => handleAvatarPress(item)}
      onManagerPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        navigation.navigate('Terminal', {
          serverId: item.id, serverName: item.name,
          serverHost: item.host, serverPort: item.port,
          token: item.token ?? '', openManager: true,
        });
      }}
    />
  ), [statuses, handlePress, handleLongPress, handleAvatarPress]);

  const cardHeight = responsive.cardHeight;
  const getItemLayout = useCallback((_: any, index: number) => ({
    length: cardHeight,
    offset: cardHeight * index,
    index,
  }), [cardHeight]);

  const fabSize = ri(56);

  const onlineCount = servers.filter(s => statuses[s.id]?.connected).length;

  return (
    <View style={styles.container}>
      <UpdateBanner />
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Server</Text>
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => navigation.navigate('Settings')}
          hitSlop={8}
        >
          <Feather name="settings" size={ri(18)} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={servers}
        key={String(responsive.listColumns)}
        numColumns={responsive.listColumns}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={responsive.listColumns === 1 ? getItemLayout : undefined}
        contentContainerStyle={{ paddingVertical: rs(6), paddingHorizontal: rs(16) }}
        columnWrapperStyle={responsive.listColumns === 2 ? { gap: rs(12) } : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="server" size={ri(48)} color={colors.border} />
            <Text style={[styles.emptyText, { fontSize: rf(18) }]}>Noch keine Server</Text>
            <Text style={[styles.emptySubtext, { fontSize: rf(14) }]}>Tippe +, um deinen ersten PC hinzuzufügen</Text>
          </View>
        }
      />
      <ActionSheet
        visible={!!actionSheet}
        title={actionSheet?.title}
        subtitle={actionSheet?.subtitle}
        options={actionSheet?.options ?? []}
        onClose={() => setActionSheet(null)}
      />
      <Animated.View style={[styles.fab, {
        right: rs(20),
        bottom: rs(30),
        width: fabSize,
        height: fabSize,
        borderRadius: fabSize / 2,
        transform: [{ scale: fabScale }],
      }]}>
        <TouchableOpacity
          style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
          onPressIn={() => Animated.spring(fabScale, { toValue: 0.85, tension: 200, friction: 10, useNativeDriver: true }).start()}
          onPressOut={() => Animated.spring(fabScale, { toValue: 1, tension: 150, friction: 6, useNativeDriver: true }).start()}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            navigation.navigate('AddServer');
          }}
          activeOpacity={1}
          accessibilityLabel="Server hinzufügen"
          accessibilityRole="button"
        >
          <Feather name="plus" size={ri(24)} color={colors.text} />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
  },
  emptyText: {
    color: colors.textMuted,
    marginBottom: 8,
    marginTop: 12,
  },
  emptySubtext: {
    color: colors.textDim,
  },
  fab: {
    position: 'absolute',
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
});
