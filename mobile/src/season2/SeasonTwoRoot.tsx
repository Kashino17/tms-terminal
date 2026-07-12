/**
 * Season 2 (Liquid Glass) root — registered as the `SeasonTwo` route and made
 * the initial route while `seasonTwoEnabled` is on. Classic screens stay
 * registered in the same stack, so dock bridges can `navigation.navigate`
 * into them until their Season-2 counterparts exist (M2+).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';
import { useSettingsStore } from '../store/settingsStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAutoApproveStore } from '../store/autoApproveStore';
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
import { S2BrowserScreen } from './screens/S2BrowserScreen';
import { ManagerScreen } from './screens/ManagerScreen';
import { ServersScreen } from './screens/ServersScreen';
import { S2SettingsScreen } from './screens/S2SettingsScreen';
import { useManagerWire } from './manager/useManagerWire';
import { Spotlight, SpotlightEntry } from './components/Spotlight';
import { PromptSheet, PendingPrompt } from './components/PromptSheet';

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
  const { theme, toggleTheme } = useS2Theme();
  const { c, m } = theme;
  const insets = useSafeAreaInsets();
  const setSeasonTwoEnabled = useSettingsStore((s) => s.setSeasonTwoEnabled);
  const tabsByServer = useTerminalStore((s) => s.tabs);
  const conn = useS2Connection();
  // Internal season2 screens (native ones); everything else bridges to classic.
  const [screen, setScreen] = useState<'terminals' | 'cloud' | 'browser' | 'manager' | 'server' | 'mehr'>('terminals');
  // Manager responses must be processed even when the classic terminal screen
  // (which normally installs the persistent handler) has never been mounted.
  useManagerWire(conn.wsService);
  const [spotlightOpen, setSpotlightOpen] = useState(false);

  // ── GLOBAL prompt handling (M12 fix) ─────────────────────────────────────
  // This listener must live at the ROOT: the terminals screen unmounts when
  // the user visits Cloud/Manager/Browser, and auto-approve/permission
  // prompts must keep working there. The sheet itself only shows on the
  // terminals screen (user rule); elsewhere the dock badge signals pending.
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const autoTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    if (!conn.wsService || !conn.server) return;
    const serverId = conn.server.id;
    const ws = conn.wsService;
    const timers = autoTimers.current;
    const unsub = ws.addMessageListener((msg: any) => {
      if (msg?.type !== 'terminal:prompt_detected' || !msg.sessionId) return;
      const autoApprove = useAutoApproveStore.getState();
      const sid = msg.sessionId as string;
      const hasPendingInput = !!msg.payload?.hasPendingInput;
      if (autoApprove.isEnabled(sid) && !autoApprove.isRunning(sid) && !autoApprove.isTyping(sid) && !hasPendingInput) {
        autoApprove.setRunning(sid, true);
        ws.send({ type: 'terminal:input', sessionId: sid, payload: { data: '\r' } });
        const t = setTimeout(() => { autoApprove.setRunning(sid, false); timers.delete(t); }, 500);
        timers.add(t);
      } else if (!autoApprove.isEnabled(sid)) {
        useTerminalStore.getState().setTabNotification(serverId, sid);
        const tabsNow = useTerminalStore.getState().getTabs(serverId);
        const idx = tabsNow.findIndex((t) => t.sessionId === sid);
        if (idx >= 0) {
          setPendingPrompt({
            sessionId: sid,
            title: tabsNow[idx].title || 'Terminal',
            color: SESSION_COLORS[idx % SESSION_COLORS.length],
          });
        }
      }
    });
    return () => {
      unsub();
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [conn.wsService, conn.server]);

  const approvePrompt = useCallback(() => {
    if (!pendingPrompt || !conn.wsService || !conn.server) return;
    conn.wsService.send({ type: 'terminal:input', sessionId: pendingPrompt.sessionId, payload: { data: '\r' } });
    const tab = useTerminalStore.getState().getTabs(conn.server.id).find((t) => t.sessionId === pendingPrompt.sessionId);
    if (tab) useTerminalStore.getState().updateTab(conn.server.id, tab.id, { notificationCount: 0 });
    setPendingPrompt(null);
  }, [pendingPrompt, conn.wsService, conn.server]);

  const enableAutoForPrompt = useCallback(() => {
    if (!pendingPrompt) return;
    useAutoApproveStore.getState().setEnabled(pendingPrompt.sessionId, true);
    approvePrompt();
  }, [pendingPrompt, approvePrompt]);

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
        setScreen('server');
        return;
      case 'cloud':
        setScreen('cloud');
        return;
      case 'mehr':
        setScreen('mehr');
        return;
      case 'manager':
        if (conn.server && conn.wsService) {
          setScreen('manager');
        } else {
          toast('Erst Server verbinden — dann öffnet der Manager');
        }
        return;
      case 'browser':
        setScreen('browser');
        return;
    }
  }, [navigation, conn, toast]);

  const spotlightEntries: SpotlightEntry[] = useMemo(() => {
    const entries: SpotlightEntry[] = [];
    islandSessions.forEach((s) => entries.push({
      id: `s-${s.id}`, label: s.title, sub: s.statusLabel, kind: 'session', color: s.color,
      run: () => { setScreen('terminals'); conn.focusTab(s.id); },
    }));
    entries.push(
      { id: 'sc-terminals', label: 'Terminals', kind: 'screen', run: () => setScreen('terminals') },
      { id: 'sc-cloud', label: 'Cloud', kind: 'screen', run: () => setScreen('cloud') },
      { id: 'sc-browser', label: 'Browser', kind: 'screen', run: () => setScreen('browser') },
      { id: 'sc-manager', label: 'Manager', kind: 'screen', run: () => handleDock('manager') },
      { id: 'sc-server', label: 'Server', kind: 'screen', run: () => setScreen('server') },
      { id: 'sc-settings', label: 'Einstellungen', kind: 'screen', run: () => setScreen('mehr') },
      { id: 'ac-prayer', label: 'Gebetszeiten', kind: 'screen', run: () => navigation.navigate('PrayerTimes') },
      { id: 'ac-theme', label: 'Design wechseln (Hell/Dunkel)', kind: 'action', run: toggleTheme },
      { id: 'ac-classic', label: 'Zurück zu Klassisch', kind: 'action', run: () => setSeasonTwoEnabled(false) },
    );
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [islandSessions, navigation, conn]);

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
          onOpenSpotlight={() => setSpotlightOpen(true)}
        />
      </View>

      <Animated.View key={screen} entering={FadeIn.duration(200)} style={styles.content}>
        {screen === 'terminals' && <TerminalsScreen navigation={navigation} toast={toast} />}
        {screen === 'cloud' && <CloudScreen toast={toast} onOpenClassicCloud={() => navigation.navigate('Settings')} />}
        {screen === 'browser' && <S2BrowserScreen toast={toast} />}
        {screen === 'server' && (
          <ServersScreen navigation={navigation} toast={toast} onConnected={() => setScreen('terminals')} />
        )}
        {screen === 'mehr' && <S2SettingsScreen navigation={navigation} />}
        {screen === 'manager' && conn.server && conn.wsService && (
          <ManagerScreen
            navigation={navigation}
            wsService={conn.wsService}
            serverId={conn.server.id}
            serverHost={conn.server.host}
            serverPort={conn.server.port}
            serverToken={conn.token ?? ''}
            toast={toast}
          />
        )}
      </Animated.View>

      <View style={[styles.dockZone, { paddingBottom: insets.bottom + 12 }]}>
        <Dock
          active={screen}
          onSelect={handleDock}
          badges={{ terminals: !!pendingPrompt && screen !== 'terminals' }}
        />
      </View>

      {pendingPrompt && screen === 'terminals' && (
        <PromptSheet
          prompt={pendingPrompt}
          onApprove={approvePrompt}
          onDismiss={() => setPendingPrompt(null)}
          onEnableAuto={enableAutoForPrompt}
          bottomOffset={insets.bottom + m.dockHeight + 30}
        />
      )}

      {spotlightOpen && (
        <Spotlight entries={spotlightEntries} onClose={() => setSpotlightOpen(false)} />
      )}

      {toastMsg != null && (
        <Animated.View
          entering={FadeInDown.springify().damping(15)}
          exiting={FadeOut.duration(160)}
          pointerEvents="none"
          style={[styles.toastZone, { bottom: insets.bottom + m.dockHeight + 26 }]}
        >
          <GlassSurface strong radius={m.radius.pill}>
            <Text style={{ color: c.text, fontSize: m.font.caption, fontWeight: '600', paddingHorizontal: 18, paddingVertical: 10 }}>
              {toastMsg}
            </Text>
          </GlassSurface>
        </Animated.View>
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
