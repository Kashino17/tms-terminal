import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { AppState, View, StyleSheet, Text, TouchableOpacity, Alert, Pressable, Animated, PanResponder, Easing, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { ToolRail, ToolRailRef, TOOL_RAIL_WIDTH } from '../components/ToolRail';
import { TerminalTabs } from '../components/TerminalTabs';
import { TerminalToolbar } from '../components/TerminalToolbar';
import { TerminalView, TerminalViewRef, clearViewBuffer } from '../components/TerminalView';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { ReconnectBanner, RestoreState } from '../components/ReconnectBanner';
import { WebSocketService } from '../services/websocket.service';
import { useServerStore } from '../store/serverStore';
import { useTerminalStore } from '../store/terminalStore';
import { TerminalTab, AiToolType, TabCategory, ServerType } from '../types/terminal.types';
import { detectServerType } from '../utils/serverDetector';
import { ConnectionState } from '../types/websocket.types';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { requestNotificationPermission, getFcmToken } from '../services/notifications.service';
import { useAutoApproveStore } from '../store/autoApproveStore';
import { useAutopilotStore } from '../store/autopilotStore';
import { useSettingsStore } from '../store/settingsStore';
import { useBrowserTabsStore } from '../store/browserTabsStore';
import { SplitLayout } from '../components/SplitLayout';
import { useSplitViewStore } from '../store/splitViewStore';
import { consumeDrawingResult } from './DrawingScreen';
import { TabGridView } from '../components/TabGridView';
import { stripAnsi } from '../utils/stripAnsi';

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
  // browserOpen flag is now persisted on each TerminalTab in the store
  const railWidthAnim = useRef(new Animated.Value(TOOL_RAIL_WIDTH)).current;

  const autoApproveTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const termViewRefs = useRef<Map<string, TerminalViewRef>>(new Map());
  const outputBuffersRef = useRef<Record<string, string>>({});
  const lastActivityRef  = useRef<Record<string, number>>({});
  const [outputBuffers, setOutputBuffers] = useState<Record<string, string>>({});
  const [lastActivity,  setLastActivity]  = useState<Record<string, number>>({});
  const [gridVisible,   setGridVisible]   = useState(false);
  const pendingTabIdRef = useRef<string | null>(null);
  const gridTranslateY  = useRef(new Animated.Value(screenHeight)).current;


  // Throttled sync: only copy output refs to state when grid is visible (every 500ms)
  useEffect(() => {
    if (!gridVisible) return;
    // Sync immediately on open
    setOutputBuffers({ ...outputBuffersRef.current });
    setLastActivity({ ...lastActivityRef.current });
    const timer = setInterval(() => {
      setOutputBuffers({ ...outputBuffersRef.current });
      setLastActivity({ ...lastActivityRef.current });
    }, 500);
    return () => clearInterval(timer);
  }, [gridVisible]);

  const [rtt, setRtt] = useState<number | undefined>(undefined);
  const [quality, setQuality] = useState<import('../services/websocket.service').ConnectionQuality>('good');
  const [jitter, setJitter] = useState<number>(0);

  const serverTabs = tabs[serverId] || [];
  const activeTerminalTab = serverTabs.find((t) => t.active);
  const activeTabHasBrowser = !!activeTerminalTab?.browserOpen;

  useEffect(() => {
    navigation.setOptions({ title: serverName });
  }, [serverName, navigation]);

  // AppState: clean up dismiss timer on unmount
  useEffect(() => {
    return () => {
      if (restoreDismissTimer.current) clearTimeout(restoreDismissTimer.current);
    };
  }, []);

  // Track whether app was backgrounded so we only reconnect when truly returning from background
  const backgroundedRef = useRef(false);

  // AppState: background/foreground handling — detach sessions on background, reconnect on active
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        backgroundedRef.current = true;
        // Notify server to detach all sessions, then disconnect immediately
        // (WebSocket send() buffers the message synchronously before close() is called)
        wsRef.current.send({ type: 'client:backgrounding' } as any);
        wsRef.current.disconnect();
      } else if (nextState === 'active' && backgroundedRef.current) {
        backgroundedRef.current = false;
        // Reconnect WebSocket — read fresh server data from store to avoid stale closure
        const srv = useServerStore.getState().servers.find((s) => s.id === serverId);
        if (srv?.token) {
          wsRef.current.connect({ host: srv.host, port: srv.port, token: srv.token });
        }
      }
    });
    return () => {
      subscription.remove();
    };
  }, [serverId]);

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
        // BUT skip if user is actively typing or has unsent text on the line
        const autoApprove = useAutoApproveStore.getState();
        const hasPendingInput = !!(m.payload as any)?.hasPendingInput;
        if (autoApprove.isEnabled(m.sessionId) && !autoApprove.isRunning(m.sessionId) && !autoApprove.isTyping(m.sessionId) && !hasPendingInput) {
          const sid = m.sessionId;
          autoApprove.setRunning(sid, true);
          wsRef.current.send({ type: 'terminal:input', sessionId: sid, payload: { data: '\r' } });
          // Release lock after 500ms — fast enough for back-to-back prompts
          const timer1 = setTimeout(() => { autoApprove.setRunning(sid, false); autoApproveTimers.current.delete(timer1); }, 500);
          autoApproveTimers.current.add(timer1);
        } else {
          // Set notification badge on the tab (only if it's not the active tab)
          useTerminalStore.getState().setTabNotification(serverId, m.sessionId);
        }
      } else if (m.type === 'terminal:output' && m.sessionId && m.payload?.data) {
        // NOTE: Client-side instant prompt detection was removed — it fired immediately on every
        // output chunk without any silence delay, causing premature Enter while the user was typing.
        // Auto-approve now relies solely on the server's prompt detector (2.5s silence timer +
        // typing pause check) which sends terminal:prompt_detected when ready.

        // Output buffer for tab grid live preview
        const outputTab = useTerminalStore.getState().getTabs(serverId).find(
          (t) => t.sessionId === m.sessionId,
        );
        if (outputTab) {
          const sessionData = stripAnsiForPreview(m.payload.data as string);
          const raw = (outputBuffersRef.current[outputTab.id] ?? '') + sessionData;
          if (raw.length <= OUTPUT_BUFFER_MAX_CHARS) {
            outputBuffersRef.current[outputTab.id] = raw;
          } else {
            const trimmed = raw.slice(raw.length - OUTPUT_BUFFER_MAX_CHARS);
            const nl = trimmed.indexOf('\n');
            outputBuffersRef.current[outputTab.id] = nl >= 0 ? trimmed.slice(nl + 1) : trimmed;
          }
          lastActivityRef.current[outputTab.id] = Date.now();

          // Server detection from output — skip if already AI or manually categorised
          if (outputTab.category !== 'ai' && !outputTab.customCategory) {
            const serverResult = detectServerType(outputTab.lastProcess, m.payload.data as string);
            if (serverResult) {
              const serverUpdates: Partial<TerminalTab> = { category: 'server', serverType: serverResult.type };
              if (serverResult.port) serverUpdates.serverPort = serverResult.port;
              useTerminalStore.getState().updateTab(serverId, outputTab.id, serverUpdates);
            }
          }
        }
      } else if (m.type === 'autopilot:optimized' && m.sessionId) {
        const { id, optimizedPrompt } = (m as any).payload;
        useAutopilotStore.getState().updateItem(m.sessionId, id, { optimizedPrompt, status: 'queued' });
      } else if (m.type === 'autopilot:optimize_error' && m.sessionId) {
        const { id, error } = (m as any).payload;
        useAutopilotStore.getState().updateItem(m.sessionId, id, { status: 'error', error });
      } else if (m.type === 'autopilot:prompt_sent' && m.sessionId) {
        const { id } = (m as any).payload;
        useAutopilotStore.getState().updateItem(m.sessionId, id, { status: 'running' });
      } else if (m.type === 'autopilot:prompt_done' && m.sessionId) {
        const { id } = (m as any).payload;
        useAutopilotStore.getState().updateItem(m.sessionId, id, { status: 'done', completedAt: Date.now() });
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
      autoApproveTimers.current.forEach(clearTimeout);
      autoApproveTimers.current.clear();
      ws.disconnect();
    };
  }, [serverId]);

  // When connected: register FCM token and send idle threshold to the server
  useEffect(() => {
    if (connState !== 'connected') return;
    (async () => {
      try {
        console.log('[FCM] Requesting notification permission...');
        const granted = await requestNotificationPermission();
        console.log('[FCM] Permission:', granted ? 'granted' : 'denied');
        if (!granted) return;
        console.log('[FCM] Getting token...');
        const token = await getFcmToken();
        console.log('[FCM] Token:', token ? `${token.slice(0, 20)}...` : 'null');
        if (!token) return;
        wsRef.current.send({ type: 'client:register_token', payload: { token } });
        console.log('[FCM] Token sent to server');
      } catch (err) {
        console.warn('[FCM] Registration failed:', err);
      }
    })();

    // Send idle threshold to server
    const threshold = useSettingsStore.getState().idleThresholdSeconds;
    if (threshold > 0) {
      wsRef.current.send({ type: 'client:set_idle_threshold', payload: { seconds: threshold } } as any);
      console.log(`[Idle] Threshold sent to server: ${threshold}s`);
    }
  }, [connState]);

  // Poll RTT from WebSocket service and update state for ConnectionStatus
  useEffect(() => {
    if (connState !== 'connected') {
      setRtt(undefined);
      return;
    }
    const rttInterval = setInterval(() => {
      const currentRtt = wsRef.current.getRtt();
      setRtt(prev => prev === currentRtt ? prev : currentRtt);
      setQuality(wsRef.current.getQuality());
      setJitter(wsRef.current.getJitter());
    }, 5000);
    return () => clearInterval(rttInterval);
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

  // Sync auto-approve state to server whenever it changes.
  // This allows server-side auto-approve to work even when the app is backgrounded.
  useEffect(() => {
    if (connState !== 'connected') return;
    const unsub = useAutoApproveStore.subscribe((state, prevState) => {
      const currentTabs = useTerminalStore.getState().getTabs(serverId);
      for (const tab of currentTabs) {
        if (!tab.sessionId) continue;
        const now = state.enabled[tab.sessionId] ?? false;
        const prev = prevState.enabled[tab.sessionId] ?? false;
        if (now !== prev) {
          wsRef.current.send({
            type: 'client:set_auto_approve',
            sessionId: tab.sessionId,
            payload: { enabled: now },
          } as any);
        }
      }
    });
    // Sync current state on connect (auto-approve + AI sessions may have been set before reconnect)
    const currentTabs = useTerminalStore.getState().getTabs(serverId);
    const autoState = useAutoApproveStore.getState();
    for (const tab of currentTabs) {
      if (!tab.sessionId) continue;
      if (autoState.enabled[tab.sessionId]) {
        wsRef.current.send({
          type: 'client:set_auto_approve',
          sessionId: tab.sessionId,
          payload: { enabled: true },
        } as any);
      }
      // Sync AI tool detection so autopilot knows which sessions have AI
      if (tab.aiTool) {
        wsRef.current.send({
          type: 'client:set_ai_session',
          sessionId: tab.sessionId,
          payload: { hasAi: true },
        } as any);
      }
    }
    return unsub;
  }, [connState, serverId]);

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
    Alert.alert(
      'Terminal schließen',
      'Möchtest du dieses Terminal wirklich schließen?',
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Schließen',
          style: 'destructive',
          onPress: () => {
            pendingCreateRef.current.delete(tabId);
            tabDimsRef.current.delete(tabId);
            setMountedTabs((prev) => { const s = new Set(prev); s.delete(tabId); return s; });
            const { [tabId]: _ob, ...restOb } = outputBuffersRef.current;
            outputBuffersRef.current = restOb;
            setOutputBuffers(restOb);
            const { [tabId]: _la, ...restLa } = lastActivityRef.current;
            lastActivityRef.current = restLa;
            setLastActivity(restLa);
            const tab = useTerminalStore.getState().getTabs(serverId).find((t) => t.id === tabId);
            if (tab?.sessionId) {
              wsRef.current.send({ type: 'terminal:close', sessionId: tab.sessionId });
              clearViewBuffer(tab.sessionId);
              useAutoApproveStore.getState().clear(tab.sessionId);
            }
            // Browser tabs are shared per server — don't clear on individual terminal close
            removeTab(serverId, tabId);
          },
        },
      ],
    );
  }, [serverId, removeTab]);

  const handleRenameTab = useCallback((tabId: string, newName: string) => {
    updateTab(serverId, tabId, { title: newName, customTitle: true });
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
    updateTab(serverId, tabId, { aiTool: tool, category: 'ai' });
    // Inform server that this session has an AI tool (for autopilot auto-dequeue)
    const tab = useTerminalStore.getState().getTabs(serverId).find((t) => t.id === tabId);
    if (tab?.sessionId) {
      wsRef.current.send({ type: 'client:set_ai_session', sessionId: tab.sessionId, payload: { hasAi: !!tool } } as any);
    }
  }, [serverId, updateTab]);

  const handleChangeCategory = useCallback((tabId: string, category: TabCategory, serverType?: ServerType) => {
    updateTab(serverId, tabId, { category, serverType: serverType ?? null, customCategory: true });
  }, [serverId, updateTab]);

  const handleScrollToBottom = useCallback(() => {
    // Read directly from store to avoid stale closure over serverTabs
    const tabs = useTerminalStore.getState().getTabs(serverId);
    const activeTab = tabs.find((t) => t.active);
    if (activeTab) {
      termViewRefs.current.get(activeTab.id)?.scrollToBottom();
    }
  }, [serverId]);

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

  // Path link clicked in terminal — open file browser at that path
  const handlePathClicked = useCallback((path: string) => {
    toolRailRef.current?.openFileBrowser(path);
  }, []);

  // ToolRail action handler — non-panel tools navigate to their own screen
  const handleToolAction = useCallback((toolId: string): boolean => {
    if (toolId === 'scrollToBottom') {
      handleScrollToBottom();
      return true;
    }
    if (toolId === 'drawing') {
      navigation.navigate('Drawing', {
        serverHost: server?.host ?? '',
        serverPort: server?.port ?? 8767,
        serverToken: server?.token ?? '',
      });
      return true;
    }
    if (toolId === 'browser') {
      const activeTab = useTerminalStore.getState().getTabs(serverId).find((t) => t.active);
      if (!activeTab) return false;
      if (!activeTab.browserOpen) updateTab(serverId, activeTab.id, { browserOpen: true });
      navigation.navigate('Browser', {
        serverHost: server?.host ?? '',
        serverId,
        terminalTabId: activeTab.id,
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
  const swipeRef = useRef({ x0: 0, y0: 0, t0: 0, touches: 0 });
  const tabSwipePanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => {
      if (g.numberActiveTouches !== 2) return false;
      // Horizontal swipe (tab switch) or vertical swipe up (tab grid)
      return Math.abs(g.dx) > 20 || (g.dy < -20 && Math.abs(g.dy) > Math.abs(g.dx) * 2);
    },
    onPanResponderGrant: (_, g) => {
      swipeRef.current = { x0: g.x0, y0: g.y0, t0: Date.now(), touches: g.numberActiveTouches };
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

      // Horizontal swipe → switch tabs (within same level)
      if (Math.abs(dx) < 50) return;
      const currentTabs = useTerminalStore.getState().getTabs(serverId);
      const activeTab = currentTabs.find((t) => t.active);
      if (!activeTab) return;

      // Level 1: ai + shell, Level 2: server
      const isServer = activeTab.category === 'server';
      const sameLevelTabs = currentTabs.filter((t) =>
        isServer ? t.category === 'server' : t.category !== 'server',
      );
      const levelIdx = sameLevelTabs.findIndex((t) => t.id === activeTab.id);
      if (levelIdx === -1) return;

      if (dx < -50 && levelIdx < sameLevelTabs.length - 1) {
        Haptics.selectionAsync();
        setActiveTab(serverId, sameLevelTabs[levelIdx + 1].id);
      } else if (dx > 50 && levelIdx > 0) {
        Haptics.selectionAsync();
        setActiveTab(serverId, sameLevelTabs[levelIdx - 1].id);
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
        <View style={styles.serverInfo}>
          <Feather name="server" size={ri(13)} color={colors.primary} />
          <Text style={[styles.serverNameText, { fontSize: rf(15) }]} numberOfLines={1}>
            {serverName}
          </Text>
          <ConnectionStatus state={connState} rtt={rtt} quality={quality} jitter={jitter} />
        </View>
        <View style={[styles.statusRight, { gap: rs(6) }]}>
          {activeTabHasBrowser && (
            <TouchableOpacity
              style={[
                styles.quickAction,
                { width: quickActionSize, height: quickActionSize, borderRadius: rs(7), backgroundColor: colors.accent + '18', borderWidth: 1, borderColor: colors.accent + '50' },
              ]}
              onPress={() => {
                if (!activeTerminalTab) return;
                navigation.navigate('Browser', {
                  serverHost: server?.host ?? '',
                  serverId,
                  terminalTabId: activeTerminalTab.id,
                  openDirect: true,
                });
              }}
              activeOpacity={0.65}
              accessibilityLabel="Browser für diesen Tab"
              accessibilityRole="button"
            >
              <Feather name="globe" size={ri(14)} color={colors.accent} />
            </TouchableOpacity>
          )}
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
        </View>
      </View>
      <ReconnectBanner restoreState={restoreState} />
      <TerminalTabs
        tabs={serverTabs}
        connected={connState === 'connected'}
        onSelect={(id) => setActiveTab(serverId, id)}
        onClose={handleCloseTab}
        onAdd={createNewTab}
        onRename={handleRenameTab}
        onOpenGrid={openGrid}
        onChangeCategory={handleChangeCategory}
      />
      {splitActive ? (
        <SplitLayout
          serverHost={server?.host ?? ''}
          serverId={serverId}
          terminalTabId={activeTerminalTab?.id ?? ''}
          terminalContent={
            <>
              {tabsToRender.map((tab) => (
                <TerminalView
                  key={tab.id}
                  ref={(r) => { if (r) termViewRefs.current.set(tab.id, r); else termViewRefs.current.delete(tab.id); }}
                      sessionId={tab.sessionId}
                  wsService={wsRef.current}
                  visible={tab.active}
                  onReady={(cols, rows) => handleTabReady(tab.id, cols, rows)}
                  onAiToolDetected={(tool) => handleAiToolDetected(tab.id, tool)}
                  rangeActive={tab.active && rangeActive}
                  onRangeClose={() => setRangeActive(false)}
                  onPathClicked={handlePathClicked}
                />
              ))}
              <TerminalToolbar
                sessionId={serverTabs.find((t) => t.active)?.sessionId}
                wsService={wsRef.current}
                rangeActive={rangeActive}
                onRangeToggle={() => setRangeActive((v) => !v)}
                onScrollToBottom={handleScrollToBottom}
                onTranscription={(text) => {
                  const activeTab = serverTabs.find((t) => t.active);
                  if (activeTab) termViewRefs.current.get(activeTab.id)?.injectText(text);
                }}
              />
            </>
          }
        />
      ) : (
        <View style={styles.terminalArea} {...tabSwipePanResponder.panHandlers}>
          {tabsToRender.map((tab) => (
            <TerminalView
              key={tab.id}
              ref={(r) => { if (r) termViewRefs.current.set(tab.id, r); else termViewRefs.current.delete(tab.id); }}
              sessionId={tab.sessionId}
              wsService={wsRef.current}
              visible={tab.active}
              onReady={(cols, rows) => handleTabReady(tab.id, cols, rows)}
              onAiToolDetected={(tool) => handleAiToolDetected(tab.id, tool)}
              rangeActive={tab.active && rangeActive}
              onRangeClose={() => setRangeActive(false)}
              railWidth={railWidthAnim}
              onPathClicked={handlePathClicked}
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
            onScrollToBottom={handleScrollToBottom}
            onTranscription={(text) => {
              const activeTab = serverTabs.find((t) => t.active);
              if (activeTab) termViewRefs.current.get(activeTab.id)?.injectText(text);
            }}
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
  serverInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  serverNameText: {
    color: colors.text,
    fontWeight: '700',
    flexShrink: 1,
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
  terminalArea: {
    flex: 1,
  },
  panelBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
});
