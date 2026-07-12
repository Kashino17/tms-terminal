/**
 * Season 2 Server — native glass server list: saved profiles as cards,
 * connect/switch directly, active server highlighted with live state,
 * add/edit bridges to the classic AddServer sheet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types/navigation.types';
import { getConnection } from '../../services/websocket.service';
import { storageService, getToken } from '../../services/storage.service';
import { GlassSurface } from '../components/GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { useS2Connection, useS2ConnStore, S2Server } from './TerminalsScreen';
import { IconServer, IconPlus, IconDot, IconChevronRight } from '../icons';

interface ServersScreenProps {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonTwo'>;
  toast: (msg: string) => void;
  onConnected: () => void;
}

export function ServersScreen({ navigation, toast, onConnected }: ServersScreenProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const conn = useS2Connection();
  const setServer = useS2ConnStore((s) => s.setServer);
  const [servers, setServers] = useState<S2Server[]>([]);

  const load = useCallback(() => {
    storageService.getServers().then((list: any[]) => {
      setServers(list.map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port, token: s.token })));
    }).catch(() => setServers([]));
  }, []);
  useEffect(load, [load]);

  const connectTo = useCallback(async (server: S2Server) => {
    if (conn.server?.id === server.id && conn.state === 'connected') {
      toast('Bereits verbunden');
      onConnected();
      return;
    }
    try {
      const token = server.token ?? (await getToken(server.id));
      if (!token) { toast('Kein Token für diesen Server gespeichert'); return; }
      const ws = getConnection(server.id);
      ws.connect({ host: server.host, port: server.port, token });
      setServer(server, token);
      toast(`Verbinde mit ${server.name}…`);
      onConnected();
    } catch {
      toast('Verbindung fehlgeschlagen');
    }
  }, [conn.server, conn.state, setServer, toast, onConnected]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headRow}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Server</Text>
        <Pressable
          onPress={() => navigation.navigate('AddServer', undefined)}
          accessibilityLabel="Server hinzufügen"
          style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
        >
          <IconPlus size={m.icon.md} color={c.text} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: m.dockHeight + 40 }}>
        {servers.map((s) => {
          const isActive = conn.server?.id === s.id;
          const stateLabel = isActive
            ? conn.state === 'connected' ? `Verbunden${conn.rtt != null ? ` · ${conn.rtt} ms` : ''}`
            : conn.state === 'connecting' ? 'Verbinde…' : 'Getrennt'
            : ' ';
          return (
            <Pressable key={s.id} onPress={() => connectTo(s)} style={({ pressed }) => [pressed && styles.pressed]}>
              <GlassSurface strong={isActive} style={{ marginBottom: 12, padding: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <IconServer size={m.icon.lg} color={isActive ? c.accent : c.textDim} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.section, fontWeight: '700' }}>{s.name}</Text>
                    <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.caption, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>
                      {s.host}:{s.port}
                    </Text>
                    {isActive && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <IconDot size={8} color={conn.state === 'connected' ? c.ok : c.warn} />
                        <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '600' }}>{stateLabel}</Text>
                      </View>
                    )}
                  </View>
                  <IconChevronRight size={m.icon.sm} color={c.textDim} />
                </View>
              </GlassSurface>
            </Pressable>
          );
        })}
        {servers.length === 0 && (
          <Pressable onPress={() => navigation.navigate('AddServer', undefined)}>
            <GlassSurface style={{ padding: 18 }}>
              <Text style={{ color: c.textDim, fontSize: m.font.body, textAlign: 'center' }}>
                Kein Server gespeichert — hier hinzufügen
              </Text>
            </GlassSurface>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pageTitle: { fontWeight: '800', letterSpacing: 0.2 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  headBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 14 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
