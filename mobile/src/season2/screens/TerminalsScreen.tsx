/**
 * Season 2 Terminals — M1 core: connect to a real server, list real PTY
 * sessions as glass cards (accordion — one expanded with a live TerminalView),
 * create/close/rename sessions (rename via TRIPLE-tap, user requirement),
 * send commands through an input row. Reuses the classic data layer 1:1:
 * getConnection()/terminalStore/TerminalView — no protocol duplication
 * beyond the minimal terminal:create/close/input wiring.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { create } from 'zustand';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types/navigation.types';
import { getConnection, WebSocketService } from '../../services/websocket.service';
import type { ConnectionState } from '../../types/websocket.types';
import { storageService, getToken } from '../../services/storage.service';
import { useTerminalStore } from '../../store/terminalStore';
import type { TerminalTab } from '../../types/terminal.types';
import { TerminalView } from '../../components/TerminalView';
import { GlassSurface } from '../components/GlassSurface';
import { useS2Theme } from '../theme/tokens';
import {
  IconPlus, IconTrash, IconSend, IconMic, IconChevronDown, IconChevronRight, IconServer, IconDot,
} from '../icons';

// ── Season-2 connection state (module store — survives screen remounts) ──

interface S2Server { id: string; name: string; host: string; port: number; token?: string | null }

interface S2ConnState {
  server: S2Server | null;
  token: string | null;
  focusTabId: string | null;
  setServer: (server: S2Server | null, token: string | null) => void;
  setFocusTab: (id: string | null) => void;
}

const useS2ConnStore = create<S2ConnState>((set) => ({
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
}

const SESSION_COLORS = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599'];

export function TerminalsScreen({ navigation, toast }: TerminalsScreenProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const conn = useS2Connection();
  const setServer = useS2ConnStore((s) => s.setServer);
  const tabs = useTerminalStore((s) => (conn.server ? s.tabs[conn.server.id] ?? [] : []));
  const [servers, setServers] = useState<S2Server[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      conn.focusTab(null);
    }
  }, [conn.focusTabId, conn]);

  // Assign sessionIds arriving from the server to the oldest pending tab
  // (same contract as the classic TerminalScreen: 'terminal:created').
  useEffect(() => {
    if (!conn.wsService || !conn.server) return;
    const serverId = conn.server.id;
    const unsub = conn.wsService.addMessageListener((msg: any) => {
      if (msg?.type === 'terminal:created' && msg.sessionId) {
        const pending = useTerminalStore.getState().getTabs(serverId).find((t) => !t.sessionId);
        if (pending) useTerminalStore.getState().updateTab(serverId, pending.id, { sessionId: msg.sessionId });
      } else if (msg?.type === 'terminal:closed' && msg.sessionId) {
        const gone = useTerminalStore.getState().getTabs(serverId).find((t) => t.sessionId === msg.sessionId);
        if (gone) useTerminalStore.getState().removeTab(serverId, gone.id);
      }
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

  // ── Connected: session list (accordion) ──
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.headRow}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>Terminals</Text>
        <Pressable
          onPress={createTerminal}
          accessibilityLabel="Neues Terminal"
          style={({ pressed }) => [styles.headBtn, { borderColor: c.glassBorder, minWidth: m.touch, minHeight: m.touch }, pressed && styles.pressed]}
        >
          <IconPlus size={m.icon.md} color={c.text} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: m.dockHeight + 40 }}>
        {tabs.map((tab, i) => (
          <SessionCard
            key={tab.id}
            tab={tab}
            color={SESSION_COLORS[i % SESSION_COLORS.length]}
            expanded={expandedId === tab.id}
            onToggle={() => setExpandedId(expandedId === tab.id ? null : tab.id)}
            onClose={() => closeTerminal(tab)}
            wsService={conn.wsService!}
            serverId={conn.server!.id}
            toast={toast}
          />
        ))}
        <Pressable onPress={createTerminal} style={({ pressed }) => [pressed && styles.pressed]}>
          <GlassSurface radius={m.radius.pill} style={{ marginTop: 6 }}>
            <View style={styles.addRow}>
              <IconPlus size={m.icon.sm} color={c.accent} />
              <Text style={{ color: c.accent, fontSize: m.font.body, fontWeight: '700' }}>Neues Terminal</Text>
            </View>
          </GlassSurface>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Session card (accordion item) ──

interface SessionCardProps {
  tab: TerminalTab;
  color: string;
  expanded: boolean;
  onToggle: () => void;
  onClose: () => void;
  wsService: WebSocketService;
  serverId: string;
  toast: (msg: string) => void;
}

function SessionCard({ tab, color, expanded, onToggle, onClose, wsService, serverId, toast }: SessionCardProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const [cmd, setCmd] = useState('');
  const tapCount = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const sendCmd = useCallback(() => {
    const data = cmd;
    if (!data.trim() || !tab.sessionId) return;
    wsService.send({ type: 'terminal:input', sessionId: tab.sessionId, payload: { data: data + '\r' } });
    setCmd('');
  }, [cmd, tab.sessionId, wsService]);

  const statusLabel = tab.aiTool ? tab.aiTool : tab.sessionId ? 'Bereit' : 'Startet…';

  return (
    <GlassSurface strong={expanded} style={{ marginBottom: 12 }}>
      <Pressable onPress={onToggle} accessibilityRole="button">
        <View style={styles.cardHead}>
          <View style={[styles.colorTag, { backgroundColor: color }]} />
          {editing ? (
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onBlur={commitRename}
              onSubmitEditing={commitRename}
              autoFocus
              style={[styles.titleInput, { color: c.text, borderColor: c.glassBorder, fontSize: m.font.section }]}
            />
          ) : (
            <Pressable onPress={handleTitleTap} style={{ flex: 1, minWidth: 0 }} accessibilityHint="Dreifach tippen zum Umbenennen">
              <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.section, fontWeight: '700' }}>{tab.title}</Text>
            </Pressable>
          )}
          <View style={[styles.chip, { backgroundColor: `rgba(${c.accentRgb},0.10)`, borderColor: c.glassBorder }]}>
            <IconDot size={8} color={tab.sessionId ? c.ok : c.warn} />
            <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '700' }}>{statusLabel.toUpperCase()}</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Terminal schließen" style={({ pressed }) => [pressed && styles.pressed]}>
            <IconTrash size={m.icon.sm} color={c.textDim} />
          </Pressable>
          <IconChevronDown size={m.icon.sm} color={c.textDim} />
        </View>
      </Pressable>

      {expanded && (
        <View>
          <View style={[styles.termWrap, { backgroundColor: c.termSurface }]}>
            {tab.sessionId ? (
              <TerminalView
                sessionId={tab.sessionId}
                wsService={wsService}
                visible={expanded}
                disableKeyboardOffset
                tapFocusDisabled
              />
            ) : (
              <View style={styles.termPending}>
                <Text style={{ color: c.textDim, fontSize: m.font.caption }}>Session wird gestartet…</Text>
              </View>
            )}
          </View>
          <View style={[styles.inputRow, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
            <Text style={{ color: c.textDim, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: m.font.body }}>$</Text>
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
            <Pressable onPress={() => toast('Diktat kommt in Meilenstein 2')} hitSlop={6} accessibilityLabel="Diktieren">
              <IconMic size={m.icon.md} color={c.textDim} />
            </Pressable>
            <Pressable
              onPress={sendCmd}
              hitSlop={6}
              accessibilityLabel="Senden"
              style={({ pressed }) => [styles.sendBtn, { backgroundColor: `rgba(${c.accentRgb},0.18)` }, pressed && styles.pressed]}
            >
              <IconSend size={m.icon.sm} color={c.accent} />
            </Pressable>
          </View>
        </View>
      )}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  pickerWrap: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 120 },
  pageTitle: { fontWeight: '800', letterSpacing: 0.2 },
  serverCard: { marginBottom: 12, padding: 16 },
  serverRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  headBtn: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 14 },
  addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  colorTag: { width: 10, height: 10, borderRadius: 5 },
  titleInput: { flex: 1, borderBottomWidth: 1, paddingVertical: 2, fontWeight: '700' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  termWrap: { height: 340, marginHorizontal: 10, borderRadius: 14, overflow: 'hidden' },
  termPending: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  cmdInput: { flex: 1, paddingVertical: 6, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
