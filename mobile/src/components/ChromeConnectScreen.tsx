import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useResponsive } from '../hooks/useResponsive';
import { useChromeRemoteStore } from '../store/chromeRemoteStore';

interface Props {
  serverId: string;
  onConnect: () => void;
}

export function ChromeConnectScreen({ serverId, onConnect }: Props) {
  const { rf, rs } = useResponsive();
  const status = useChromeRemoteStore(s => s.status[serverId] ?? 'disconnected');
  const error = useChromeRemoteStore(s => s.error[serverId]);
  const isConnecting = status === 'connecting';

  return (
    <View style={styles.container}>
      <Text style={[styles.icon, { fontSize: rf(48) }]}>{'\u{1F5A5}\uFE0F'}</Text>
      <Text style={[styles.title, { fontSize: rf(16) }]}>PC Chrome verbinden</Text>
      <Text style={[styles.subtitle, { fontSize: rf(13), marginHorizontal: rs(32) }]}>
        Steuere Google Chrome auf deinem PC direkt von hier aus.
      </Text>

      {error && (
        <View style={[styles.errorBox, { marginTop: rs(12), paddingHorizontal: rs(16), paddingVertical: rs(8) }]}>
          <Text style={[styles.errorText, { fontSize: rf(12) }]}>{error}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, { marginTop: rs(20), paddingHorizontal: rs(24), paddingVertical: rs(10) }]}
        onPress={onConnect}
        disabled={isConnecting}
      >
        {isConnecting ? (
          <ActivityIndicator size="small" color="#000" />
        ) : (
          <Text style={[styles.buttonText, { fontSize: rf(14) }]}>Verbinden</Text>
        )}
      </TouchableOpacity>

      <Text style={[styles.hint, { fontSize: rf(11), marginTop: rs(8) }]}>
        Chrome wird bei Bedarf automatisch gestartet
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a2e' },
  icon: { marginBottom: 12 },
  title: { color: '#e0e0e0', fontWeight: '500', marginBottom: 8 },
  subtitle: { color: '#778899', textAlign: 'center', lineHeight: 20 },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 8, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' },
  errorText: { color: '#ef4444' },
  button: { backgroundColor: '#4fc3f7', borderRadius: 8 },
  buttonText: { color: '#000', fontWeight: '600' },
  hint: { color: '#556677' },
});
