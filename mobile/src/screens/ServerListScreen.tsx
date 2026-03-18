import React, { useEffect, useCallback } from 'react';
import { View, FlatList, Text, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useServerStore } from '../store/serverStore';
import { ServerCard } from '../components/ServerCard';
import { ServerProfile } from '../types/server.types';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

export function ServerListScreen({ navigation }: Props) {
  const { servers, statuses, loading, loadServers, deleteServer, updateServer, setStatus } = useServerStore();
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;

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

  const handleLongPress = useCallback((server: ServerProfile) => {
    Alert.alert(
      server.name,
      `${server.host}:${server.port}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteServer(server.id),
        },
      ],
    );
  }, [deleteServer]);

  const handleAvatarPress = useCallback(async (server: ServerProfile) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Allow photo library access to set a profile picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const src = result.assets[0].uri;
    const dir = `${FileSystem.documentDirectory}avatars/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const dest = `${dir}${server.id}.jpg`;
    await FileSystem.copyAsync({ from: src, to: dest });
    await updateServer(server.id, { avatar: dest });
  }, [updateServer]);

  const renderItem = useCallback(({ item }: { item: ServerProfile }) => (
    <ServerCard
      server={item}
      status={statuses[item.id]}
      onPress={() => handlePress(item)}
      onLongPress={() => handleLongPress(item)}
      onAvatarPress={() => handleAvatarPress(item)}
    />
  ), [statuses, handlePress, handleLongPress, handleAvatarPress]);

  const cardHeight = responsive.cardHeight;
  const getItemLayout = useCallback((_: any, index: number) => ({
    length: cardHeight,
    offset: cardHeight * index,
    index,
  }), [cardHeight]);

  const fabSize = ri(56);

  return (
    <View style={styles.container}>
      <FlatList
        data={servers}
        key={String(responsive.listColumns)}
        numColumns={responsive.listColumns}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={responsive.listColumns === 1 ? getItemLayout : undefined}
        contentContainerStyle={{ paddingVertical: rs(12), paddingHorizontal: rs(16) }}
        columnWrapperStyle={responsive.listColumns === 2 ? { gap: rs(12) } : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="server" size={ri(48)} color={colors.border} />
            <Text style={[styles.emptyText, { fontSize: rf(18) }]}>No servers yet</Text>
            <Text style={[styles.emptySubtext, { fontSize: rf(14) }]}>Tap + to add your first PC</Text>
          </View>
        }
      />
      <TouchableOpacity
        style={[styles.fab, {
          right: rs(20),
          bottom: rs(30),
          width: fabSize,
          height: fabSize,
          borderRadius: fabSize / 2,
        }]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          navigation.navigate('AddServer');
        }}
        accessibilityLabel="Add server"
        accessibilityRole="button"
      >
        <Feather name="plus" size={ri(24)} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
