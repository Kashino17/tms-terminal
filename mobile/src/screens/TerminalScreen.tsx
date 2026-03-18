import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { AppState, View, StyleSheet, Text, TouchableOpacity, Alert, Pressable, Animated, PanResponder, Easing, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { ToolRail, ToolRailRef, TOOL_RAIL_WIDTH } from '../components/ToolRail';
import { TerminalTabs } from '../components/TerminalTabs';
import { TerminalToolbar } from '../components/TerminalToolbar';
import { TerminalView, clearViewBuffer } from '../components/TerminalView';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { ReconnectBanner, RestoreState } from '../components/ReconnectBanner';
import { WebSocketService } from '../services/websocket.service';
import { useServerStore } from '../store/serverStore';
import { useTerminalStore } from '../store/terminalStore';
import { TerminalTab, AiToolType } from '../types/terminal.types';
import { ConnectionState } from '../types/websocket.types';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { requestNotificationPermission, getFcmToken } from '../services/notifications.service';
import { useAutoApproveStore } from '../store/autoApproveStore';
import { SplitLayout } from '../components/SplitLayout';
import { useSplitViewStore } from '../store/splitViewStore';
import { consumeDrawingResult } from './DrawingScreen';
import { TabGridView } from '../components/TabGridView';
import { ANSI_RE as ANSI_STRIP_RE, stripAnsi } from '../utils/stripAnsi';

// Client-side prompt patterns — matches same triggers as server, runs on every output chunk
const CLIENT_PROMPT_PATTERNS = [
  /\[y\/n\]/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,
  /press enter to continue/i,
  /do you want (me )?to/i,
  /do you want to proceed/i,
  /would you like/i,
  /shall i /i,
  /continue\?/i,
  /proceed\?/i,
  /confirm\?/i,
  /approve\?/i,
  /allow (this action|bash|command|running|tool|edit|execution)/i,
  /dangerous command/i,
  /apply (this )?edit/i,
  /apply (change|patch|diff)\?/i,
  /run (this )?command\?/i,
  /execute (this )?command/i,
  /allow execution of/i,
  /waiting for user confirmation/i,
  /execution of:/i,
  /\?\s*(›|\[|\()/,
  /\?\s*$/m,
];

const OUTPUT_BUFFER_MAX_CHARS = 600;

// Strip ANSI/VT100 escape sequences so the grid card preview shows readable text
// instead of raw control codes produced by TUI apps like Claude Code.
function stripAnsiForPreview(s: string): string {
  return stripAnsi(s)
    .replace(/\r\n/g, '\n')                               // normalize CRLF
    .replace(/\r/g, '\n')                                 // lone CR → newline
    .replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, ''); // drop remaining control chars
}

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Terminal'>;
  route: RouteProp<RootStackParamList, 'Terminal'>;
};

export function TerminalScreen({ navigation, route }: Props) {
  const { serverId, serverName } = route.params;
  const { height: screenHeight } = useWindowDimensions();
  const screenHeightRef = useRef(screenHeight);
  screenHeightRef.current = screenHeight;
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const { tabs, addTab, removeTab, setActiveTab, setConnectionState, updateTab, setTabNotification } = useTerminalStore();
  const wsRef = useRef<WebSocketService>(new WebSocketService());
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const responsive = useResponsive();
  const { rf, rs, ri } = responsive;

  // Tabs that need terminal:create once their WebView reports its real size
  const pendingCreateRef = useRef<Set<string>>(new Set());
  // Last known dimensions per tab (cols × rows from xterm.js onReady)
  const tabDimsRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  // Track which tabs have had their WebView mounted at least once (lazy-mount)
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(new Set());
  // Maps tabId → lastCwd for tabs whose sessions died and need CWD restoration
  const pendingRestoreRef = useRef<Map<string, string>>(new Map());
  // Reconnect banner state
  const [restoreState, setRestoreState] = useState<RestoreState | null>(null);
  const restoreDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rangeActive, setRangeActive] = useState(false);
  const toolRailRef = useRef<ToolRailRef>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const railWidthAnim = useRef(new Animated.Value(TOOL_RAIL_WIDTH)).current;

  const [outputBuffers, setOutputBuffers] = useState<Record<string, string>>({});
  const [lastActivity,  setLastActivity]  = useState<Record<string, number>>({});
  const [gridVisible,   setGridVisible]   = useState(false);
  const pendingTabIdRef = useRef<string | null>(null);
  const gridTranslateY  = useRef(new Animated.Value(screenHeight)).current;


  const serverTabs = tabs[serverId] || [];

  useEffect(() => {
    navigation.setOptions({ title: serverName });
  }, [serverName, navigation]);

  // AppState: clean up dismiss timer on unmount
  useEffect(() => {
    return () => {
      if (restoreDismissTimer.current) clearTimeout(restoreDismissTimer.current);
    };
  }, []);

  // When active tab changes, ensure its WebView is mounted
  useEffect(() => {
    const activeTab = serverTabs.find((t) => t.active);
    if (!activeTab) return;
    setMountedTabs((prev) => {
      if (prev.has(activeTab.id)) return prev;
      const next = new Set(prev);
      next.add(activeTab.id);
      return next;
    });
  }, [serverTabs]);

  // Connect WebSocket
  useEffect(() => {
    if (!server?.token) {
      Alert.alert('Error', 'No auth token. Please re-add this server.');
      navigation.goBack();
      return;
    }

    const ws = wsRef.current;

    ws.setStateHandler((state) => {
      setConnState(state);
      setConnectionState(serverId, state);
      // Also update serverStore so ServerListScreen shows correct status
      useServerStore.getState().setStatus(serverId, { connected: state === 'connected' });
    });

    const unsubscribe = ws.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: any };

      if (m.type === 'terminal:created' && m.sessionId) {
        // Assign sessionId to the oldest pending tab
        const pending = useTerminalStore.getState().getTabs(serverId).find((t) => !t.sessionId);
        if (pending) {
          useTerminalStore.getState().updateTab(serverId, pending.id, { sessionId: m.sessionId });

          // CWD restore: if this tab was recreated from a dead session, cd to last known dir
          const restoreCwd = pendingRestoreRef.current.get(pending.id);
          if (restoreCwd) {
            pendingRestoreRef.current.delete(pending.id);
            const sid = m.sessionId;
            // Small delay to let the shell initialize before sending input
            setTimeout(() => {
              if (wsRef.current.state === 'connected') {
                // Use single-quoted path to handle spaces; escape embedded single quotes
                const quoted = `'${restoreCwd.replace(/'/g, "'\\''")}'`;
                wsRef.current.send({
                  type: 'terminal:input',
                  sessionId: sid,
                  payload: { data: `cd ${quoted}\r` },
                });
              }
            }, 400);
          }

          // Decrement restore counter
          decrementRestore();
        }
      } else if (m.type === 'terminal:reattached' && m.sessionId) {
        // Update lastCwd + lastProcess from server-side snapshot
        const tab = useTerminalStore.getState().getTabs(serverId).find(
          (t) => t.sessionId === m.sessionId,
        );
        if (tab) {
          const updates: Record<string, string | undefined> = {};
          if (m.payload?.cwd) updates.lastCwd = m.payload.cwd;
          if (m.payload?.processName) updates.lastProcess = m.payload.processName;
          if (Object.keys(updates).length > 0) {
            useTerminalStore.getState().updateTab(serverId, tab.id, updates);
          }
        }

        // Decrement restore counter
        decrementRestore();
      } else if (m.type === 'terminal:prompt_detected' && m.sessionId) {
        // Auto-approve: send Enter once if enabled for this session
        const autoApprove = useAutoApproveStore.getState();
        if (autoApprove.isEnabled(m.sessionId) && !autoApprove.isRunning(m.sessionId)) {
          const sid = m.sessionId;
          autoApprove.setRunning(sid, true);
          wsRef.current.send({ type: 'terminal:input', sessionId: sid, payload: { data: '\r' } });
          // Release lock after 1s — short enough not to block back-to-back prompts
          setTimeout(() => autoApprove.setRunning(sid, false), 1000);
        } else {
          // Set notification badge on the tab (only if it's not the active tab)
          useTerminalStore.getState().setTabNotification(serverId, m.sessionId);
        }
      } else if (m.type === 'terminal:output' && m.sessionId && m.payload?.data) {
        // Client-side prompt detection — catches prompts regardless of server silence timer
        const autoApprove = useAutoApproveStore.getState();
        if (autoApprove.isEnabled(m.sessionId) && !autoApprove.isRunning(m.sessionId)) {
          const clean = (m.payload.data as string).replace(ANSI_STRIP_RE, '');
          const tail = clean.slice(-400);
          if (CLIENT_PROMPT_PATTERNS.some((p) => p.test(tail))) {
            const sid = m.sessionId;
            autoApprove.setRunning(sid, true);
            wsRef.current.send({ type: 'terminal:input', sessionId: sid, payload: { data: '\r' } });
            setTimeout(() => autoApprove.setRunning(sid, false), 1500);
          }
        }

        // Output buffer for tab grid live preview
        const outputTab = useTerminalStore.getState().getTabs(serverId).find(
          (t) => t.sessionId === m.sessionId,
        );
        if (outputTab) {
          const sessionData = stripAnsiForPreview(m.payload.data as string);
          setOutputBuffers((prev) => {
            const raw = (prev[outputTab.id] ?? '') + sessionData;
            if (raw.length <= OUTPUT_BUFFER_MAX_CHARS) {
              return { ...prev, [outputTab.id]: raw };
            }
            const trimmed = raw.slice(raw.length - OUTPUT_BUFFER_MAX_CHARS);
            const nl = trimmed.indexOf('\n');
            return { ...prev, [outputTab.id]: nl >= 0 ? trimmed.slice(nl + 1) : trimmed };
          });
          setLastActivity((prev) => ({ ...prev, [outputTab.id]: Date.now() }));
        }
      } else if (m.type === 'terminal:error' && m.sessionId && m.sessionId !== 'none') {
        // Session expired — immediately re-create if we know the dimensions
        const deadTab = useTerminalStore.getState().getTabs(serverId).find(
          (t) => t.sessionId === m.sessionId,
        );
        if (deadTab) {
          // Preserve lastCwd so we can restore it after the new session starts
          if (deadTab.lastCwd) {
            pendingRestoreRef.current.set(deadTab.id, deadTab.lastCwd);
          }
          // Clear the old view-buffer so the recreated session starts on a clean screen
          clearViewBuffer(deadTab.sessionId!);
          useTerminalStore.getState().updateTab(serverId, deadTab.id, { sessionId: undefined });
          const dims = tabDimsRef.current.get(deadTab.id);
          if (dims && wsRef.current.state === 'connected') {
            wsRef.current.send({ type: 'terminal:create', payload: dims });
          } else {
            // Fallback: wait for next onReady
            pendingCreateRef.current.add(deadTab.id);
          }
        }
      }
    });

    ws.connect({ host: server.host, port: server.port, token: server.token });

    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [serverId]);

  // When connected: register FCM token with the server for push notifications
  useEffect(() => {
    if (connState !== 'connected') return;
    (async () => {
      const granted = await requestNotificationPermission();
      if (!granted) return;
      const token = await getFcmToken();
      if (!token) return;
      wsRef.current.send({ type: 'client:register_token', payload: { token } });
    })();
  }, [connState]);

  /** Decrement the pending restore counter; auto-dismiss banner when done. */
  const decrementRestore = useCallback(() => {
    setRestoreState(prev => {
      if (!prev) return prev;
      const next = prev.pending - 1;
      if (next <= 0) {
        // Show "done" state briefly then hide
        if (restoreDismissTimer.current) clearTimeout(restoreDismissTimer.current);
        restoreDismissTimer.current = setTimeout(() => setRestoreState(null), 2000);
        return { ...prev, pending: 0 };
      }
      return { ...prev, pending: next };
    });
  }, []);

  // On (re)connect: create first tab if none, or reattach/re-create all existing tabs
  useEffect(() => {
    if (connState !== 'connected') return;
    const currentTabs = useTerminalStore.getState().getTabs(serverId);
    if (currentTabs.length === 0) {
      createNewTab();
      return;
    }

    // Count how many existing sessions we're about to restore
    const sessionsToRestore = currentTabs.filter((t) => t.sessionId || pendingCreateRef.current.has(t.id));
    if (sessionsToRestore.length > 0) {
      if (restoreDismissTimer.current) clearTimeout(restoreDismissTimer.current);
      setRestoreState({ total: sessionsToRestore.length, pending: sessionsToRestore.length });
      // Safety net: dismiss after 15s if some sessions never respond
      restoreDismissTimer.current = setTimeout(() => setRestoreState(null), 15_000);
    }

    // Existing tabs: trigger reattach or create using last known dims (or defaults)
    for (const tab of currentTabs) {
      const dims = tabDimsRef.current.get(tab.id) ?? { cols: 80, rows: 24 };
      if (pendingCreateRef.current.has(tab.id)) {
        pendingCreateRef.current.delete(tab.id);
        wsRef.current.send({ type: 'terminal:create', payload: dims });
      } else if (tab.sessionId) {
        wsRef.current.send({ type: 'terminal:reattach', sessionId: tab.sessionId, payload: dims });
      } else {
        // Tab has no session — create one
        wsRef.current.send({ type: 'terminal:create', payload: dims });
      }
    }
  }, [connState]);

  const createNewTab = useCallback(() => {
    const currentTabs = useTerminalStore.getState().getTabs(serverId);
    const id = Date.now().toString(36);
    const tab: TerminalTab = {
      id,
      title: `Shell ${currentTabs.length + 1}`,
      serverId,
      active: true,
    };
    pendingCreateRef.current.add(id);
    addTab(serverId, tab);
    // terminal:create is sent in handleTabReady once xterm.js reports its real size
  }, [serverId, addTab]);

  // Called by TerminalView when xterm.js has loaded and knows its real dimensions
  const handleTabReady = useCallback((tabId: string, cols: number, rows: number) => {
    // Always save latest dimensions (used for re-creation after failed reattach)
    tabDimsRef.current.set(tabId, { cols, rows });

    if (wsRef.current.state !== 'connected') return;

    if (pendingCreateRef.current.has(tabId)) {
      // New tab — create PTY with real dimensions
      pendingCreateRef.current.delete(tabId);
      wsRef.current.send({ type: 'terminal:create', payload: { cols, rows } });
    } else {
      // Existing tab — reattach to the server PTY
      const tab = useTerminalStore.getState().getTabs(serverId).find((t) => t.id === tabId);
      if (tab?.sessionId) {
        wsRef.current.send({
          type: 'terminal:reattach',
          sessionId: tab.sessionId,
          payload: { cols, rows },
        });
      }
    }
  }, [serverId]);

  const handleCloseTab = useCallback((tabId: string) => {
    pendingCreateRef.current.delete(tabId);
    tabDimsRef.current.delete(tabId);
    setMountedTabs((prev) => { const s = new Set(prev); s.delete(tabId); return s; });
    setOutputBuffers((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLastActivity((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    const tab = useTerminalStore.getState().getTabs(serverId).find((t) => t.id === tabId);
    if (tab?.sessionId) {
      wsRef.current.send({ type: 'terminal:close', sessionId: tab.sessionId });
      clearViewBuffer(tab.sessionId);
      useAutoApproveStore.getState().clear(tab.sessionId);
    }
    removeTab(serverId, tabId);
  }, [serverId, removeTab]);

  const handleRenameTab = useCallback((tabId: string, newName: string) => {
    updateTab(serverId, tabId, { title: newName });
  }, [serverId, updateTab]);

  const openGrid = useCallback(() => {
    setGridVisible(true);
    gridTranslateY.setValue(screenHeightRef.current);
    Animated.spring(gridTranslateY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [gridTranslateY]);

  const closeGrid = useCallback(() => {
    Animated.timing(gridTranslateY, {
      toValue: screenHeightRef.current,
      duration: 200,
      useNativeDriver: true,
      easing: Easing.in(Easing.ease),
    }).start(() => {
      setGridVisible(false);
      if (pendingTabIdRef.current) {
        setActiveTab(serverId, pendingTabIdRef.current);
        pendingTabIdRef.current = null;
      }
    });
  }, [gridTranslateY, serverId, setActiveTab]);

  const handleGridSelectTab = useCallback((tabId: string) => {
    pendingTabIdRef.current = tabId;
    closeGrid();
  }, [closeGrid]);

  const handleGridAddTab = useCallback(() => {
    createNewTab();
    closeGrid();
  }, [createNewTab, closeGrid]);

  const handleAiToolDetected = useCallback((tabId: string, tool: AiToolType) => {
    updateTab(serverId, tabId, { aiTool: tool });
  }, [serverId, updateTab]);

  // Only render WebViews for tabs that have been activated at least once (lazy-mount)
  const tabsToRender = serverTabs.filter((t) => mountedTabs.has(t.id));

  // Drawing result — inject saved path into terminal when returning from DrawingScreen
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      const path = consumeDrawingResult();
      if (path) {
        const activeTab = useTerminalStore.getState().getTabs(serverId).find((t) => t.active);
        if (activeTab?.sessionId && wsRef.current.state === 'connected') {
          wsRef.current.send({ type: 'terminal:input', sessionId: activeTab.sessionId, payload: { data: path } });
        }
      }
    });
    return unsubscribe;
  }, [navigation, serverId]);

  // ToolRail action handler — non-panel tools navigate to their own screen
  const handleToolAction = useCallback((toolId: string): boolean => {
    if (toolId === 'drawing') {
      navigation.navigate('Drawing', {
        serverHost: server?.host ?? '',
        serverPort: server?.port ?? 8767,
        serverToken: server?.token ?? '',
      });
      return true;
    }
    if (toolId === 'browser') {
      navigation.navigate('Browser', {
        serverHost: server?.host ?? '',
        serverId,
      });
      return true;
    }
    if (toolId === 'processes') {
      navigation.navigate('Processes', {
        wsService: wsRef.current,
      });
      return true;
    }
    return false;
  }, [navigation, server, serverId]);

  const splitActive = useSplitViewStore((s) => s.active);

  // ── Swipe between tabs ─────────────────────────────────────────────────────
  const swipeRef = useRef({ x0: 0, y0: 0, t0: 0 });
  const tabSwipePanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => {
      if (g.numberActiveTouches !== 2) return false;
      // Horizontal swipe (tab switch) or vertical swipe up (tab grid)
      return Math.abs(g.dx) > 20 || (g.dy < -20 && Math.abs(g.dy) > Math.abs(g.dx) * 2);
    },
    onPanResponderGrant: (_, g) => {
      swipeRef.current = { x0: g.x0, y0: g.y0, t0: Date.now() };
    },
    onPanResponderRelease: (_, g) => {
      const dx = g.dx;
      const dy = g.dy;
      const elapsed = Date.now() - swipeRef.current.t0;
      if (elapsed > 800) return;

      // Swipe UP with 2 fingers → open tab grid
      if (dy < -80 && Math.abs(dy) > Math.abs(dx) * 1.5) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        openGrid();
        return;
      }

      // Horizontal swipe → switch tabs
      if (Math.abs(dx) < 50) return;
      const currentTabs = useTerminalStore.getState().getTabs(serverId);
      const activeIdx = currentTabs.findIndex((t) => t.active);
      if (activeIdx === -1) return;

      if (dx < -50 && activeIdx < currentTabs.length - 1) {
        Haptics.selectionAsync();
        setActiveTab(serverId, currentTabs[activeIdx + 1].id);
      } else if (dx > 50 && activeIdx > 0) {
        Haptics.selectionAsync();
        setActiveTab(serverId, currentTabs[activeIdx - 1].id);
      }
    },
  }), [serverId, setActiveTab, openGrid]);

  const quickActionSize = ri(28);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={[styles.statusBar, { paddingHorizontal: rs(12), paddingVertical: rs(6) }]}>
        <TouchableOpacity
          style={[styles.backBtn, { paddingVertical: rs(2), paddingRight: rs(12) }]}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Feather name="arrow-left" size={ri(16)} color={colors.primary} />
          <Text style={[styles.backBtnText, { fontSize: rf(15) }]}> Back</Text>
        </TouchableOpacity>
        <View style={[styles.statusRight, { gap: rs(6) }]}>
          <TouchableOpacity
            style={[styles.quickAction, { width: quickActionSize, height: quickActionSize, borderRadius: rs(7) }]}
            onPress={() => handleToolAction('browser')}
            activeOpacity={0.65}
            accessibilityLabel="Open browser"
            accessibilityRole="button"
          >
            <Feather name="globe" size={ri(14)} color={colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.quickAction, { width: quickActionSize, height: quickActionSize, borderRadius: rs(7) }]}
            onPress={() => handleToolAction('drawing')}
            activeOpacity={0.65}
            accessibilityLabel="Open drawing"
            accessibilityRole="button"
          >
            <Feather name="edit-2" size={ri(14)} color={colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.quickAction, { width: quickActionSize, height: quickActionSize, borderRadius: rs(7) }]}
            onPress={() => handleToolAction('processes')}
            activeOpacity={0.65}
            accessibilityLabel="Open processes"
            accessibilityRole="button"
          >
            <Feather name="activity" size={ri(14)} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={[styles.statusDivider, { marginHorizontal: rs(1) }]} />
          <ConnectionStatus state={connState} />
        </View>
      </View>
      <ReconnectBanner restoreState={restoreState} />
      <TerminalTabs
        tabs={serverTabs}
        onSelect={(id) => setActiveTab(serverId, id)}
        onClose={handleCloseTab}
        onAdd={createNewTab}
        onRename={handleRenameTab}
        onOpenGrid={openGrid}
      />
      {splitActive ? (
        <SplitLayout
          serverHost={server?.host ?? ''}
          terminalContent={
            <>
              {tabsToRender.map((tab) => (
                <TerminalView
                  key={tab.id}
                      sessionId={tab.sessionId}
                  wsService={wsRef.current}
                  visible={tab.active}
                  onReady={(cols, rows) => handleTabReady(tab.id, cols, rows)}
                  onAiToolDetected={(tool) => handleAiToolDetected(tab.id, tool)}
                  rangeActive={tab.active && rangeActive}
                  onRangeClose={() => setRangeActive(false)}
                />
              ))}
              <TerminalToolbar
                sessionId={serverTabs.find((t) => t.active)?.sessionId}
                wsService={wsRef.current}
                rangeActive={rangeActive}
                onRangeToggle={() => setRangeActive((v) => !v)}
              />
            </>
          }
        />
      ) : (
        <View style={styles.terminalArea} {...tabSwipePanResponder.panHandlers}>
          {tabsToRender.map((tab) => (
            <TerminalView
              key={tab.id}
              sessionId={tab.sessionId}
              wsService={wsRef.current}
              visible={tab.active}
              onReady={(cols, rows) => handleTabReady(tab.id, cols, rows)}
              onAiToolDetected={(tool) => handleAiToolDetected(tab.id, tool)}
              rangeActive={tab.active && rangeActive}
              onRangeClose={() => setRangeActive(false)}
              railWidth={railWidthAnim}
            />
          ))}
          {panelOpen && (
            <Pressable
              style={styles.panelBackdrop}
              onPress={() => toolRailRef.current?.closePanel()}
            />
          )}
          <TerminalToolbar
            sessionId={serverTabs.find((t) => t.active)?.sessionId}
            wsService={wsRef.current}
            rangeActive={rangeActive}
            onRangeToggle={() => setRangeActive((v) => !v)}
            railWidth={railWidthAnim}
          />
          <ToolRail
            ref={toolRailRef}
            onPanelChange={setPanelOpen}
            railWidthAnim={railWidthAnim}
            onToolAction={handleToolAction}
            sessionId={serverTabs.find((t) => t.active)?.sessionId}
            wsService={wsRef.current}
            serverHost={server?.host ?? ''}
            serverPort={server?.port ?? 8767}
            serverToken={server?.token ?? ''}
            serverId={serverId}
          />
        </View>
      )}
      <TabGridView
        visible={gridVisible}
        tabs={serverTabs}
        outputBuffers={outputBuffers}
        lastActivity={lastActivity}
        translateY={gridTranslateY}
        onClose={closeGrid}
        onSelectTab={handleGridSelectTab}
        onCloseTab={handleCloseTab}
        onAddTab={handleGridAddTab}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  statusBar: {
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtnText: {
    color: colors.primary,
    fontWeight: '600',
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  quickAction: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDivider: {
    width: 1,
    height: 16,
    backgroundColor: colors.border,
  },
  terminalArea: {
    flex: 1,
  },
  panelBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
});
