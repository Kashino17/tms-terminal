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
import { checkForUpdate, downloadAndInstall, getCurrentVersion } from '../services/updater.service';
import { getConnection } from '../services/websocket.service';
import { useS2ConnStore, useS2Connection } from './screens/TerminalsScreen';
import { useDictation } from './hooks/useDictation';
import { useManagerWire } from './manager/useManagerWire';
import { useManagerStore } from '../store/managerStore';
import { useManagerBridge, useCloudBridge } from './web/useSeasonTwoBackends';
import { useSheetBridges } from './web/useSheetBridges';
import { NativeBrowserLayer, type BrowserRect } from './web/NativeBrowserLayer';
import { getViewBuffer, recordViewBuffer } from '../components/TerminalView';
import { hydrateScrollback, getScrollback, appendScrollback, dropScrollback } from './web/scrollbackStore';
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

  /** FIFO der terminal:create-Anfragen — der Server antwortet in Reihenfolge.
   *  Ein Einzelwert ordnete bei mehreren gleichzeitigen Creates falsch zu. */
  const pendingCards = useRef<Array<{ cardId: string; name?: string }>>([]);
  /** cardId whose mic is currently recording. */
  const micCard = useRef<string | null>(null);
  /** Set when the user cancels: the recording still stops, its text is dropped. */
  const micDiscard = useRef(false);
  const restored = useRef(false);
  /** Per-session "is it still producing output" timers — the server has no
   *  status event, so the state has to be derived from the stream itself. */
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const updateUrl = useRef<string | null>(null);
  const [browser, setBrowser] = useState<BrowserOverlay>({ visible: false, tabId: null, url: '', rect: null });

  // Die gesicherte Historie muss da sein, BEVOR das erste Terminal anhängt.
  const scrollbackReady = useRef(false);
  const [scrollbackTick, setScrollbackTick] = useState(0);
  useEffect(() => {
    hydrateScrollback().then(() => {
      scrollbackReady.current = true;
      setScrollbackTick((n) => n + 1); // stößt das Wiederherstellen an
    });
  }, []);

  const call = useCallback((fn: string, ...args: unknown[]) => {
    const js = `window.TMSBridge && window.TMSBridge.${fn}(${args.map((a) => JSON.stringify(a)).join(',')});true;`;
    webRef.current?.injectJavaScript(js);
  }, []);

  // Manager answers must land in the store even while another screen is open.
  useManagerWire(wsService);
  const sendManager = useManagerBridge(wsService, ready, call);
  const { loadProjects: loadCloud, loadDetail: loadCloudDetail } = useCloudBridge(ready, call);
  const activeSessionId = useTerminalStore((s) =>
    server ? (s.tabs[server.id] ?? []).find((t) => t.active)?.sessionId ?? (s.tabs[server.id] ?? [])[0]?.sessionId : undefined,
  );
  const sheets = useSheetBridges({ ready, call, wsService, server, token, activeSessionId });

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

  /** Output means the tool is working; silence for a while means it is done. */
  const markBusy = useCallback((sessionId: string) => {
    call('setSessionStatus', sessionId, 'running');
    clearTimeout(idleTimers.current[sessionId]);
    idleTimers.current[sessionId] = setTimeout(() => {
      call('setSessionStatus', sessionId, 'idle');
    }, 2500);
  }, [call]);

  // ── Server → page.
  useEffect(() => {
    if (!wsService || !server || !ready) return;

    const unsub = wsService.addMessageListener((m: any) => {
      if (m?.type === 'terminal:output' && m.sessionId && m.payload?.data) {
        recordViewBuffer(m.sessionId, m.payload.data);
        appendScrollback(m.sessionId, m.payload.data);
        call('output', m.sessionId, m.payload.data);
        markBusy(m.sessionId);
        return;
      }
      if (m?.type === 'terminal:created' && m.sessionId) {
        const pending = pendingCards.current.shift();
        const cardId = pending?.cardId ?? null;
        useTerminalStore.getState().addTab(server.id, {
          id: cardId ?? m.sessionId,
          sessionId: m.sessionId,
          title: pending?.name ?? cardId ?? 'Terminal',
          serverId: server.id,
          active: true,
        });
        if (cardId) {
          call('bindSession', cardId, m.sessionId);
          sheets.pushNotes(cardId);
          const on = useAutoApproveStore.getState().enabled[m.sessionId] ?? true; // Standard: an
          useAutoApproveStore.getState().setEnabled(m.sessionId, on);
          wsService.send({ type: 'client:set_auto_approve', sessionId: m.sessionId, payload: { enabled: on } });
          call('setAutoApprove', cardId, on);
        }
        return;
      }
      if (m?.type === 'terminal:closed' && m.sessionId) {
        const tab = useTerminalStore.getState().getTabs(server.id).find((t) => t.sessionId === m.sessionId);
        if (tab) useTerminalStore.getState().removeTab(server.id, tab.id);
        dropScrollback(m.sessionId);
        call('sessionClosed', m.sessionId); // die Seite räumt die Karte weg
        return;
      }
      if (m?.type === 'manager:memory_data' && m.payload?.memory) {
        const mem = m.payload.memory;
        const items: Array<{ id: string; text: string; time: string }> = [];
        for (const j of mem.journal ?? []) items.push({ id: `j-${j.date}`, text: j.text, time: j.date });
        for (const i of mem.insights ?? []) items.push({ id: `i-${i.date}-${i.text.slice(0, 12)}`, text: i.text, time: i.date });
        call('setManagerMemory', items.slice(-40).reverse());
        return;
      }
      if (m?.type === 'terminal:error' && m.sessionId && m.sessionId !== 'none') {
        // "Session not found": die gespeicherte Session gibt es nicht mehr. Wie
        // die klassische App: toten Tab austragen und die Karte neu bestücken —
        // die Seite fordert daraufhin eine frische PTY für dieselbe Karte an.
        const dead = useTerminalStore.getState().getTabs(server.id).find((t) => t.sessionId === m.sessionId);
        if (dead) useTerminalStore.getState().removeTab(server.id, dead.id);
        dropScrollback(m.sessionId);
        call('sessionExpired', m.sessionId);
        return;
      }
      if (m?.type === 'terminal:prompt_detected' && m.sessionId) {
        // Auto-Approve führt der SERVER aus (chooseApprovalKey: Enter für
        // nummerierte Prompts, 'y' bei [y/N], nie automatisch bei Freitext).
        // Er meldet nur, was er nicht selbst beantworten konnte oder durfte.
        const sid = m.sessionId as string;
        const info = describePrompt(m.payload?.snippet ?? '');
        const autoOn = useAutoApproveStore.getState().enabled[sid] ?? true;

        call('setSessionStatus', sid, 'waiting');

        // Echte Rückfragen (Auswahl / Freitext) darf niemand automatisch
        // beantworten — die kommen IMMER vor den Nutzer.
        if (info.kind === 'question') {
          useTerminalStore.getState().setTabNotification(server.id, sid);
          call('prompt', sid, info);
          return;
        }
        // Reine Berechtigung bei aktivem Auto-Approve: kein Fenster. Genau das
        // soll Auto-Approve ja ersparen — der Server hat es entweder schon
        // bestätigt oder bewusst pausiert (etwa weil gerade getippt wird).
        if (autoOn) return;

        useTerminalStore.getState().setTabNotification(server.id, sid);
        call('prompt', sid, info);
        return;
      }
    });
    return unsub;
  }, [wsService, server, ready, call, markBusy]);

  useEffect(() => () => {
    Object.values(idleTimers.current).forEach(clearTimeout);
  }, []);

  // ── Connection state → the Dynamic Island + latency chips.
  useEffect(() => {
    if (!ready) return;
    const label = state === 'connected' ? 'Verbunden' : state === 'connecting' ? 'Verbinde…' : 'Getrennt';
    const kind = state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : 'idle';
    call('setStatus', { kind, label, latency: rtt, name: server?.name ?? '' });
  }, [ready, state, rtt, server, call]);

  // ── The Server screen and its update banner, on real data.
  const updateChecked = useRef(0);
  useEffect(() => {
    if (!ready || state !== 'connected') return;
    let cancelled = false;
    (async () => {
      const servers = await storageService.getServers().catch(() => []);
      if (cancelled) return;
      call('setServers', servers.map((s) => ({
        id: s.id, name: s.name, host: s.host, port: s.port,
        status: s.id === server?.id ? 'online' : 'offline',
        sessions: useTerminalStore.getState().getTabs(s.id).length,
        os: '',
        latency: null, // die Seite pflegt die Latenz selbst (setStatus-Ticker)
      })));

      // Höchstens alle 30 Minuten: vorher hing `rtt` in den Abhängigkeiten,
      // der Effekt lief bei JEDEM RTT-Tick (alle 3s) und hämmerte die
      // GitHub-API — nach ~3 Minuten griff deren Rate-Limit (60/h) und das
      // Update-Banner erschien NIE wieder. Genau so blieb der Nutzer auf
      // alten Versionen hängen.
      if (Date.now() - updateChecked.current < 30 * 60_000) return;
      updateChecked.current = Date.now();
      const up = await checkForUpdate().catch(() => null);
      if (cancelled || !up) return; // null heißt auch: schon aktuell
      updateUrl.current = up.downloadUrl;
      call('setUpdate', { current: getCurrentVersion(), latest: up.version, notes: up.changelog });
    })();
    return () => { cancelled = true; };
  }, [ready, server, state, call]);

  // ── Nach jedem RECONNECT neu anhängen. Der Server hängt Sessions beim
  //    Verbindungsabriss ab und puffert ihren Output — ohne Reattach bliebe
  //    jede Karte für immer beim letzten Frame stehen, während der Kopf
  //    "Verbunden" zeigt. Genau so sah eine gesendete Nachricht "nicht
  //    abgeschickt" aus. (Der Erst-Anlauf läuft über restoreSessions unten.)
  const prevConnState = useRef(state);
  useEffect(() => {
    if (ready && restored.current && state === 'connected' && prevConnState.current !== 'connected') {
      call('reattachAll');
    }
    prevConnState.current = state;
  }, [ready, state, call]);

  // ── Once connected, hand the page the sessions that already exist.
  useEffect(() => {
    if (!ready || !server || state !== 'connected' || restored.current) return;
    if (!scrollbackReady.current) return; // sonst hingen die Karten leer da
    restored.current = true;
    const live = useTerminalStore
      .getState()
      .getTabs(server.id)
      .filter((t) => t.sessionId)
      .map((t) => ({ sessionId: t.sessionId as string, name: t.title }));
    if (!live.length) return;
    call('restoreSessions', live);
    // The page names restored cards t1..tN, in order.
    live.forEach((t, i) => {
      const cardId = `t${i + 1}`;
      sheets.pushNotes(cardId);
      call('setAutoApprove', cardId, useAutoApproveStore.getState().enabled[t.sessionId] ?? true);
    });
  }, [ready, server, state, call, sheets, scrollbackTick]);

  // ── Dictation: the page shows the mic states, the recorder lives here.
  const { micState, toggle: toggleMic } = useDictation({
    wsService: wsService ?? null,
    // Without this the hook returns immediately and nothing is ever recorded.
    sessionId: activeSessionId,
    onText: (text: string) => {
      const card = micCard.current;
      micCard.current = null;
      if (micDiscard.current) { micDiscard.current = false; return; } // abgebrochen
      if (card === MANAGER_MIC) sendManager(text);
      else call('dictationResult', card ?? '', text);
    },
    onError: (msg: string) => {
      const card = micCard.current;
      micCard.current = null;
      micDiscard.current = false;
      if (card !== MANAGER_MIC) call('dictationResult', card ?? '', '');
      call('toast', msg);
    },
  });

  useEffect(() => {
    if (ready && micState === 'processing') call('dictationTranscribing');
  }, [ready, micState, call]);

  // ── Page → app.
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: { type: string; payload: any };
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    const { type, payload } = msg;

    if (type === 'bridge:ready') { setReady(true); return; }
    if (!wsService || !server) return;
    if (sheets.handle(type, payload)) return;

    switch (type) {
      case 'terminal:create':
        pendingCards.current.push({ cardId: payload.cardId, name: payload.name });
        // Mit den echten Maßen der Karte, nicht mit 80x24: sonst muss die Shell
        // beim ersten Resize alles neu zeichnen — und genau das erzeugt die
        // doppelten und zerrissenen Zeilen.
        wsService.send({
          type: 'terminal:create',
          payload: { cols: payload.cols || 80, rows: payload.rows || 24 },
        });
        break;

      case 'terminal:attach':
        wsService.send({
          type: 'terminal:reattach',
          sessionId: payload.sessionId,
          // `?? 80` would let a 0 through — the server rejects that and the
          // terminal would never receive a single byte.
          payload: { cols: payload.cols || 80, rows: payload.rows || 24 },
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
        if (payload.sessionId) {
          const on = !!payload.enabled;
          useAutoApproveStore.getState().setEnabled(payload.sessionId, on);
          // ENTSCHEIDEND: der Server führt Auto-Approve aus, nicht wir. Er kennt
          // die Prompt-Varianten ([y/N] braucht 'y', nicht Enter!), blockt bei
          // ungesendetem Text und läuft auch, wenn die App im Hintergrund ist.
          // Ohne diese Zeile war der Schalter reine Dekoration.
          wsService.send({ type: 'client:set_auto_approve', sessionId: payload.sessionId, payload: { enabled: on } });
        }
        break;

      case 'mic:start':
        micCard.current = payload.cardId;
        micDiscard.current = false;
        toggleMic(); // start
        break;

      case 'mic:stop':
        // The bar shows "Transkribiere…" until onText lands.
        toggleMic(); // stop -> upload -> Whisper
        break;

      case 'mic:cancel':
        micDiscard.current = true;
        toggleMic(); // stop the recorder, then throw the transcript away
        break;

      case 'clipboard:write':
        Clipboard.setStringAsync(payload.text ?? '').then(() => call('toast', 'Kopiert'));
        break;

      case 'manager:send':
        sendManager(payload.text);
        break;

      case 'manager:mic':
        micCard.current = MANAGER_MIC;
        micDiscard.current = false;
        toggleMic();
        break;

      case 'cloud:open':
        loadCloudDetail(payload.projectId);
        break;

      case 'nav:screen':
        if (payload.screen === 'cloud') loadCloud();
        if (payload.screen === 'manager') {
          // Memory frisch vom Server; Artefakte aus den Manager-Nachrichten
          // (Bilder/Präsentationen), antippbar über den In-App-Browser.
          wsService.send({ type: 'manager:memory_read' });
          const msgs = useManagerStore.getState().messages ?? [];
          const arts: Array<{ id: string; title: string; kind: string; time: string; url: string }> = [];
          for (const msg of msgs) {
            const when = new Date(msg.timestamp).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            for (const f of msg.images ?? []) {
              arts.push({ id: `img-${f}`, title: f, kind: 'Bild', time: when,
                url: `http://${server.host}:${server.port}/generated-images/${encodeURIComponent(f)}?token=${token}` });
            }
            for (const f of msg.presentations ?? []) {
              arts.push({ id: `prs-${f}`, title: f, kind: 'Präsentation', time: when,
                url: `http://${server.host}:${server.port}/generated-presentations/${encodeURIComponent(f)}?token=${token}` });
            }
          }
          call('setManagerArtifacts', arts.reverse());
        }
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

      case 'terminal:rename': {
        const tab = useTerminalStore.getState().getTabs(server.id).find((t) => t.id === payload.cardId);
        if (tab && payload.field === 'name' && payload.value) {
          useTerminalStore.getState().updateTab(server.id, tab.id, { title: payload.value });
        }
        break;
      }

      case 'update:install':
        if (updateUrl.current) {
          call('toast', 'Update wird geladen …');
          downloadAndInstall(updateUrl.current).catch(() => call('toast', 'Update fehlgeschlagen'));
        }
        break;

      case 'nav:classic':
        if (payload.screen === 'settings') navigation.navigate('Settings');
        else setSeasonTwoEnabled(false);
        break;
    }
  }, [wsService, server, toggleMic, call, navigation, setSeasonTwoEnabled, sendManager, loadCloud, loadCloudDetail, sheets]);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <WebView
        ref={webRef}
        source={{ html: LIQUID_DECK_HTML, baseUrl: 'http://tms.local' }}
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

/**
 * The server reports a detected prompt as a raw text snippet; the permission
 * sheet wants a tool, a target and a question. Pull those out of the snippet —
 * and when they are not in there, show the snippet rather than an empty sheet.
 */
interface PromptOption { id: string; label: string; description?: string }

/**
 * Der Server meldet eine Rückfrage nur als rohen Textausschnitt. Hier wird
 * entschieden, WAS es ist — und danach, welches Fenster erscheint:
 *
 *   kind 'question'  -> Auswahl-Sheet (Optionen, Mehrfachauswahl, Freitext).
 *                       Von Auto-Approve grundsätzlich ausgenommen.
 *   sonst            -> Berechtigungs-Sheet (Erlauben / Ablehnen).
 *
 * Die Erkennung spiegelt bewusst chooseApprovalKey des Servers: nur was der
 * Server NICHT selbst beantworten würde, landet als echte Frage beim Nutzer.
 */
function describePrompt(snippet: string): {
  tool: string; target: string; question: string; kind?: string;
  options?: PromptOption[]; multiSelect?: boolean;
} {
  const clean = snippet.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const flat = clean.replace(/\s+/g, ' ');

  const tool = clean.match(/\b(Bash|Edit|MultiEdit|Write|Read|WebFetch|WebSearch|Task|Grep|Glob|NotebookEdit)\b/)?.[1] ?? 'Berechtigung';
  const target =
    clean.match(/`([^`]{1,80})`/)?.[1] ??
    clean.match(/(?:in|to|from)\s+([\w./-]+\.[a-z]{1,5})/i)?.[1] ??
    '';

  // Optionen: "❯ 1. Ja", "2) Nein", auch ANSI-verklebt ("1.Yes").
  const options: PromptOption[] = [];
  for (const l of lines) {
    const m = l.match(/^(?:❯|>)?\s*([1-9])[.)]\s*(?:\[[ xX]\]\s*)?(.+)$/);
    if (m && m[2].length > 1) options.push({ id: m[1], label: m[2].trim() });
  }

  // Eine reine Ja/Nein-Berechtigung erkennt man an der Ja-Option bzw. an [y/N].
  // Alles andere mit >= 2 Optionen ist eine ECHTE Frage (Multiple Choice).
  const looksLikePermission =
    /1\.?\s*(Yes|Ja)\b/i.test(flat) || /\[y\/n\]/i.test(flat) || /Esc\s*to\s*cancel/i.test(flat);
  // Freitext-Prompt ("Frage? ›") ohne Optionen: auch eine echte Frage.
  // ABER: "[y/N]" endet ebenfalls auf "? [" — das ist eine Berechtigung, keine
  // Frage. Deshalb wird sie hier ausdrücklich ausgenommen.
  const freeText =
    !looksLikePermission && options.length === 0 && /\?\s*(›|>|\[|\()/.test(flat);

  const isQuestion = (options.length >= 2 && !looksLikePermission) || freeText;
  const multiSelect = /\[[ xX]\]/.test(clean);

  const question =
    lines.find((l) => l.endsWith('?')) ??
    lines.find((l) => !/^[1-9❯>]/.test(l)) ??
    lines[0] ?? 'Erlauben?';

  return {
    tool,
    target,
    question,
    kind: isQuestion ? 'question' : undefined,
    options: isQuestion && options.length ? options : undefined,
    multiSelect,
  };
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1e2126' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
