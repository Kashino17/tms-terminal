/**
 * Season 2 (Liquid Glass) root — registered as the `SeasonTwo` route and made
 * the initial route while `seasonTwoEnabled` is on. Classic screens stay
 * registered in the same stack, so dock bridges can `navigation.navigate`
 * into them until their Season-2 counterparts exist (M2+).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';
import { useSettingsStore } from '../store/settingsStore';
import { useTerminalStore } from '../store/terminalStore';
import {
  getCurrentLocation, fetchPrayerTimes, getNextPrayer, formatRemaining, PrayerTimes,
} from '../services/prayer.service';
import { S2ThemeProvider } from './theme/S2ThemeProvider';
import { useS2Theme } from './theme/tokens';
import { GlassSurface } from './components/GlassSurface';
import { Dock, DockItemKey } from './components/Dock';
import { DynamicIsland, IslandSessionRow } from './components/DynamicIsland';
import { TerminalsScreen, useS2Connection } from './screens/TerminalsScreen';
import { CloudScreen } from './screens/CloudScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'SeasonTwo'>;

export function SeasonTwoRoot(props: Props) {
  return (
    <S2ThemeProvider>
      <S2Shell {...props} />
    </S2ThemeProvider>
  );
}

const SESSION_COLORS = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599'];

function S2Shell({ navigation }: Props) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const insets = useSafeAreaInsets();
  const setSeasonTwoEnabled = useSettingsStore((s) => s.setSeasonTwoEnabled);
  const tabsByServer = useTerminalStore((s) => s.tabs);
  const conn = useS2Connection();
  // Internal season2 screens (native ones); everything else bridges to classic.
  const [screen, setScreen] = useState<'terminals' | 'cloud'>('terminals');

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  // Prayer countdown for the island — reuses the classic prayer.service
  // read-only. Times load once; the label re-derives every 30s.
  const [prayerLabel, setPrayerLabel] = useState<string | null>(null);
  const prayerTimings = useRef<PrayerTimes | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refreshLabel = () => {
      if (!prayerTimings.current) return;
      const next = getNextPrayer(prayerTimings.current);
      if (next && !cancelled) setPrayerLabel(`${next.name} · ${formatRemaining(next.remainingMs)}`);
    };
    (async () => {
      try {
        const loc = await getCurrentLocation();
        if (!loc || cancelled) return;
        const data = await fetchPrayerTimes(loc.latitude, loc.longitude);
        if (!data || cancelled) return;
        prayerTimings.current = data.timings;
        refreshLabel();
      } catch { /* prayer segment simply stays hidden */ }
    })();
    const t = setInterval(refreshLabel, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const islandSessions: IslandSessionRow[] = useMemo(() => {
    const rows: IslandSessionRow[] = [];
    Object.values(tabsByServer).forEach((tabs) => {
      tabs.forEach((t, i) => rows.push({
        id: t.id,
        title: t.title || 'Terminal',
        color: SESSION_COLORS[i % SESSION_COLORS.length],
        statusLabel: t.aiTool ? t.aiTool : 'Bereit',
      }));
    });
    return rows;
  }, [tabsByServer]);

  const handleDock = useCallback((key: DockItemKey) => {
    switch (key) {
      case 'terminals':
        setScreen('terminals');
        return;
      case 'server':
        navigation.navigate('ServerList');
        return;
      case 'cloud':
        setScreen('cloud');
        return;
      case 'mehr':
        navigation.navigate('Settings');
        return;
      case 'manager':
        if (conn.server && conn.wsService) {
          navigation.navigate('ManagerChat', {
            wsService: conn.wsService,
            serverId: conn.server.id,
            serverHost: conn.server.host,
            serverPort: conn.server.port,
            serverToken: conn.token ?? '',
          });
        } else {
          toast('Erst Server verbinden — dann öffnet der Manager');
        }
        return;
      case 'browser':
        toast('Browser kommt in Season 2 — Meilenstein 2');
        return;
    }
  }, [navigation, conn, toast]);

  const statusKind = conn.state === 'connected' ? 'ok' : conn.state === 'connecting' ? 'warn' : 'idle';
  const statusLabel =
    conn.state === 'connected' ? `Verbunden · ${conn.server?.name ?? ''}`
    : conn.state === 'connecting' ? 'Verbinde…'
    : 'Bereit';

  return (
    <View style={[styles.root, { backgroundColor: c.bgGradient[1] }]}>
      {/* Ambient background layers approximating the mockup's radial gradient. */}
      <View pointerEvents="none" style={[styles.bgTop, { backgroundColor: c.bgGradient[0] }]} />
      <View pointerEvents="none" style={[styles.bgBottom, { backgroundColor: c.bgGradient[2] }]} />

      {/* Reserved island zone — content below never sits under the island. */}
      <View style={{ paddingTop: insets.top + 8, zIndex: 10 }}>
        <DynamicIsland
          statusLabel={statusLabel}
          statusKind={statusKind}
          latencyMs={conn.rtt}
          prayerLabel={prayerLabel}
          sessions={islandSessions}
          onSessionPress={(id) => { setScreen('terminals'); conn.focusTab(id); }}
          onBackToClassic={() => setSeasonTwoEnabled(false)}
        />
      </View>

      <View style={styles.content}>
        {screen === 'terminals' ? (
          <TerminalsScreen navigation={navigation} toast={toast} />
        ) : (
          <CloudScreen toast={toast} onOpenClassicCloud={() => navigation.navigate('Settings')} />
        )}
      </View>

      <View style={[styles.dockZone, { paddingBottom: insets.bottom + 12 }]}>
        <Dock active={screen} onSelect={handleDock} />
      </View>

      {toastMsg != null && (
        <View pointerEvents="none" style={[styles.toastZone, { bottom: insets.bottom + m.dockHeight + 26 }]}>
          <GlassSurface strong radius={m.radius.pill}>
            <Text style={{ color: c.text, fontSize: m.font.caption, fontWeight: '600', paddingHorizontal: 18, paddingVertical: 10 }}>
              {toastMsg}
            </Text>
          </GlassSurface>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bgTop: {
    position: 'absolute', top: -160, left: -120,
    width: 480, height: 480, borderRadius: 240, opacity: 0.55,
  },
  bgBottom: {
    position: 'absolute', bottom: -180, right: -140,
    width: 520, height: 520, borderRadius: 260, opacity: 0.5,
  },
  content: { flex: 1, minHeight: 0 },
  dockZone: { alignItems: 'center' },
  toastZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
