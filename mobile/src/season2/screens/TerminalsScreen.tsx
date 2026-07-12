/**
 * Season 2 Terminals — M2: connect to a real server, work with real PTY
 * sessions in TWO views (Liste = accordion cards, Stack = one full-height
 * card with a session chip strip), ⊞ strict 2-column overview, quick keys
 * sending real control bytes, per-terminal Auto-Approve wired to the real
 * `terminal:prompt_detected` detection (glass sheet when Auto is off),
 * rename via TRIPLE-tap, command input row. Reuses the classic data layer
 * 1:1: getConnection()/terminalStore/TerminalView/autoApproveStore.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform,
  LayoutAnimation, UIManager,
} from 'react-native';

// Accordion + view switches animate via LayoutAnimation (opt-in on Android).
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import type { LayoutAnimationConfig } from 'react-native';
const SPRING_LAYOUT: LayoutAnimationConfig = {
  duration: 280,
  create: { type: 'easeOut' as const, property: 'opacity' as const },
  update: { type: 'spring' as const, springDamping: 0.85 },
  delete: { type: 'easeOut' as const, property: 'opacity' as const },
};
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types/navigation.types';
import { useResponsive } from '../../hooks/useResponsive';
import { getConnection, WebSocketService } from '../../services/websocket.service';
import type { ConnectionState } from '../../types/websocket.types';
import { storageService, getToken } from '../../services/storage.service';
import { useTerminalStore } from '../../store/terminalStore';
import { useAutoApproveStore } from '../../store/autoApproveStore';
import type { TerminalTab } from '../../types/terminal.types';
import { TerminalView, TerminalViewRef } from '../../components/TerminalView';
import { GlassSurface } from '../components/GlassSurface';
import { useUiPrefsStore } from '../store/uiPrefsStore';
import type { ContextAction } from '../components/BottomBar';
import { OverviewGrid } from '../components/OverviewGrid';
import { NotesSheet } from '../components/NotesSheet';
import { useDictation } from '../hooks/useDictation';
import { useS2Theme } from '../theme/tokens';
import {
  IconPlus, IconTrash, IconSend, IconMic, IconChevronDown, IconChevronRight, IconServer, IconDot,
  IconList, IconStack, IconGrid, IconBolt, IconNotes, IconArrowDownCircle, IconClose, IconChevronUp,
  IconMaximize, IconMinimize,
} from '../icons';

// ── Season-2 connection state (module store — survives screen remounts) ──

export interface S2Server { id: string; name: string; host: string; port: number; token?: string | null }

interface S2ConnState {
  server: S2Server | null;
  token: string | null;
  focusTabId: string | null;
  setServer: (server: S2Server | null, token: string | null) => void;
  setFocusTab: (id: string | null) => void;
}

export const useS2ConnStore = create<S2ConnState>((set) => ({
  server: null,
  token: null,
  focusTabId: null,
  setServer: (server, token) => set({ server, token }),
  setFocusTab: (focusTabId) => set({ focusTabId }),
}));

/** Live view over the season-2 connection: polls state/RTT (no handler theft
 *  from the classic screens — they use setStateHandler exclusively). */
export function useS2Connection() {
  const { server, token, focusTabId, setFocusTab } = useS2ConnStore();
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [rtt, setRtt] = useState<number | null>(null);
  const wsService = useMemo(() => (server ? getConnection(server.id) : null), [server]);

  useEffect(() => {
    if (!wsService) { setState('disconnected'); setRtt(null); return; }
    const tick = () => {
      setState(wsService.state);
      const r = wsService.getRtt?.();
      setRtt(typeof r === 'number' && r > 0 ? Math.round(r) : null);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [wsService]);

  return { server, token, wsService, state, rtt, focusTabId, focusTab: setFocusTab };
}

// ── Screen ──

interface TerminalsScreenProps {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonTwo'>;
  toast: (msg: string) => void;
  /** Publishes terminal tools to the context bottom bar (dual-mode bar). */
  onContextActions?: (actions: ContextAction[]) => void;
}

// Muted, professional palette: enough hue separation to tell sessions apart,
// low enough saturation to never pull the eye away from the terminal output.
const SESSION_COLORS = ['#6f8fb0', '#7fa088', '#b09a70', '#9a8bb0', '#b08585', '#7fa5a8'];
const VIEW_KEY = 'tms-s2-terminal-view';
type S2View = 'list' | 'stack';

export function TerminalsScreen({ navigation, toast, onContextActions }: TerminalsScreenProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const { isExpanded } = useResponsive();
  const conn = useS2Connection();
  const setServer = useS2ConnStore((s) => s.setServer);
  const tabs = useTerminalStore((s) => (conn.server ? s.tabs[conn.server.id] ?? [] : []));
  const [servers, setServers] = useState<S2Server[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<S2View>('list');
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [notesFor, setNotesFor] = useState<{ tabId: string; title: string; color: string } | null>(null);
  const pagerRef = useRef<ScrollView>(null);
  const [pageW, setPageW] = useState(0);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const swipeStart = useRef<number | null>(null);

  // Load persisted view preference once.
  useEffect(() => {
    AsyncStorage.getItem(VIEW_KEY).then((v) => {
      if (v === 'list' || v === 'stack') setView(v);
    }).catch(() => {});
  }, []);
  const switchView = useCallback((v: S2View) => {
    LayoutAnimation.configureNext(SPRING_LAYOUT);
    setView(v);
    AsyncStorage.setItem(VIEW_KEY, v).catch(() => {});
  }, []);

  // Server list for the picker (when nothing is connected yet).
  useEffect(() => {
    if (conn.server) return;
    storageService.getServers().then((list: any[]) => {
      setServers(list.map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port, token: s.token })));
    }).catch(() => setServers([]));
  }, [conn.server]);

  // Follow island session taps.
  useEffect(() => {
    if (conn.focusTabId) {
      setExpandedId(conn.focusTabId);
      setOverviewOpen(false);
      conn.focusTab(null);
    }
  }, [conn.focusTabId, conn]);

  // Reattach persisted sessions once per connection — without this, tabs
  // restored from storage after an app restart would sit on dead sessionIds
  // (the classic screen does this in its connState effect; season2 mirrors it).
  const reattachedRef = useRef(false);
  useEffect(() => {
    if (conn.state !== 'connected') { reattachedRef.current = false; return; }
    if (reattachedRef.current || !conn.wsService || !conn.server) return;
    reattachedRef.current = true;
    const ws = conn.wsService;
    const dims = { cols: 100, rows: 32 };
    useTerminalStore.getState().getTabs(conn.server.id).forEach((tab) => {
      if (tab.sessionId) ws.send({ type: 'terminal:reattach', sessionId: tab.sessionId, payload: dims });
    });
  }, [conn.state, conn.wsService, conn.server]);

  // Server messages: assign sessionIds to pending tabs, drop closed sessions,
  // and mirror the classic auto-approve contract for detected prompts.
  useEffect(() => {
    if (!conn.wsService || !conn.server) return;
    const serverId = conn.server.id;
    const ws = conn.wsService;
    const unsub = ws.addMessageListener((msg: any) => {
      if (msg?.type === 'terminal:created' && msg.sessionId) {
        const pending = useTerminalStore.getState().getTabs(serverId).find((t) => !t.sessionId);
        if (pending) useTerminalStore.getState().updateTab(serverId, pending.id, { sessionId: msg.sessionId });
      } else if (msg?.type === 'terminal:reattached' && msg.sessionId) {
        const tab = useTerminalStore.getState().getTabs(serverId).find((t) => t.sessionId === msg.sessionId);
        if (tab) {
          const updates: Record<string, string> = {};
          if (msg.payload?.cwd) updates.lastCwd = msg.payload.cwd;
          if (msg.payload?.processName) updates.lastProcess = msg.payload.processName;
          if (Object.keys(updates).length > 0) useTerminalStore.getState().updateTab(serverId, tab.id, updates);
        }
      } else if (msg?.type === 'terminal:closed' && msg.sessionId) {
        const gone = useTerminalStore.getState().getTabs(serverId).find((t) => t.sessionId === msg.sessionId);
        if (gone) useTerminalStore.getState().removeTab(serverId, gone.id);
      }
      // NOTE: terminal:prompt_detected is handled GLOBALLY in SeasonTwoRoot
      // (M12) — it must keep working while this screen is unmounted.
    });
    return unsub;
  }, [conn.wsService, conn.server]);

  const connectTo = useCallback(async (server: S2Server) => {
    try {
      const token = server.token ?? (await getToken(server.id));
      if (!token) { toast('Kein Token für diesen Server gespeichert'); return; }
      const ws = getConnection(server.id);
      ws.connect({ host: server.host, port: server.port, token });
      setServer(server, token);
      toast(`Verbinde mit ${server.name}…`);
    } catch (e) {
      toast('Verbindung fehlgeschlagen');
    }
  }, [setServer, toast]);

  const createTerminal = useCallback(() => {
    if (!conn.wsService || !conn.server) return;
    const serverId = conn.server.id;
    const count = useTerminalStore.getState().getTabs(serverId).length;
    const tab: TerminalTab = {
      id: `s2-${Date.now()}-${count}`,
      title: `Terminal ${count + 1}`,
      serverId,
      active: false,
    };
    useTerminalStore.getState().addTab(serverId, tab);
    conn.wsService.send({ type: 'terminal:create', payload: { cols: 100, rows: 32 } });
    setExpandedId(tab.id);
  }, [conn.wsService, conn.server]);

  const closeTerminal = useCallback((tab: TerminalTab) => {
    if (!conn.server) return;
    if (tab.sessionId && conn.wsService) {
      conn.wsService.send({ type: 'terminal:close', sessionId: tab.sessionId });
    }
    useTerminalStore.getState().removeTab(conn.server.id, tab.id);
  }, [conn.wsService, conn.server]);

  // ── Not connected: server picker ──
  if (!conn.server) {
    return (
      <ScrollView contentContainerStyle={styles.pickerWrap}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Terminals</Text>
        <Text style={{ color: c.textDim, fontSize: m.font.body, marginBottom: 18 }}>
          Verbinde einen Server, um loszulegen.
        </Text>
        {servers.map((s) => (
          <Pressable key={s.id} onPress={() => connectTo(s)} style={({ pressed }) => [pressed && styles.pressed]}>
            <GlassSurface style={styles.serverCard}>
              <View style={styles.serverRow}>
                <IconServer size={m.icon.lg} color={c.accent} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.section, fontWeight: '700' }}>{s.name}</Text>
                  <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.caption, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>
                    {s.host}:{s.port}
                  </Text>
                </View>
                <IconChevronRight size={m.icon.sm} color={c.textDim} />
              </View>
            </GlassSurface>
          </Pressable>
        ))}
        {servers.length === 0 && (
          <Pressable onPress={() => navigation.navigate('ServerList')}>
            <GlassSurface style={styles.serverCard}>
              <Text style={{ color: c.textDim, fontSize: m.font.body, textAlign: 'center', paddingVertical: 8 }}>
                Keine Server gespeichert — hier hinzufügen
              </Text>
            </GlassSurface>
          </Pressable>
        )}
      </ScrollView>
    );
  }

  // Stack view / Fold layout keep exactly one session in focus.
  const stackTab = tabs.find((t) => t.id === expandedId) ?? tabs[0] ?? null;
  // List view: the opened terminal (if any) renders outside the scroll strip.
  const listTab = tabs.find((t) => t.id === expandedId) ?? null;

  // Publish the active terminal's tools into the context bottom bar.
  const activeForBar = view === 'list'
    ? (tabs.find((t) => t.id === expandedId) ?? null)
    : stackTab;
  const activeSidForBar = activeForBar?.sessionId;
  useEffect(() => {
    if (!onContextActions) return;
    if (!activeSidForBar || !conn.wsService) { onContextActions([]); return; }
    const ws = conn.wsService;
    const key = (data: string) => ws.send({ type: 'terminal:input', sessionId: activeSidForBar, payload: { data } });
    onContextActions([
      { id: 'k-ctrlc', label: '^C', icon: IconBolt, onPress: () => key('\x03') },
      { id: 'k-esc', label: 'Esc', icon: IconClose, onPress: () => key('\x1b') },
      { id: 'k-tab', label: 'Tab', icon: IconChevronRight, onPress: () => key('\t') },
      { id: 'k-up', label: '↑', icon: IconChevronUp, onPress: () => key('\x1b[A') },
      { id: 'k-down', label: '↓', icon: IconChevronDown, onPress: () => key('\x1b[B') },
      { id: 'k-clear', label: 'Leeren', icon: IconTrash, onPress: () => key('\x0c') },
      { id: 'k-new', label: 'Neu', icon: IconPlus, onPress: createTerminal },
      { id: 'k-grid', label: 'Übersicht', icon: IconGrid, onPress: () => setOverviewOpen(true) },
    ]);
    return () => onContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSidForBar, conn.wsService, onContextActions]);

  // ── Fold-7 unfolded (≥700dp): ops-center layout — session rail left,
  //    active terminal full-height right (the mockup's expanded mode). ──
  if (isExpanded) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.headRow}>
          <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Terminals</Text>
          <View style={styles.headActions}>
            <Pressable
              onPress={() => setOverviewOpen(true)}
              accessibilityLabel="Übersicht"
              style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
            >
              <IconGrid size={m.icon.md} color={c.text} />
            </Pressable>
            <Pressable
              onPress={createTerminal}
              accessibilityLabel="Neues Terminal"
              style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
            >
              <IconPlus size={m.icon.md} color={c.text} />
            </Pressable>
          </View>
        </View>
        <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', paddingHorizontal: 16, gap: 12, paddingBottom: m.dockHeight + 34 }}>
          <ScrollView style={{ width: 280, flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
            {tabs.map((tab, i) => {
              const isActive = stackTab?.id === tab.id;
              return (
                <Pressable key={tab.id} onPress={() => setExpandedId(tab.id)} style={({ pressed }) => [pressed && styles.pressed]}>
                  <GlassSurface strong={isActive} style={{ padding: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={[styles.colorTag, { backgroundColor: SESSION_COLORS[i % SESSION_COLORS.length] }]} />
                      <Text numberOfLines={1} style={{ flex: 1, color: isActive ? c.text : c.textDim, fontSize: m.font.label, fontWeight: '700' }}>
                        {tab.title || 'Terminal'}
                      </Text>
                      {!!tab.notificationCount && <View style={[styles.badge, { backgroundColor: c.warn }]} />}
                      <IconDot size={8} color={tab.sessionId ? c.ok : c.warn} />
                    </View>
                    {!!tab.lastCwd && (
                      <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 4 }}>
                        {tab.lastCwd}
                      </Text>
                    )}
                  </GlassSurface>
                </Pressable>
              );
            })}
            <Pressable onPress={createTerminal} style={({ pressed }) => [pressed && styles.pressed]}>
              <GlassSurface radius={m.radius.pill}>
                <View style={styles.addRow}>
                  <IconPlus size={m.icon.sm} color={c.accent} />
                  <Text style={{ color: c.accent, fontSize: m.font.caption, fontWeight: '700' }}>Neues Terminal</Text>
                </View>
              </GlassSurface>
            </Pressable>
          </ScrollView>
          <View style={{ flex: 1, minHeight: 0 }}>
            {stackTab ? (
              <SessionCard
                key={stackTab.id}
                tab={stackTab}
                color={SESSION_COLORS[Math.max(0, tabs.findIndex((t) => t.id === stackTab.id)) % SESSION_COLORS.length]}
                expanded
                full
                onToggle={() => {}}
                onClose={() => closeTerminal(stackTab)}
                onNotes={(color) => setNotesFor({ tabId: stackTab.id, title: stackTab.title, color })}
                wsService={conn.wsService!}
                serverId={conn.server!.id}
                toast={toast}
              />
            ) : (
              <GlassSurface style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: c.textDim, fontSize: m.font.body }}>Kein Terminal — links „Neues Terminal"</Text>
              </GlassSurface>
            )}
          </View>
        </View>
        {overviewOpen && (
          <OverviewGrid
            tabs={tabs}
            colors={SESSION_COLORS}
            onSelect={(tabId) => { setExpandedId(tabId); setOverviewOpen(false); }}
            onClose={() => setOverviewOpen(false)}
          />
        )}
        {notesFor && (
          <NotesSheet
            tabId={notesFor.tabId}
            title={notesFor.title}
            color={notesFor.color}
            onClose={() => setNotesFor(null)}
          />
        )}
      </KeyboardAvoidingView>
    );
  }

  // ── Connected ──
  // ── Fullscreen terminal (user: "Terminal toggle fehlt") ──
  const fsTab = fullscreenId ? tabs.find((t) => t.id === fullscreenId) ?? null : null;
  if (fsTab) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 6, paddingBottom: m.dockHeight + 20 }}>
          <SessionCard
            key={fsTab.id}
            tab={fsTab}
            color={SESSION_COLORS[Math.max(0, tabs.findIndex((t) => t.id === fsTab.id)) % SESSION_COLORS.length]}
            expanded
            full
            fullscreen
            onToggleFullscreen={() => setFullscreenId(null)}
            onToggle={() => {}}
            onClose={() => { setFullscreenId(null); closeTerminal(fsTab); }}
            onNotes={(color) => setNotesFor({ tabId: fsTab.id, title: fsTab.title, color })}
            wsService={conn.wsService!}
            serverId={conn.server!.id}
            toast={toast}
          />
        </View>
        {notesFor && (
          <NotesSheet
            tabId={notesFor.tabId}
            title={notesFor.title}
            color={notesFor.color}
            onClose={() => setNotesFor(null)}
          />
        )}
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.headRow}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Terminals</Text>
        <View style={styles.headActions}>
          <View style={[styles.viewToggle, { borderColor: c.glassBorder }]}>
            {(['stack', 'list'] as S2View[]).map((v) => (
              <Pressable
                key={v}
                onPress={() => switchView(v)}
                accessibilityState={{ selected: view === v }}
                style={[styles.viewToggleBtn, view === v && { backgroundColor: `rgba(${c.accentRgb},0.16)` }]}
              >
                {v === 'stack'
                  ? <IconStack size={m.icon.sm} color={view === v ? c.text : c.textDim} />
                  : <IconList size={m.icon.sm} color={view === v ? c.text : c.textDim} />}
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={() => setOverviewOpen(true)}
            accessibilityLabel="Übersicht"
            style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
          >
            <IconGrid size={m.icon.md} color={c.text} />
          </Pressable>
          <Pressable
            onPress={createTerminal}
            accessibilityLabel="Neues Terminal"
            style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
          >
            <IconPlus size={m.icon.md} color={c.text} />
          </Pressable>
        </View>
      </View>

      {view === 'stack' && tabs.length > 0 ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          {/* Horizontal pager — swipe between terminals like iPhone home screens. */}
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, pageW));
              const tab = tabs[Math.min(Math.max(idx, 0), tabs.length - 1)];
              if (tab && tab.id !== expandedId) setExpandedId(tab.id);
            }}
            onLayout={(e) => setPageW(e.nativeEvent.layout.width)}
            style={{ flex: 1 }}
            contentContainerStyle={{ height: '100%' }}
          >
            {tabs.map((tab, i) => (
              <View key={tab.id} style={{ width: pageW || undefined, height: '100%', paddingHorizontal: 10 }}>
                <SessionCard
                  tab={tab}
                  color={SESSION_COLORS[i % SESSION_COLORS.length]}
                  expanded
                  full
                  onToggleFullscreen={() => setFullscreenId(tab.id)}
                  onToggle={() => {}}
                  onClose={() => closeTerminal(tab)}
                  onNotes={(color) => setNotesFor({ tabId: tab.id, title: tab.title, color })}
                  wsService={conn.wsService!}
                  serverId={conn.server!.id}
                  toast={toast}
                />
              </View>
            ))}
          </ScrollView>
          {/* Page dots — the home-screen style navigator. */}
          <View style={[styles.dots, { paddingBottom: m.dockHeight + 18 }]}>
            {tabs.map((tab, i) => {
              const isActive = stackTab?.id === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => {
                    setExpandedId(tab.id);
                    pagerRef.current?.scrollTo({ x: i * pageW, animated: true });
                  }}
                  hitSlop={8}
                  accessibilityLabel={tab.title || 'Terminal'}
                >
                  <View
                    style={[
                      styles.dot,
                      {
                        backgroundColor: isActive ? SESSION_COLORS[i % SESSION_COLORS.length] : c.textDim,
                        opacity: isActive ? 1 : 0.35,
                        width: isActive ? 22 : 7,
                      },
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, minHeight: 0 }}>
          {/* Collapsed rows scroll in a compact strip … */}
          <ScrollView
            style={{ flexGrow: 0, maxHeight: listTab ? 190 : undefined }}
            contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 6 }}
            keyboardShouldPersistTaps="handled"
          >
            {tabs.filter((t) => t.id !== expandedId).map((tab) => {
              const i = tabs.findIndex((t) => t.id === tab.id);
              const color = SESSION_COLORS[i % SESSION_COLORS.length];
              const revealed = swipedId === tab.id;
              return (
                <View key={tab.id} style={{ flexDirection: 'row', alignItems: 'stretch' }}>
                  <View
                    style={{ flex: 1 }}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={(e) => Math.abs(e.nativeEvent.locationX) > 0}
                    onResponderGrant={(e) => { swipeStart.current = e.nativeEvent.pageX; }}
                    onResponderRelease={(e) => {
                      const dx = e.nativeEvent.pageX - (swipeStart.current ?? e.nativeEvent.pageX);
                      swipeStart.current = null;
                      if (dx < -48) { LayoutAnimation.configureNext(SPRING_LAYOUT); setSwipedId(tab.id); }
                      else if (dx > 48) { LayoutAnimation.configureNext(SPRING_LAYOUT); setSwipedId(null); }
                    }}
                  >
                    <SessionCard
                      tab={tab}
                      color={color}
                      expanded={false}
                      onToggle={() => {
                        if (revealed) { LayoutAnimation.configureNext(SPRING_LAYOUT); setSwipedId(null); return; }
                        LayoutAnimation.configureNext(SPRING_LAYOUT);
                        setExpandedId(tab.id);
                      }}
                      onClose={() => closeTerminal(tab)}
                      onNotes={(col) => setNotesFor({ tabId: tab.id, title: tab.title, color: col })}
                      wsService={conn.wsService!}
                      serverId={conn.server!.id}
                      toast={toast}
                    />
                  </View>
                  {revealed && (
                    <View style={styles.swipeRail}>
                      <Pressable
                        onPress={() => { setSwipedId(null); setFullscreenId(tab.id); }}
                        accessibilityLabel="Vollbild"
                        style={({ pressed }) => [styles.railBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
                      >
                        <IconMaximize size={m.icon.sm} color={c.text} />
                      </Pressable>
                      <Pressable
                        onPress={() => { setSwipedId(null); setNotesFor({ tabId: tab.id, title: tab.title, color }); }}
                        accessibilityLabel="Notizen"
                        style={({ pressed }) => [styles.railBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
                      >
                        <IconNotes size={m.icon.sm} color={c.text} />
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            })}
            <Pressable onPress={createTerminal} style={({ pressed }) => [pressed && styles.pressed]}>
              <GlassSurface radius={m.radius.pill} style={{ marginTop: 2, marginBottom: 6 }}>
                <View style={styles.addRow}>
                  <IconPlus size={m.icon.sm} color={c.accent} />
                  <Text style={{ color: c.accent, fontSize: m.font.body, fontWeight: '700' }}>Neues Terminal</Text>
                </View>
              </GlassSurface>
            </Pressable>
          </ScrollView>

          {/* … while the open terminal owns the rest of the screen (its WebView
              keeps its own vertical gestures — no parent ScrollView stealing). */}
          {listTab && (
            <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 10, paddingBottom: m.dockHeight + 26 }}>
              <SessionCard
                key={listTab.id}
                tab={listTab}
                color={SESSION_COLORS[Math.max(0, tabs.findIndex((t) => t.id === listTab.id)) % SESSION_COLORS.length]}
                expanded
                full
                onToggleFullscreen={() => setFullscreenId(listTab.id)}
                onToggle={() => {
                  LayoutAnimation.configureNext(SPRING_LAYOUT);
                  setExpandedId(null);
                }}
                onClose={() => closeTerminal(listTab)}
                onNotes={(color) => setNotesFor({ tabId: listTab.id, title: listTab.title, color })}
                wsService={conn.wsService!}
                serverId={conn.server!.id}
                toast={toast}
              />
            </View>
          )}
        </View>
      )}

      {overviewOpen && (
        <OverviewGrid
          tabs={tabs}
          colors={SESSION_COLORS}
          onSelect={(tabId) => { setExpandedId(tabId); setOverviewOpen(false); }}
          onClose={() => setOverviewOpen(false)}
        />
      )}

      {notesFor && (
        <NotesSheet
          tabId={notesFor.tabId}
          title={notesFor.title}
          color={notesFor.color}
          onClose={() => setNotesFor(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

// ── Session card (accordion item / stack focus card) ──

interface SessionCardProps {
  tab: TerminalTab;
  color: string;
  expanded: boolean;
  /** Stack mode: fill available height instead of the fixed list height. */
  full?: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNotes: (color: string) => void;
  /** Terminal-only fullscreen toggle (user: "Terminal toggle fehlt"). */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  wsService: WebSocketService;
  serverId: string;
  toast: (msg: string) => void;
}

function SessionCard({ tab, color, expanded, full = false, onToggle, onClose, onNotes, fullscreen = false, onToggleFullscreen, wsService, serverId, toast }: SessionCardProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const [cmd, setCmd] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const tapCount = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const termRef = useRef<TerminalViewRef>(null);
  const autoOn = useAutoApproveStore((s) => (tab.sessionId ? s.isEnabled(tab.sessionId) : false));
  const terminalFontSize = useUiPrefsStore((s) => s.terminalFontSize);
  // Real dictation via the server's Whisper pipeline — transcript lands in
  // the command input, ready to edit and send.
  const { micState, toggle: toggleMic } = useDictation({
    wsService,
    sessionId: tab.sessionId,
    onText: (text) => setCmd((prev) => (prev ? `${prev} ${text}` : text)),
    onError: (msg) => toast(msg),
  });

  // TRIPLE-tap on the title opens rename (single/double tap must NOT).
  const handleTitleTap = useCallback(() => {
    tapCount.current += 1;
    if (tapTimer.current) clearTimeout(tapTimer.current);
    if (tapCount.current >= 3) {
      tapCount.current = 0;
      setDraft(tab.title);
      setEditing(true);
      return;
    }
    tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 600);
  }, [tab.title]);

  const commitRename = useCallback(() => {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== tab.title) {
      useTerminalStore.getState().updateTab(serverId, tab.id, { title, customTitle: true });
    }
  }, [draft, serverId, tab.id, tab.title]);

  const sendRaw = useCallback((data: string) => {
    if (!tab.sessionId) return;
    wsService.send({ type: 'terminal:input', sessionId: tab.sessionId, payload: { data } });
  }, [tab.sessionId, wsService]);

  const sendCmd = useCallback(() => {
    if (!cmd.trim() || !tab.sessionId) return;
    sendRaw(cmd + '\r');
    setCmd('');
  }, [cmd, tab.sessionId, sendRaw]);

  const toggleAuto = useCallback(() => {
    if (!tab.sessionId) return;
    useAutoApproveStore.getState().toggle(tab.sessionId);
  }, [tab.sessionId]);

  return (
    <GlassSurface strong={expanded} style={[styles.card, full ? { flex: 1, minHeight: 0 } : { marginBottom: 12 }]}>
      <Pressable onPress={full ? undefined : onToggle} accessibilityRole="button" disabled={full}>
        <View style={styles.cardHead}>
          {/* Mockup anatomy: 10px color dot, name + description stack. */}
          <View style={[styles.cardTag, { backgroundColor: color }]} />
          <View style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onBlur={commitRename}
                onSubmitEditing={commitRename}
                autoFocus
                style={[styles.cardName, { color: c.text, borderBottomColor: c.accent, fontSize: m.font.section }]}
              />
            ) : (
              <Pressable onPress={handleTitleTap} accessibilityHint="Dreifach tippen zum Umbenennen">
                <Text numberOfLines={1} style={[styles.cardName, { color: c.text, fontSize: m.font.section }]}>
                  {tab.title}
                </Text>
              </Pressable>
            )}
            <Text numberOfLines={1} style={{ color: c.textDim, fontSize: m.font.caption, marginTop: 1 }}>
              {tab.lastCwd ?? (tab.sessionId ? 'Verbunden' : 'Startet…')}
            </Text>
          </View>

          {/* Auto-Approve pill — icon + label, green when on (mockup .auto-toggle). */}
          <Pressable
            onPress={toggleAuto}
            accessibilityLabel="Auto-Approve umschalten"
            accessibilityState={{ selected: autoOn }}
            style={({ pressed }) => [
              styles.autoPill,
              {
                borderColor: autoOn ? `rgba(74,222,128,0.4)` : c.glassBorder,
                backgroundColor: autoOn ? 'rgba(74,222,128,0.08)' : `rgba(${c.overlayRgb},0.06)`,
              },
              pressed && { transform: [{ scale: 0.94 }] },
            ]}
          >
            <IconBolt size={m.icon.sm} color={autoOn ? c.ok : c.textDim} />
            <Text style={{ color: autoOn ? c.ok : c.textDim, fontSize: m.font.caption, fontWeight: '700' }}>AUTO</Text>
          </Pressable>

          {/* Status chip (mockup .status-chip). */}
          <View style={[styles.statusChip, { backgroundColor: `rgba(${tab.notificationCount ? '251,191,36' : tab.sessionId ? '74,222,128' : '251,191,36'},0.08)` }]}>
            <View style={[styles.statusDot, { backgroundColor: tab.notificationCount ? c.warn : tab.sessionId ? c.ok : c.warn }]} />
            <Text style={{ color: tab.notificationCount ? c.warn : tab.sessionId ? c.ok : c.warn, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 }}>
              {tab.notificationCount ? 'WARTET' : tab.sessionId ? 'BEREIT' : 'START'}
            </Text>
          </View>

          {onToggleFullscreen && (
            <Pressable
              onPress={onToggleFullscreen}
              accessibilityLabel={fullscreen ? 'Vollbild verlassen' : 'Terminal auf Vollbild'}
              style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            >
              {fullscreen
                ? <IconMinimize size={m.icon.sm} color={c.accent} />
                : <IconMaximize size={m.icon.sm} color={c.textDim} />}
            </Pressable>
          )}
          <Pressable
            onPress={() => onNotes(color)}
            accessibilityLabel="Notizen und Todos"
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <IconNotes size={m.icon.sm} color={c.textDim} />
          </Pressable>
          <Pressable
            onPress={() => setConfirmClose(true)}
            accessibilityLabel="Terminal schließen"
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <IconTrash size={m.icon.sm} color={c.textDim} />
          </Pressable>
          {!full && <IconChevronDown size={m.icon.sm} color={c.textDim} />}
        </View>
      </Pressable>

      {confirmClose && (
        <View style={[styles.confirmRow, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
          <Text style={{ flex: 1, color: c.text, fontSize: m.font.caption }}>
            „{tab.title}" wirklich schließen?
          </Text>
          <Pressable
            onPress={() => { setConfirmClose(false); onClose(); }}
            style={({ pressed }) => [styles.confirmBtn, { borderColor: `rgba(${'239,68,68'},0.45)` }, pressed && styles.pressed]}
          >
            <Text style={{ color: c.err, fontSize: m.font.caption, fontWeight: '800' }}>Schließen</Text>
          </Pressable>
          <Pressable
            onPress={() => setConfirmClose(false)}
            style={({ pressed }) => [styles.confirmBtn, { borderColor: c.glassBorder }, pressed && styles.pressed]}
          >
            <Text style={{ color: c.textDim, fontSize: m.font.caption, fontWeight: '700' }}>Abbrechen</Text>
          </Pressable>
        </View>
      )}

      {expanded && (
        <View style={full ? { flex: 1, minHeight: 0 } : undefined}>
          {/* Infinity edge: the terminal runs to the card's borders and takes
              every pixel of height the card can give it. */}
          <View style={[styles.termWrap, { backgroundColor: c.termSurface }, full ? { flex: 1, minHeight: 0 } : { height: 420 }]}>
            {tab.sessionId ? (
              <TerminalView
                ref={termRef}
                sessionId={tab.sessionId}
                wsService={wsService}
                visible={expanded}
                fontSize={terminalFontSize}
                disableKeyboardOffset
                tapFocusDisabled
              />
            ) : (
              <View style={styles.termPending}>
                <Text style={{ color: c.textDim, fontSize: m.font.caption }}>Session wird gestartet…</Text>
              </View>
            )}
            {/* Jump-to-bottom — floats over the terminal, always reachable. */}
            <Pressable
              onPress={() => termRef.current?.scrollToBottom()}
              accessibilityLabel="Nach unten springen"
              style={({ pressed }) => [
                styles.jumpBtn,
                { backgroundColor: `rgba(${c.accentRgb},0.22)`, borderColor: `rgba(${c.accentRgb},0.45)` },
                pressed && styles.pressed,
              ]}
            >
              <IconArrowDownCircle size={m.icon.md} color={c.accent} />
            </Pressable>
          </View>
          {/* Command line: recessed well surface so it clearly reads as input. */}
          <View style={styles.inputZone}>
            <View style={[styles.inputRow, { backgroundColor: c.well, borderColor: c.glassBorder }]}>
              <Text style={{ color: c.accent, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: m.font.body, fontWeight: '700' }}>$</Text>
              <TextInput
                value={cmd}
                onChangeText={setCmd}
                onSubmitEditing={sendCmd}
                placeholder="Befehl eingeben…"
                placeholderTextColor={c.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.cmdInput, { color: c.text, fontSize: m.font.body }]}
              />
              <Pressable
                onPress={toggleMic}
                hitSlop={6}
                accessibilityLabel={micState === 'recording' ? 'Aufnahme stoppen' : 'Diktieren'}
                style={[
                  styles.micBtn,
                  micState === 'recording' && { backgroundColor: 'rgba(239,68,68,0.16)' },
                  micState === 'processing' && { backgroundColor: `rgba(${c.accentRgb},0.16)` },
                ]}
              >
                <IconMic
                  size={m.icon.md}
                  color={micState === 'recording' ? c.err : micState === 'processing' ? c.accent : c.textDim}
                />
              </Pressable>
              <Pressable
                onPress={sendCmd}
                hitSlop={6}
                accessibilityLabel="Senden"
                style={({ pressed }) => [styles.sendBtn, { backgroundColor: `rgba(${c.accentRgb},0.22)` }, pressed && styles.pressed]}
              >
                <IconSend size={m.icon.sm} color={c.accent} />
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  pickerWrap: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 120 },
  pageTitle: { fontWeight: '700', letterSpacing: -0.26 },
  serverCard: { marginBottom: 12, padding: 16 },
  serverRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12 },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 12 },
  viewToggle: { flexDirection: 'row', gap: 3, padding: 4, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 999 },
  viewToggleBtn: { minWidth: 40, minHeight: 36, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  chipStrip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingTop: 10 },
  swipeRail: { justifyContent: 'center', gap: 6, paddingLeft: 8, paddingBottom: 12 },
  railBtn: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  dot: { height: 7, borderRadius: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 36, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2 },
  badge: { width: 8, height: 8, borderRadius: 4 },
  addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 },
  cardTag: { width: 10, height: 10, borderRadius: 5 },
  cardName: { fontWeight: '700', letterSpacing: -0.1, paddingVertical: 1, borderBottomWidth: 1, borderBottomColor: 'transparent' },
  autoPill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, minWidth: 44, paddingHorizontal: 10, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2 },
  statusChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  spine: { position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, borderTopRightRadius: 2, borderBottomRightRadius: 2, zIndex: 2 },
  colorTag: { width: 8, height: 8, borderRadius: 4 },
  titleInput: { flex: 1, borderBottomWidth: 1, paddingVertical: 2, fontWeight: '600' },
  iconBtn: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  confirmBtn: { paddingHorizontal: 12, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  termWrap: { marginHorizontal: 0, borderRadius: 0, overflow: 'hidden' },
  termPending: { flex: 1, minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  jumpBtn: { position: 'absolute', right: 10, bottom: 10, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  inputZone: { paddingHorizontal: 6, paddingBottom: 6, paddingTop: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth * 2 },
  cmdInput: { flex: 1, paddingVertical: 6, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  micBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
