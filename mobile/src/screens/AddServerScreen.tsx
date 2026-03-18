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
} from 'react-native';
import { useServerStore } from '../store/serverStore';
import { authService } from '../services/auth.service';
import { ServerProfile } from '../types/server.types';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddServer'>;
};

export function AddServerScreen({ navigation }: Props) {
  const { addServer } = useServerStore();
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8767');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const { rf, rs, isExpanded } = useResponsive();

  const handleTest = useCallback(async () => {
    if (!host) {
      Alert.alert('Error', 'Enter a host address');
      return;
    }
    setTesting(true);
    const result = await authService.testConnection(host, parseInt(port, 10));
    setTesting(false);
    if (result.ok) {
      Alert.alert('Success', `Connected! Platform: ${result.platform}`);
    } else {
      Alert.alert('Connection Failed', result.error);
    }
  }, [host, port]);

  const handleSave = useCallback(async () => {
    if (!name || !host || !password) {
      Alert.alert('Error', 'All fields are required');
      return;
    }

    setLoading(true);
    try {
      const portNum = parseInt(port, 10);
      const token = await authService.login(host, portNum, password);

      const server: ServerProfile = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name,
        host,
        port: portNum,
        token,
        createdAt: Date.now(),
      };

      await addServer(server);
      navigation.goBack();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  }, [name, host, port, password, addServer, navigation]);

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

        <Text style={[styles.label, { fontSize: rf(14), marginTop: rs(12), marginBottom: rs(6) }]}>Password</Text>
        <TextInput
          style={[styles.input, { padding: rs(14), fontSize: rf(16) }]}
          value={password}
          onChangeText={setPassword}
          placeholder="Server password"
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
            <Text style={[styles.testButtonText, { fontSize: rf(16) }]}>Test Connection</Text>
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
            <Text style={[styles.saveButtonText, { fontSize: rf(16) }]}>Connect & Save</Text>
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
