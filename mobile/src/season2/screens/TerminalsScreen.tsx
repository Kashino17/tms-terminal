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
import { getConnection, WebSocketService } from '../../services/websocket.service';
import type { ConnectionState } from '../../types/websocket.types';
import { storageService, getToken } from '../../services/storage.service';
import { useTerminalStore } from '../../store/terminalStore';
import { useAutoApproveStore } from '../../store/autoApproveStore';
import type { TerminalTab } from '../../types/terminal.types';
import { TerminalView, TerminalViewRef } from '../../components/TerminalView';
import { GlassSurface } from '../components/GlassSurface';
import { QuickKeys } from '../components/QuickKeys';
import { PromptSheet, PendingPrompt } from '../components/PromptSheet';
import { OverviewGrid } from '../components/OverviewGrid';
import { NotesSheet } from '../components/NotesSheet';
import { useDictation } from '../hooks/useDictation';
import { useS2Theme } from '../theme/tokens';
import {
  IconPlus, IconTrash, IconSend, IconMic, IconChevronDown, IconChevronRight, IconServer, IconDot,
  IconList, IconStack, IconGrid, IconEdit,
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
const VIEW_KEY = 'tms-s2-terminal-view';
type S2View = 'list' | 'stack';

export function TerminalsScreen({ navigation, toast }: TerminalsScreenProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const conn = useS2Connection();
  const setServer = useS2ConnStore((s) => s.setServer);
  const tabs = useTerminalStore((s) => (conn.server ? s.tabs[conn.server.id] ?? [] : []));
  const [servers, setServers] = useState<S2Server[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<S2View>('list');
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [notesFor, setNotesFor] = useState<{ tabId: string; title: string; color: string } | null>(null);
  const autoTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

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
    const timers = autoTimers.current;
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
      } else if (msg?.type === 'terminal:prompt_detected' && msg.sessionId) {
        // Same guards as the classic TerminalScreen: skip when the user is
        // typing or has unsent input, throttle back-to-back prompts.
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
      }
    });
    return () => {
      unsub();
      timers.forEach(clearTimeout);
      timers.clear();
    };
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

  // Stack view keeps exactly one session in focus.
  const stackTab = tabs.find((t) => t.id === expandedId) ?? tabs[0] ?? null;

  // ── Connected ──
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.chipStrip}>
            {tabs.map((tab, i) => {
              const isActive = stackTab?.id === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => setExpandedId(tab.id)}
                  style={[styles.chip, { borderColor: isActive ? `rgba(${c.accentRgb},0.5)` : c.glassBorder, backgroundColor: isActive ? `rgba(${c.accentRgb},0.14)` : `rgba(${c.overlayRgb},0.05)` }]}
                >
                  <IconDot size={8} color={SESSION_COLORS[i % SESSION_COLORS.length]} />
                  <Text numberOfLines={1} style={{ color: isActive ? c.text : c.textDim, fontSize: m.font.caption, fontWeight: '700', maxWidth: 140 }}>
                    {tab.title || 'Terminal'}
                  </Text>
                  {!!tab.notificationCount && <View style={[styles.badge, { backgroundColor: c.warn }]} />}
                </Pressable>
              );
            })}
          </ScrollView>
          {stackTab && (
            <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 16, paddingBottom: m.dockHeight + 34 }}>
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
            </View>
          )}
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: m.dockHeight + 40 }}>
          {tabs.map((tab, i) => (
            <SessionCard
              key={tab.id}
              tab={tab}
              color={SESSION_COLORS[i % SESSION_COLORS.length]}
              expanded={expandedId === tab.id}
              onToggle={() => {
                LayoutAnimation.configureNext(SPRING_LAYOUT);
                setExpandedId(expandedId === tab.id ? null : tab.id);
              }}
              onClose={() => closeTerminal(tab)}
              onNotes={(color) => setNotesFor({ tabId: tab.id, title: tab.title, color })}
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
      )}

      {overviewOpen && (
        <OverviewGrid
          tabs={tabs}
          colors={SESSION_COLORS}
          onSelect={(tabId) => { setExpandedId(tabId); setOverviewOpen(false); }}
          onClose={() => setOverviewOpen(false)}
        />
      )}

      {pendingPrompt && (
        <PromptSheet
          prompt={pendingPrompt}
          onApprove={approvePrompt}
          onDismiss={() => setPendingPrompt(null)}
          onEnableAuto={enableAutoForPrompt}
          bottomOffset={m.dockHeight + 40}
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
  wsService: WebSocketService;
  serverId: string;
  toast: (msg: string) => void;
}

function SessionCard({ tab, color, expanded, full = false, onToggle, onClose, onNotes, wsService, serverId, toast }: SessionCardProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const [cmd, setCmd] = useState('');
  const tapCount = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const termRef = useRef<TerminalViewRef>(null);
  const autoOn = useAutoApproveStore((s) => (tab.sessionId ? s.isEnabled(tab.sessionId) : false));
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

  const statusLabel = tab.aiTool ? tab.aiTool : tab.sessionId ? 'Bereit' : 'Startet…';

  return (
    <GlassSurface strong={expanded} style={full ? { flex: 1, minHeight: 0 } : { marginBottom: 12 }}>
      <Pressable onPress={full ? undefined : onToggle} accessibilityRole="button" disabled={full}>
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
          <Pressable
            onPress={() => onNotes(color)}
            hitSlop={6}
            accessibilityLabel="Notizen und Todos"
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <IconEdit size={m.icon.sm} color={c.textDim} />
          </Pressable>
          <Pressable
            onPress={toggleAuto}
            accessibilityLabel="Auto-Approve umschalten"
            style={[styles.chipBtn, { borderColor: autoOn ? `rgba(${c.accentRgb},0.4)` : c.glassBorder, backgroundColor: autoOn ? `rgba(${c.accentRgb},0.14)` : 'transparent' }]}
          >
            <Text style={{ color: autoOn ? c.ok : c.textDim, fontSize: m.font.micro, fontWeight: '800' }}>⚡ AUTO</Text>
          </Pressable>
          <View style={[styles.chip, { backgroundColor: `rgba(${c.accentRgb},0.10)`, borderColor: c.glassBorder }]}>
            <IconDot size={8} color={tab.sessionId ? c.ok : c.warn} />
            <Text style={{ color: c.textDim, fontSize: m.font.micro, fontWeight: '700' }}>{statusLabel.toUpperCase()}</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Terminal schließen" style={({ pressed }) => [pressed && styles.pressed]}>
            <IconTrash size={m.icon.sm} color={c.textDim} />
          </Pressable>
          {!full && <IconChevronDown size={m.icon.sm} color={c.textDim} />}
        </View>
      </Pressable>

      {expanded && (
        <View style={full ? { flex: 1, minHeight: 0 } : undefined}>
          <View style={[styles.termWrap, { backgroundColor: c.termSurface }, full ? { flex: 1, minHeight: 0 } : { height: 340 }]}>
            {tab.sessionId ? (
              <TerminalView
                ref={termRef}
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
          <QuickKeys onKey={sendRaw} onJumpBottom={() => termRef.current?.scrollToBottom()} />
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
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 14 },
  viewToggle: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 14, overflow: 'hidden' },
  viewToggleBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  chipStrip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 36, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2 },
  badge: { width: 8, height: 8, borderRadius: 4 },
  addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  colorTag: { width: 10, height: 10, borderRadius: 5 },
  titleInput: { flex: 1, borderBottomWidth: 1, paddingVertical: 2, fontWeight: '700' },
  chipBtn: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth * 2 },
  chip2: {},
  termWrap: { marginHorizontal: 10, borderRadius: 14, overflow: 'hidden' },
  termPending: { flex: 1, minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  cmdInput: { flex: 1, paddingVertical: 6, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  micBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
