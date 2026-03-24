import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as WebBrowser from 'expo-web-browser';
import { useResponsive } from '../hooks/useResponsive';
import { useCloudAuthStore } from '../store/cloudAuthStore';
import { createRenderService } from '../services/render.service';
import { createVercelService } from '../services/vercel.service';
import { colors } from '../theme';

interface Props {
  platform: 'render' | 'vercel';
  onConnected: () => void;
}

const PLATFORM_CONFIG = {
  render: {
    name: 'Render',
    icon: 'box' as const,
    color: '#4353FF',
    tokenUrl: 'https://dashboard.render.com/settings#api-keys',
  },
  vercel: {
    name: 'Vercel',
    icon: 'triangle' as const,
    color: '#FFFFFF',
    tokenUrl: 'https://vercel.com/account/tokens',
  },
};

export function CloudSetup({ platform, onConnected }: Props) {
  const { rf, rs, ri } = useResponsive();
  const setToken = useCloudAuthStore((s) => s.setToken);
  const config = PLATFORM_CONFIG[platform];

  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const service = platform === 'render'
        ? createRenderService(tokenInput.trim())
        : createVercelService(tokenInput.trim());
      const valid = await service.validateToken(tokenInput.trim());
      if (valid) {
        setToken(platform, tokenInput.trim());
        onConnected();
      } else {
        setError('Ungültiger Token — bitte überprüfen');
      }
    } catch {
      setError('Verbindung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }, [tokenInput, platform, setToken, onConnected]);

  return (
    <View style={[s.container, { padding: rs(16) }]}>
      <Feather name={config.icon} size={ri(32)} color={config.color} style={{ alignSelf: 'center', marginBottom: rs(16) }} />
      <Text style={[s.title, { fontSize: rf(15) }]}>API Token für {config.name}</Text>
      <Text style={[s.subtitle, { fontSize: rf(12), marginBottom: rs(16) }]}>
        Erstelle einen API Token in deinem {config.name} Account:
      </Text>
      <TouchableOpacity
        onPress={() => WebBrowser.openBrowserAsync(config.tokenUrl)}
        style={[s.linkBtn, { marginBottom: rs(16), paddingVertical: rs(10) }]}
      >
        <Feather name="external-link" size={ri(14)} color={colors.primary} />
        <Text style={[s.linkText, { fontSize: rf(13) }]}>Token-Seite öffnen</Text>
      </TouchableOpacity>
      <TextInput
        style={[s.input, { fontSize: rf(13), padding: rs(10) }]}
        placeholder="Token einfügen..."
        placeholderTextColor={colors.textDim}
        value={tokenInput}
        onChangeText={setTokenInput}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error && <Text style={[s.error, { fontSize: rf(11) }]}>{error}</Text>}
      <TouchableOpacity
        style={[s.connectBtn, { marginTop: rs(12), paddingVertical: rs(12) }]}
        onPress={handleConnect}
        disabled={loading || !tokenInput.trim()}
      >
        {loading ? (
          <ActivityIndicator color={colors.text} size="small" />
        ) : (
          <Text style={[s.connectText, { fontSize: rf(14) }]}>Verbinden</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  subtitle: { color: colors.textMuted, textAlign: 'center' },
  linkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  linkText: { color: colors.primary, fontWeight: '600' },
  input: { backgroundColor: colors.surfaceAlt, color: colors.text, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  error: { color: colors.destructive, marginTop: 6 },
  connectBtn: { backgroundColor: colors.primary, borderRadius: 8, alignItems: 'center' },
  connectText: { color: colors.text, fontWeight: '700' },
});
