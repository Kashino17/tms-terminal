/**
 * Season 2 — the mockup IS the app.
 *
 * The Liquid-Deck design runs as-is inside a WebView (see
 * scripts/build-season2-html.js); this component is the other half of the
 * bridge: it owns the WebSocket, the PTY sessions, the microphone and the
 * clipboard, and speaks to the page through window.TMSBridge.
 *
 * The classic UI is untouched — Season 2 is still just a settings toggle.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';
import { useSettingsStore } from '../store/settingsStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAutoApproveStore } from '../store/autoApproveStore';
import { storageService, getToken } from '../services/storage.service';
import { getConnection } from '../services/websocket.service';
import { useS2ConnStore, useS2Connection } from './screens/TerminalsScreen';
import { useDictation } from './hooks/useDictation';
import { useManagerWire } from './manager/useManagerWire';
import { useManagerBridge, useCloudBridge } from './web/useSeasonTwoBackends';
import { NativeBrowserLayer, type BrowserRect } from './web/NativeBrowserLayer';
import { LIQUID_DECK_HTML } from './web/liquidDeckHtml';

interface BrowserOverlay { visible: boolean; tabId: string | null; url: string; rect: BrowserRect | null }

interface Props {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonTwo'>;
}

export function SeasonTwoWebRoot({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const { server, token, wsService, state, rtt } = useS2Connection();
  const setServer = useS2ConnStore((s) => s.setServer);
  const setSeasonTwoEnabled = useSettingsStore((s) => s.setSeasonTwoEnabled);

  /** cardId of the terminal:create we are still waiting on a sessionId for. */
  const pendingCard = useRef<string | null>(null);
  /** cardId whose mic is currently recording. */
  const micCard = useRef<string | null>(null);
  const restored = useRef(false);
  const [browser, setBrowser] = useState<BrowserOverlay>({ visible: false, tabId: null, url: '', rect: null });

  const call = useCallback((fn: string, ...args: unknown[]) => {
    const js = `window.TMSBridge && window.TMSBridge.${fn}(${args.map((a) => JSON.stringify(a)).join(',')});true;`;
    webRef.current?.injectJavaScript(js);
  }, []);

  // Manager answers must land in the store even while another screen is open.
  useManagerWire(wsService);
  const sendManager = useManagerBridge(wsService, ready, call);
  const { loadProjects: loadCloud, loadDetail: loadCloudDetail } = useCloudBridge(ready, call);

  // ── Pick up the saved server (the WebView has no server picker of its own).
  useEffect(() => {
    if (server) return;
    let cancelled = false;
    (async () => {
      const servers = await storageService.getServers().catch(() => []);
      if (cancelled || !servers.length) return;
      const s = servers[0];
      const tok = s.token ?? (await getToken(s.id)) ?? null;
      setServer({ id: s.id, name: s.name, host: s.host, port: s.port, token: tok }, tok);
    })();
    return () => { cancelled = true; };
  }, [server, setServer]);

  useEffect(() => {
    if (!server || !token) return;
    const conn = getConnection(server.id);
    if (conn.state === 'disconnected') conn.connect({ host: server.host, port: server.port, token });
  }, [server, token]);

  // ── Server → page.
  useEffect(() => {
    if (!wsService || !server || !ready) return;

    const unsub = wsService.addMessageListener((m: any) => {
      if (m?.type === 'terminal:output' && m.sessionId && m.payload?.data) {
        call('output', m.sessionId, m.payload.data);
        return;
      }
      if (m?.type === 'terminal:created' && m.sessionId) {
        const cardId = pendingCard.current;
        pendingCard.current = null;
        useTerminalStore.getState().addTab(server.id, {
          id: cardId ?? m.sessionId,
          sessionId: m.sessionId,
          title: cardId ?? 'Terminal',
          serverId: server.id,
          active: true,
        });
        if (cardId) call('bindSession', cardId, m.sessionId);
        return;
      }
      if (m?.type === 'terminal:closed' && m.sessionId) {
        const tab = useTerminalStore.getState().getTabs(server.id).find((t) => t.sessionId === m.sessionId);
        if (tab) useTerminalStore.getState().removeTab(server.id, tab.id);
        return;
      }
      if (m?.type === 'terminal:prompt_detected' && m.sessionId) {
        // Auto-Approve has to keep working while the terminals screen is not
        // even visible, so it is resolved here and not inside the page.
        const auto = useAutoApproveStore.getState();
        const sid = m.sessionId as string;
        const armed = auto.isEnabled(sid) && !auto.isRunning(sid) && !auto.isTyping(sid);
        const question = m.payload?.kind === 'question';
        if (armed && !question && !m.payload?.hasPendingInput) {
          auto.setRunning(sid, true);
          wsService.send({ type: 'terminal:input', sessionId: sid, payload: { data: '\r' } });
          setTimeout(() => auto.setRunning(sid, false), 500);
        } else {
          call('prompt', sid, m.payload ?? {});
        }
        return;
      }
      if (m?.type === 'terminal:status' && m.sessionId && m.payload?.status) {
        call('setSessionStatus', m.sessionId, m.payload.status);
      }
    });
    return unsub;
  }, [wsService, server, ready, call]);

  // ── Connection state → the Dynamic Island + latency chips.
  useEffect(() => {
    if (!ready) return;
    const label = state === 'connected' ? 'Verbunden' : state === 'connecting' ? 'Verbinde…' : 'Getrennt';
    const kind = state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : 'idle';
    call('setStatus', { kind, label, latency: rtt, name: server?.name ?? '' });
  }, [ready, state, rtt, server, call]);

  // ── Once connected, hand the page the sessions that already exist.
  useEffect(() => {
    if (!ready || !server || state !== 'connected' || restored.current) return;
    restored.current = true;
    const live = useTerminalStore
      .getState()
      .getTabs(server.id)
      .filter((t) => t.sessionId)
      .map((t) => ({ sessionId: t.sessionId as string }));
    if (live.length) call('restoreSessions', live);
  }, [ready, server, state, call]);

  // ── Dictation: the page shows the mic states, the recorder lives here.
  const { toggle: toggleMic } = useDictation({
    wsService: wsService ?? null,
    sessionId: undefined,
    onText: (text: string) => {
      if (micCard.current === MANAGER_MIC) sendManager(text);
      else call('dictationResult', micCard.current ?? '', text);
      micCard.current = null;
    },
    onError: (msg: string) => {
      if (micCard.current !== MANAGER_MIC) call('dictationResult', micCard.current ?? '', '');
      call('toast', msg);
      micCard.current = null;
    },
  });

  // ── Page → app.
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: { type: string; payload: any };
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    const { type, payload } = msg;

    if (type === 'bridge:ready') { setReady(true); return; }
    if (!wsService || !server) return;

    switch (type) {
      case 'terminal:create':
        pendingCard.current = payload.cardId;
        wsService.send({ type: 'terminal:create', payload: { cols: 80, rows: 24 } });
        break;

      case 'terminal:attach':
        wsService.send({
          type: 'terminal:reattach',
          sessionId: payload.sessionId,
          payload: { cols: payload.cols ?? 80, rows: payload.rows ?? 24 },
        });
        break;

      case 'terminal:input':
        useAutoApproveStore.getState().markTyping(payload.sessionId);
        wsService.send({ type: 'terminal:input', sessionId: payload.sessionId, payload: { data: payload.data } });
        break;

      case 'terminal:resize':
        wsService.send({
          type: 'terminal:resize',
          sessionId: payload.sessionId,
          payload: { cols: payload.cols, rows: payload.rows },
        });
        break;

      case 'terminal:close':
        if (payload.sessionId) wsService.send({ type: 'terminal:close', sessionId: payload.sessionId });
        break;

      case 'autoapprove:set':
        if (payload.sessionId) useAutoApproveStore.getState().setEnabled(payload.sessionId, !!payload.enabled);
        break;

      case 'mic:start':
        micCard.current = payload.cardId;
        toggleMic();
        break;

      case 'clipboard:write':
        Clipboard.setStringAsync(payload.text ?? '').then(() => call('toast', 'Kopiert'));
        break;

      case 'manager:send':
        sendManager(payload.text);
        break;

      case 'manager:mic':
        micCard.current = MANAGER_MIC;
        toggleMic();
        break;

      case 'cloud:open':
        loadCloudDetail(payload.projectId);
        break;

      case 'nav:screen':
        if (payload.screen === 'cloud') loadCloud();
        break;

      case 'browser:sync':
        setBrowser({
          visible: !!payload.visible,
          tabId: payload.tabId ?? null,
          url: payload.url ?? '',
          rect: payload.rect ?? null,
        });
        break;

      case 'browser:closeTab':
        setBrowser((b) => (b.tabId === payload.tabId ? { ...b, visible: false, tabId: null } : b));
        break;

      case 'nav:classic':
        if (payload.screen === 'settings') navigation.navigate('Settings');
        else setSeasonTwoEnabled(false);
        break;
    }
  }, [wsService, server, toggleMic, call, navigation, setSeasonTwoEnabled, sendManager, loadCloud, loadCloudDetail]);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <WebView
        ref={webRef}
        source={{ html: LIQUID_DECK_HTML, baseUrl: 'https://tms.local' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        // The page brings its own scrolling, gestures and pull-to-spotlight.
        scrollEnabled={false}
        overScrollMode="never"
        bounces={false}
        setSupportMultipleWindows={false}
        style={styles.web}
      />
      <NativeBrowserLayer
        visible={browser.visible}
        tabId={browser.tabId}
        url={browser.url}
        rect={browser.rect}
        serverHost={server?.host}
        onTitle={(tabId, title, url) => call('browserTitle', tabId, title, url)}
      />
    </View>
  );
}

/** Sentinel cardId: the mic that belongs to the Manager chat, not a terminal. */
const MANAGER_MIC = '__manager__';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1e2126' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
