import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  StyleSheet,
  Pressable,
  Image,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';

import { colors, fonts, spacing } from '../theme';
import { useManagerStore } from '../store/managerStore';
import { useTerminalStore } from '../store/terminalStore';
import { useServerStore } from '../store/serverStore';
import { usePaneGroupsStore } from '../store/paneGroupsStore';
import { tabDisplayName } from '../utils/tabDisplayName';
import { colorForSession } from '../utils/terminalColors';

import { GroupTabsBar } from '../components/manager/GroupTabsBar';
import {
  MultiSpotlight,
  type MultiSpotlightRef,
  type SpotlightMode,
  type PaneStatus,
} from '../components/manager/MultiSpotlight';
import {
  ToolSidebar,
  ToolFlyout,
  ToolItem,
  ToolSection,
  type ToolId,
  type SidebarState,
} from '../components/manager/ToolSidebar';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerChat'>;
  route: RouteProp<RootStackParamList, 'ManagerChat'>;
};

/**
 * Manager Chat Screen V2 — full redesign per `prototype/manager-chat-redesign/v8-tools-direct.html`.
 *
 * Skeleton in this commit:
 *   - Whisper-style header (avatar 36, name + model + tasks pill)
 *   - Group-Tabs bar (paneGroupsStore wired)
 *   - Multi-Spotlight 1/2/4 with TerminalView panes
 *   - Tool-Sidebar (collapsed/expanded/hidden) + Flyout for Werkzeuge/Quick/Snippets
 *   - Terminal chip-bar (original style, links to active pane)
 *   - Chat scroll (simple FlatList — markdown / lightbox / TTS to be ported in later phase)
 *   - Input bar with Direct-Mode toggle (💬 chat ↔ ▶ terminal)
 *
 * Deferred to later phases (still uses V1 for now):
 *   - Voice fullscreen mode
 *   - Rich transcription with confidence bar
 *   - Image attachments + lightbox
 *   - Wizard cards (slash commands)
 *   - Settings panel overlay
 */
export function ManagerChatScreenV2({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { wsService, serverId } = route.params;

  // ── Stores ─────────────────────────────────────────────────────────────────
  const personality = useManagerStore((s) => s.personality);
  const sessionMessages = useManagerStore((s) => s.sessionMessages);
  const activeChat = useManagerStore((s) => s.activeChat);
  const setActiveChat = useManagerStore((s) => s.setActiveChat);
  const delegatedTasks = useManagerStore((s) => s.delegatedTasks);

  const tabs = useTerminalStore((s) => s.tabs[serverId] ?? []);
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));

  const paneGroupsLoaded = usePaneGroupsStore((s) => s.loaded);
  const loadPaneGroups = usePaneGroupsStore((s) => s.load);
  const groups = usePaneGroupsStore((s) => s.groups[serverId] ?? []);
  const activeGroupId = usePaneGroupsStore((s) => s.activeId[serverId] ?? null);
  const saveGroup = usePaneGroupsStore((s) => s.saveGroup);
  const removeGroup = usePaneGroupsStore((s) => s.removeGroup);
  const setActiveGroup = usePaneGroupsStore((s) => s.setActive);

  useEffect(() => {
    if (!paneGroupsLoaded) loadPaneGroups();
  }, [paneGroupsLoaded, loadPaneGroups]);

  // ── Local state ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<SpotlightMode>(2);
  const [panes, setPanes] = useState<(string | null)[]>(() => {
    // Default: first 2 tabs of this server (or empty slots).
    const initial = tabs.slice(0, 2).map((t) => t.sessionId ?? null);
    while (initial.length < 2) initial.push(null);
    return initial;
  });
  const [activePaneIdx, setActivePaneIdx] = useState(0);
  const [sidebarState, setSidebarState] = useState<SidebarState>('collapsed');
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [inputMode, setInputMode] = useState<'chat' | 'terminal'>('chat');
  const [input, setInput] = useState('');

  const spotlightRef = useRef<MultiSpotlightRef>(null);

  // Re-sync panes when tabs change (e.g. tab closed)
  useEffect(() => {
    setPanes((prev) =>
      prev.map((sid) => (sid && tabs.some((t) => t.sessionId === sid) ? sid : null)),
    );
  }, [tabs]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const messages = useMemo(
    () => (activeChat === 'alle' ? [] : sessionMessages[activeChat] ?? []),
    [activeChat, sessionMessages],
  );

  const activeSessionId = panes[activePaneIdx];

  const labelFor = useCallback((sid: string) => {
    const t = tabs.find((x) => x.sessionId === sid);
    return t ? tabDisplayName(t) : sid;
  }, [tabs]);

  const statusFor = useCallback((sid: string): PaneStatus => {
    // TODO Phase 7: derive from terminal activity (idle > 60s, last AI tool detected, exit code, etc.)
    const t = tabs.find((x) => x.sessionId === sid);
    if (!t) return 'idle';
    if (t.aiTool) return 'run';
    return 'idle';
  }, [tabs]);

  // Active task count (for the small pill in the header)
  const activeTaskCount = useMemo(
    () => delegatedTasks.filter((t) => t.status === 'pending' || t.status === 'running').length,
    [delegatedTasks],
  );

  // ── Group-Tabs callbacks ───────────────────────────────────────────────────
  const onLoadGroup = useCallback((groupId: string) => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    const newMode: SpotlightMode = g.terminals.length === 1 ? 1 : g.terminals.length === 2 ? 2 : 4;
    const newPanes = [...g.terminals];
    while (newPanes.length < newMode) newPanes.push(null);
    setMode(newMode);
    setPanes(newPanes.slice(0, newMode));
    setActivePaneIdx(0);
    setActiveGroup(serverId, groupId);
  }, [groups, serverId, setActiveGroup]);

  const onDeleteGroup = useCallback((groupId: string) => {
    if (groups.length <= 1) return;
    removeGroup(serverId, groupId);
  }, [groups.length, serverId, removeGroup]);

  const onSaveGroup = useCallback((name: string) => {
    saveGroup(serverId, name, panes.slice(0, mode));
  }, [serverId, panes, mode, saveGroup]);

  // ── Spotlight callbacks ────────────────────────────────────────────────────
  const onPromote = useCallback((slot: number) => {
    const sid = panes[slot];
    if (!sid) return;
    setMode(1);
    setPanes([sid]);
    setActivePaneIdx(0);
  }, [panes]);

  const onSelectEmptyPane = useCallback((slot: number) => {
    setActivePaneIdx(slot);
    // TODO Phase 7: open a picker; for now focus the slot so the next chip-bar tap fills it
  }, []);

  const onModeChange = useCallback((m: SpotlightMode) => {
    setMode(m);
    setPanes((prev) => {
      const next = prev.slice(0, m);
      while (next.length < m) next.push(null);
      return next;
    });
    if (activePaneIdx >= m) setActivePaneIdx(0);
  }, [activePaneIdx]);

  const onChipPress = useCallback((sessionId: string) => {
    setPanes((prev) => {
      const next = [...prev];
      next[activePaneIdx] = sessionId;
      return next;
    });
  }, [activePaneIdx]);

  // ── Tool callbacks ─────────────────────────────────────────────────────────
  const openTool = useCallback((id: ToolId) => {
    setActiveTool((cur) => (cur === id ? null : id));
  }, []);

  const closeTool = useCallback(() => setActiveTool(null), []);

  const cycleSidebar = useCallback(() => {
    setSidebarState((s) =>
      s === 'collapsed' ? 'expanded' : s === 'expanded' ? 'hidden' : 'collapsed',
    );
  }, []);

  // ── Direct-Mode push ──────────────────────────────────────────────────────
  const pushToActivePane = useCallback((command: string) => {
    spotlightRef.current?.injectIntoActive(command + '\n');
  }, []);

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (inputMode === 'terminal') {
      if (!activeSessionId) {
        Alert.alert('Kein aktives Terminal', 'Wähle zuerst ein Pane.');
        return;
      }
      pushToActivePane(text);
      setInput('');
      return;
    }
    // Chat mode — fall back to V1 protocol for now.
    const targetSessionId = activeChat === 'alle' ? undefined : activeChat;
    wsService.send({
      type: 'manager:chat',
      payload: { text, targetSessionId, onboarding: false },
    } as any);
    setInput('');
  }, [input, inputMode, activeSessionId, activeChat, wsService, pushToActivePane]);

  // ── Render: Header ─────────────────────────────────────────────────────────
  function renderHeader() {
    const modelName = 'Claude 4.7'; // TODO Phase 7: pull from active provider
    return (
      <View style={[s.header, { paddingTop: 6 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Feather name="arrow-left" size={18} color={colors.text} />
        </TouchableOpacity>

        <View style={s.avatarWrap}>
          {personality.agentAvatarUri ? (
            <Image source={{ uri: personality.agentAvatarUri }} style={s.avatar} />
          ) : (
            <View style={[s.avatar, s.avatarDefault]}>
              <Feather name="cpu" size={17} color="#fff" />
            </View>
          )}
          <View style={s.avatarStatusDot} />
        </View>

        <Pressable style={s.center} onPress={() => { /* TODO model dropdown */ }}>
          <View style={s.titleRow}>
            <Text style={s.name}>{personality.agentName || 'Manager'}</Text>
            <Text style={s.modelMini}>
              · <Text style={s.model}>{modelName}</Text>
            </Text>
            <Feather name="chevron-down" size={9} color={colors.textDim} />
          </View>
        </Pressable>

        {activeTaskCount > 0 && (
          <View style={s.tasksMini}>
            <View style={s.tasksDot} />
            <Text style={s.tasksText}>{activeTaskCount}</Text>
          </View>
        )}

        <TouchableOpacity style={s.menuBtn} onPress={() => { /* TODO ⋮ menu */ }}>
          <Feather name="more-vertical" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render: View-Mode toggle (1/2/4) ──────────────────────────────────────
  function renderMultiBar() {
    return (
      <View style={s.multiBar}>
        {/* View toggle now lives near the LEFT edge so it's reachable with one
            thumb. Buttons are 36×28 — well above the 44 px Apple HIG target
            when combined with hitSlop, but visually compact. */}
        <View style={s.viewToggle}>
          {([1, 2, 4] as SpotlightMode[]).map((m) => (
            <Pressable
              key={m}
              style={[s.viewMode, mode === m && s.viewModeActive]}
              onPress={() => onModeChange(m)}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            >
              <Text style={[s.viewModeText, mode === m && s.viewModeTextActive]}>{m}</Text>
            </Pressable>
          ))}
        </View>
        <TouchableOpacity
          style={s.mbIconBtn}
          onPress={cycleSidebar}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
        >
          <Feather name="menu" size={14} color={colors.textMuted} />
        </TouchableOpacity>
        <Text style={s.multiBarLbl}>{mode} {mode === 1 ? 'Pane' : 'Panes'}</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          style={s.mbIconBtn}
          onPress={() => { /* TODO: save layout */ }}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
        >
          <Feather name="save" size={13} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render: Chip Bar (terminals) ──────────────────────────────────────────
  function renderChipBar() {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.chipBar}
        contentContainerStyle={s.chipBarContent}
      >
        <Pressable
          style={[s.chip, activeChat === 'alle' && s.chipActive]}
          onPress={() => setActiveChat('alle')}
        >
          <View style={[s.chipDot, { backgroundColor: colors.accent }]} />
          <Text style={[s.chipText, activeChat === 'alle' && s.chipTextActive]}>Alle</Text>
        </Pressable>
        {tabs.map((t, i) => {
          const sid = t.sessionId;
          if (!sid) return null;
          const inPane = panes.includes(sid);
          const tcolor = colorForSession(sid);
          return (
            <Pressable
              key={sid}
              style={[
                s.chip,
                inPane && { backgroundColor: tcolor + '26', borderColor: tcolor + '4D' },
              ]}
              onPress={() => onChipPress(sid)}
            >
              <View style={[s.chipDot, { backgroundColor: tcolor }]} />
              <Text style={[s.chipText, inPane && { color: tcolor }]}>
                S{i + 1}·{tabDisplayName(t)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }

  // ── Render: Tool Flyout body ──────────────────────────────────────────────
  function renderToolBody() {
    const ctx = activeSessionId ? labelFor(activeSessionId) : null;
    switch (activeTool) {
      case 'wrench':
        return (
          <ScrollView>
            <ToolSection>Aktion auf @{ctx ?? 'pane'}</ToolSection>
            <ToolItem icon="refresh-cw" label="Restart" onPress={() => { closeTool(); }} />
            <ToolItem icon="trash-2" label="Output leeren" onPress={() => { closeTool(); }} />
            <ToolItem icon="copy" label="Output kopieren" onPress={() => { closeTool(); }} />
            <ToolItem icon="settings" label="Session-Einstellungen" onPress={() => { closeTool(); }} />
            <ToolItem icon="square" label="Stop" variant="warn" onPress={() => { closeTool(); }} />
            <ToolItem icon="x-octagon" label="Kill Session" variant="danger" onPress={() => { closeTool(); }} />
          </ScrollView>
        );
      case 'quick':
        return (
          <ScrollView>
            <ToolSection>In @{ctx ?? 'pane'} ausführen</ToolSection>
            {['git status', 'git pull', 'git log --oneline -10', 'ls -la', 'pwd', 'npm install', 'npm test', 'npm run build', 'clear'].map((cmd) => (
              <ToolItem
                key={cmd}
                cmd={cmd}
                onPress={() => { pushToActivePane(cmd); closeTool(); }}
              />
            ))}
          </ScrollView>
        );
      case 'snippets':
        return (
          <ScrollView>
            <ToolSection>Eigene Snippets</ToolSection>
            <ToolItem emoji="📦" label="Backup DB" onPress={() => { pushToActivePane('pg_dump -Fc tms_prod > backup.dump'); closeTool(); }} />
            <ToolItem emoji="🚀" label="Deploy staging" onPress={() => { pushToActivePane('flyctl deploy --app tms-staging'); closeTool(); }} />
            <ToolItem emoji="🐳" label="Docker rebuild" onPress={() => { pushToActivePane('docker compose up -d --build'); closeTool(); }} />
          </ScrollView>
        );
      case 'files':
      case 'search':
      case 'ai':
      default:
        return (
          <View style={{ padding: 14 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>Coming soon — wird in einer späteren Phase angeschlossen.</Text>
          </View>
        );
    }
  }

  // ── Render: Chat (very simple list — full markdown/lightbox/etc. ported later) ──
  function renderChat() {
    return (
      <View style={s.chat}>
        <FlatList
          inverted
          data={messages.slice().reverse()}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => (
            <View style={[s.msg, item.role === 'user' ? s.msgUser : s.msgAssistant]}>
              <Text style={[s.msgText, item.role === 'user' && s.msgTextUser]}>{item.text}</Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={s.empty}>
              <Feather name="cpu" size={32} color={colors.textDim} />
              <Text style={s.emptyTitle}>Manager Agent</Text>
              <Text style={s.emptyText}>Schick eine Nachricht oder benutze ▶ um direkt ins aktive Pane zu schreiben.</Text>
            </View>
          }
        />
      </View>
    );
  }

  // ── Render: Input bar with Direct-Mode toggle ─────────────────────────────
  function renderInputBar() {
    const isTerminal = inputMode === 'terminal';
    const targetColor = activeSessionId ? colorForSession(activeSessionId) : colors.accent;
    return (
      <View style={[s.inputBar, isTerminal && s.inputBarTerminal, { paddingBottom: insets.bottom + 8 }]}>
        <View style={[s.modeToggle, isTerminal && s.modeToggleTerminal]}>
          <Pressable
            style={[s.modeBtn, !isTerminal && s.modeBtnChatActive]}
            onPress={() => setInputMode('chat')}
          >
            <Feather name="message-square" size={13} color={isTerminal ? colors.textDim : '#fff'} />
          </Pressable>
          <Pressable
            style={[s.modeBtn, isTerminal && s.modeBtnTermActive]}
            onPress={() => setInputMode('terminal')}
          >
            <Feather name="chevron-right" size={14} color={isTerminal ? '#fff' : colors.textDim} />
          </Pressable>
        </View>

        <TouchableOpacity style={s.ibBtn} onPress={() => { /* TODO image picker */ }}>
          <Feather name="image" size={20} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity style={s.ibBtn} onPress={() => { /* TODO mic / transcription */ }}>
          <Feather name="mic" size={20} color={colors.textMuted} />
        </TouchableOpacity>

        <View
          style={[
            s.ibInput,
            isTerminal && {
              backgroundColor: '#0B1220',
              borderColor: targetColor + '4D',
              borderRadius: 8,
            },
          ]}
        >
          {isTerminal && activeSessionId && (
            <View style={s.prefix}>
              <Text style={[s.prefixTarget, { backgroundColor: targetColor + '2E', borderColor: targetColor + '4D', color: colors.text }]}>
                @{labelFor(activeSessionId)}
              </Text>
              <Text style={s.prefixArrow}>▶</Text>
            </View>
          )}
          <TextInput
            style={[s.ibInputText, isTerminal && s.ibInputTextTerm]}
            value={input}
            onChangeText={setInput}
            placeholder={isTerminal ? 'Befehl eingeben…' : 'Nachricht…'}
            placeholderTextColor={colors.textDim}
            onSubmitEditing={sendMessage}
            returnKeyType="send"
          />
        </View>

        <TouchableOpacity
          style={[s.sendBtn, isTerminal && { backgroundColor: colors.accent, borderRadius: 8 }]}
          onPress={sendMessage}
        >
          <Feather name={isTerminal ? 'play' : 'send'} size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  // ── Layout ─────────────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface }}>
        {renderHeader()}
      </View>

      <GroupTabsBar
        groups={groups}
        activeId={activeGroupId}
        onLoad={onLoadGroup}
        onDelete={onDeleteGroup}
        onSave={onSaveGroup}
      />

      {/* Stage body: ToolSidebar | Multi-Spotlight (with overlay flyout) */}
      <View style={s.stageBody}>
        <ToolSidebar
          state={sidebarState}
          activeTool={activeTool}
          onToggleState={cycleSidebar}
          onPickTool={openTool}
        />

        <View style={{ flex: 1, position: 'relative' }}>
          {renderMultiBar()}
          <MultiSpotlight
            ref={spotlightRef}
            mode={mode}
            panes={panes}
            activePaneIndex={activePaneIdx}
            onActivePaneChange={setActivePaneIdx}
            onPromote={onPromote}
            onSelectEmptyPane={onSelectEmptyPane}
            wsService={wsService}
            labelFor={labelFor}
            statusFor={statusFor}
          />

          <ToolFlyout
            tool={activeTool}
            sidebarState={sidebarState}
            contextLabel={activeSessionId ? '@' + labelFor(activeSessionId) : undefined}
            onClose={closeTool}
          >
            {renderToolBody()}
          </ToolFlyout>
        </View>
      </View>

      {renderChipBar()}
      {renderChat()}
      {renderInputBar()}
    </KeyboardAvoidingView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backBtn: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -4,
  },
  avatarWrap: {
    width: 36,
    height: 36,
    position: 'relative',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  avatarDefault: {
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarStatusDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  center: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  name: { color: colors.text, fontSize: 14.5, fontWeight: '700', lineHeight: 16 },
  modelMini: { fontSize: 10.5, color: colors.textMuted },
  model: { color: colors.info, fontWeight: '600' },

  tasksMini: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 9,
    backgroundColor: colors.primary + '1A',
    borderWidth: 1, borderColor: colors.primary + '33',
  },
  tasksDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
  tasksText: { fontSize: 9.5, fontWeight: '700', color: colors.primary, fontFamily: fonts.mono },

  menuBtn: {
    width: 26, height: 26, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },

  // Multi bar (above panes) — taller for thumb-friendly toggles, controls left-aligned
  multiBar: {
    height: 36,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  multiBarLbl: {
    fontSize: 10, fontWeight: '700', color: colors.textMuted, fontFamily: fonts.mono,
  },
  mbIconBtn: {
    width: 28, height: 28, borderRadius: 7,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  viewToggle: {
    flexDirection: 'row', gap: 2, padding: 2,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  viewMode: {
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6,
    minWidth: 32, alignItems: 'center',
  },
  viewModeActive: {
    backgroundColor: colors.primary,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4, shadowRadius: 2, elevation: 2,
  },
  viewModeText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  viewModeTextActive: { color: '#fff' },

  // Stage body container
  stageBody: { flex: 1, flexDirection: 'row', minHeight: 0 },

  // Chip bar
  chipBar: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    flexGrow: 0,
  },
  chipBarContent: { paddingHorizontal: 12, paddingVertical: 6, gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: 'transparent',
  },
  chipActive: { backgroundColor: colors.primary + '4D' },
  chipDot: { width: 5, height: 5, borderRadius: 3 },
  chipText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  chipTextActive: { color: colors.primary },

  // Chat
  chat: { flex: 1.05, minHeight: 0, backgroundColor: colors.bg },
  msg: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 14, marginVertical: 4,
    maxWidth: '90%',
  },
  msgUser: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary + '22',
    borderTopRightRadius: 4,
    borderWidth: 1, borderColor: colors.primary + '33',
  },
  msgAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 4,
    borderWidth: 1, borderColor: colors.border + '4D',
  },
  msgText: { color: colors.text, fontSize: 13, lineHeight: 18 },
  msgTextUser: { color: colors.text },
  empty: {
    paddingTop: 60, alignItems: 'center', gap: 6,
  },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
  emptyText: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingHorizontal: 32, lineHeight: 18 },

  // Input bar
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 6,
    paddingHorizontal: 10, paddingTop: 8,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  inputBarTerminal: {
    backgroundColor: '#0F1A2E',
    borderTopColor: colors.accent + '4D',
  },
  modeToggle: {
    flexDirection: 'row',
    height: 38,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1, borderColor: colors.border,
    padding: 2, gap: 1,
  },
  modeToggleTerminal: { borderColor: colors.accent + '59' },
  modeBtn: {
    width: 26,
    borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  modeBtnChatActive: { backgroundColor: colors.primary },
  modeBtnTermActive: { backgroundColor: colors.accent },

  ibBtn: {
    width: 38, height: 38, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  ibInput: {
    flex: 1,
    minHeight: 38, maxHeight: 100,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 4,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: 'transparent',
  },
  prefix: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
  },
  prefixTarget: {
    fontFamily: fonts.mono, fontSize: 10.5, fontWeight: '700',
    paddingHorizontal: 5, paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
  },
  prefixArrow: { color: colors.textMuted, fontSize: 11 },
  ibInputText: {
    flex: 1,
    color: colors.text, fontSize: 13,
  },
  ibInputTextTerm: {
    fontFamily: fonts.mono, fontSize: 12.5,
  },

  sendBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
});
