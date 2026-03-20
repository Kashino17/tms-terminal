import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useServerStore } from '../store/serverStore';
import { authService } from '../services/auth.service';
import { ServerProfile } from '../types/server.types';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddServer'>;
  route: RouteProp<RootStackParamList, 'AddServer'>;
};

export function AddServerScreen({ navigation, route }: Props) {
  const existing = (route.params as any)?.server as ServerProfile | undefined;
  const isEdit = !!existing;

  const { addServer, updateServer } = useServerStore();
  const [name, setName] = useState(existing?.name ?? '');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? 8767));
  const [password, setPassword] = useState('');
  const [avatar, setAvatar] = useState<string | undefined>(existing?.avatar);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const { rf, rs, ri, isExpanded } = useResponsive();

  const handlePickAvatar = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Berechtigung nötig', 'Erlaube Zugriff auf die Fotomediathek.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setAvatar(result.assets[0].uri);
  }, []);

  const handleTest = useCallback(async () => {
    if (!host) {
      Alert.alert('Fehler', 'Gib eine Host-Adresse ein');
      return;
    }
    setTesting(true);
    const r = await authService.testConnection(host, parseInt(port, 10));
    setTesting(false);
    if (r.ok) {
      Alert.alert('Verbunden', `Platform: ${r.platform}`);
    } else {
      Alert.alert('Verbindung fehlgeschlagen', r.error);
    }
  }, [host, port]);

  const handleSave = useCallback(async () => {
    if (!name || !host) {
      Alert.alert('Fehler', 'Name und Host sind Pflichtfelder');
      return;
    }
    if (!isEdit && !password) {
      Alert.alert('Fehler', 'Passwort ist erforderlich');
      return;
    }

    setLoading(true);
    try {
      const portNum = parseInt(port, 10);

      // Save avatar to local filesystem if it's a new pick (not already in avatars dir)
      let savedAvatar = avatar;
      const serverId = existing?.id ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      if (avatar && !avatar.includes('/avatars/')) {
        const dir = `${FileSystem.documentDirectory}avatars/`;
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        const dest = `${dir}${serverId}.jpg`;
        await FileSystem.copyAsync({ from: avatar, to: dest });
        savedAvatar = dest;
      }

      if (isEdit) {
        // Edit mode: update existing server
        const updates: Partial<ServerProfile> = { name, host, port: portNum, avatar: savedAvatar };
        if (password) {
          // Re-authenticate if password changed
          const token = await authService.login(host, portNum, password);
          updates.token = token;
        }
        await updateServer(existing!.id, updates);
      } else {
        // New server: authenticate and create
        const token = await authService.login(host, portNum, password);
        const server: ServerProfile = {
          id: serverId,
          name,
          host,
          port: portNum,
          token,
          createdAt: Date.now(),
          avatar: savedAvatar,
        };
        await addServer(server);
      }
      navigation.goBack();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Verbindung fehlgeschlagen';
      Alert.alert('Fehler', message);
    } finally {
      setLoading(false);
    }
  }, [name, host, port, password, avatar, isEdit, existing, addServer, updateServer, navigation]);

  const avatarSize = ri(80);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={[styles.scroll, {
        padding: rs(20),
        gap: rs(4),
        maxWidth: isExpanded ? 500 : undefined,
        alignSelf: isExpanded ? 'center' as const : undefined,
        width: isExpanded ? '100%' as unknown as number : undefined,
      }]}>
        {/* Avatar picker */}
        <TouchableOpacity
          style={[styles.avatarWrap, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2, alignSelf: 'center', marginBottom: rs(12) }]}
          onPress={handlePickAvatar}
          activeOpacity={0.7}
        >
          {avatar ? (
            <Image source={{ uri: avatar }} style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }} />
          ) : (
            <View style={[styles.avatarPlaceholder, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }]}>
              <Feather name="camera" size={ri(24)} color={colors.textDim} />
              <Text style={[styles.avatarHint, { fontSize: rf(10) }]}>Bild wählen</Text>
            </View>
          )}
          <View style={[styles.avatarBadge, { width: rs(28), height: rs(28), borderRadius: rs(14) }]}>
            <Feather name="edit-2" size={ri(12)} color={colors.text} />
          </View>
        </TouchableOpacity>

        <Text style={[styles.label, { fontSize: rf(14), marginTop: rs(12), marginBottom: rs(6) }]}>Name</Text>
        <TextInput
          style={[styles.input, { padding: rs(14), fontSize: rf(16) }]}
          value={name}
          onChangeText={setName}
          placeholder="My MacBook"
          placeholderTextColor={colors.textDim}
          autoCapitalize="words"
        />

        <Text style={[styles.label, { fontSize: rf(14), marginTop: rs(12), marginBottom: rs(6) }]}>Host</Text>
        <TextInput
          style={[styles.input, { padding: rs(14), fontSize: rf(16) }]}
          value={host}
          onChangeText={setHost}
          placeholder="192.168.1.100 or mypc.duckdns.org"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={[styles.label, { fontSize: rf(14), marginTop: rs(12), marginBottom: rs(6) }]}>Port</Text>
        <TextInput
          style={[styles.input, { padding: rs(14), fontSize: rf(16) }]}
          value={port}
          onChangeText={setPort}
          placeholder="8767"
          placeholderTextColor={colors.textDim}
          keyboardType="number-pad"
        />

        <Text style={[styles.label, { fontSize: rf(14), marginTop: rs(12), marginBottom: rs(6) }]}>
          Passwort{isEdit ? ' (leer lassen = unverändert)' : ''}
        </Text>
        <TextInput
          style={[styles.input, { padding: rs(14), fontSize: rf(16) }]}
          value={password}
          onChangeText={setPassword}
          placeholder={isEdit ? '••••••••' : 'Server Passwort'}
          placeholderTextColor={colors.textDim}
          secureTextEntry
        />

        <TouchableOpacity
          style={[styles.testButton, { marginTop: rs(20), padding: rs(14) }]}
          onPress={handleTest}
          disabled={testing}
        >
          {testing ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={[styles.testButtonText, { fontSize: rf(16) }]}>Verbindung testen</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.saveButton, { marginTop: rs(12), padding: rs(14) }]}
          onPress={handleSave}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.surface} />
          ) : (
            <Text style={[styles.saveButtonText, { fontSize: rf(16) }]}>
              {isEdit ? 'Speichern' : 'Verbinden & Speichern'}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {},
  avatarWrap: {
    position: 'relative',
  },
  avatarPlaceholder: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  avatarHint: {
    color: colors.textDim,
  },
  avatarBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  label: {
    color: colors.textMuted,
    fontWeight: '500',
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    fontFamily: fonts.mono,
  },
  testButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
  },
  testButtonText: {
    color: colors.primary,
    fontWeight: '600',
  },
  saveButton: {
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  saveButtonText: {
    color: colors.text,
    fontWeight: '600',
  },
});
