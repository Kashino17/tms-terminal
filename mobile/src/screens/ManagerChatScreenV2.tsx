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
  Modal,
  Animated,
  PanResponder,
  Keyboard,
  ActivityIndicator,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import Markdown from 'react-native-markdown-display';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer';
import { useSettingsStore } from '../store/settingsStore';

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
  type SidebarState,
} from '../components/manager/ToolSidebar';
import { VoiceFullscreen } from '../components/manager/VoiceFullscreen';
import { ORB_DEFS, executeOrb } from '../constants/orbDefinitions';
import { OrbLayer } from '../components/OrbLayer';
import { Dimensions, type LayoutChangeEvent } from 'react-native';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerChat'>;
  route: RouteProp<RootStackParamList, 'ManagerChat'>;
};

// "MM:SS" — used for the recording time pill on the mic button
function formatMicDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Markdown styles — kept in sync with V1's mdStyles (ManagerChatScreen.tsx) so
// assistant messages render identically across V1/V2.
const mdStyles = {
  body: { color: '#F8FAFC', fontSize: 13, lineHeight: 20 },
  heading1: { color: '#F8FAFC', fontSize: 17, fontWeight: '700' as const, marginBottom: 4 },
  heading2: { color: '#F8FAFC', fontSize: 15, fontWeight: '700' as const, marginBottom: 4 },
  heading3: { color: '#F8FAFC', fontSize: 13, fontWeight: '700' as const, marginBottom: 2 },
  strong: { color: '#F8FAFC', fontWeight: '700' as const },
  em: { color: '#94A3B8', fontStyle: 'italic' as const },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 1 },
  code_inline: { backgroundColor: '#243044', color: '#06B6D4', fontFamily: 'monospace', fontSize: 11, paddingHorizontal: 4, borderRadius: 3 },
  fence: { backgroundColor: '#243044', padding: 8, borderRadius: 8, marginVertical: 4 },
  code_block: { color: '#F8FAFC', fontFamily: 'monospace', fontSize: 11 },
  link: { color: '#3B82F6' },
  blockquote: { borderLeftColor: '#3B82F6', borderLeftWidth: 3, paddingLeft: 8, marginVertical: 4 },
  hr: { backgroundColor: '#334155' },
  paragraph: { marginVertical: 2 },
};

// Lightbox with swipe-down-to-dismiss. Inlined here (rather than extracting
// from V1) so V2 can iterate without touching the V1 screen.
function LightboxContent({ imageUri, onClose, children }: {
  imageUri: string | null;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dy) > 10,
      onPanResponderMove: (_e, gs) => {
        if (gs.dy > 0) {
          translateY.setValue(gs.dy);
          opacity.setValue(1 - gs.dy / 400);
        }
      },
      onPanResponderRelease: (_e, gs) => {
        if (gs.dy > 120 || gs.vy > 0.5) {
          Animated.parallel([
            Animated.timing(translateY, { toValue: 600, duration: 200, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
          ]).start(() => {
            translateY.setValue(0);
            opacity.setValue(1);
            onClose();
          });
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 80 }).start();
          Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  return (
    <Animated.View style={[lbStyles.overlay, { opacity }]}>
      <TouchableOpacity style={lbStyles.close} onPress={onClose}>
        <Feather name="x" size={28} color="#fff" />
      </TouchableOpacity>
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateY }], width: '100%', alignItems: 'center' }}>
        {imageUri && <Image source={{ uri: imageUri }} style={lbStyles.image} resizeMode="contain" />}
      </Animated.View>
      {children}
    </Animated.View>
  );
}

const lbStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  close: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 8 },
  image: { width: '100%', height: '70%' },
  actions: { position: 'absolute', bottom: 50, flexDirection: 'row', gap: 24 },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24,
  },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

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
  const { wsService, serverId, serverHost, serverPort, serverToken } = route.params;

  // ── Stores ─────────────────────────────────────────────────────────────────
  const personality = useManagerStore((s) => s.personality);
  const sessionMessages = useManagerStore((s) => s.sessionMessages);
  const activeChat = useManagerStore((s) => s.activeChat);
  const setActiveChat = useManagerStore((s) => s.setActiveChat);
  const delegatedTasks = useManagerStore((s) => s.delegatedTasks);
  const providers = useManagerStore((s) => s.providers);
  const activeProvider = useManagerStore((s) => s.activeProvider);
  const setActiveProviderStore = useManagerStore((s) => s.setActiveProvider);
  const enabled = useManagerStore((s) => s.enabled);
  const loading = useManagerStore((s) => s.loading);
  const setLoading = useManagerStore((s) => s.setLoading);
  const clearSessionMessages = useManagerStore((s) => s.clearSessionMessages);
  const addMessage = useManagerStore((s) => s.addMessage);
  const onboarded = useManagerStore((s) => s.onboarded);
  const voicePromptEnhanceEnabled = useSettingsStore((s) => s.voicePromptEnhanceEnabled);

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

  // Subscribe to TTS results so the speaker button on assistant messages flips
  // to a playable VoiceMessagePlayer. Mirrors V1's ttsHandler exactly.
  useEffect(() => {
    const handler = (data: unknown) => {
      const msg = data as { type: string; payload?: any };
      if (msg.type === 'tts:result' && msg.payload?.messageId && msg.payload?.audio) {
        setTtsAudio((prev) => ({
          ...prev,
          [msg.payload.messageId]: { audio: msg.payload.audio, duration: msg.payload.duration ?? 0 },
        }));
        setTtsLoading((prev) => { const n = new Set(prev); n.delete(msg.payload.messageId); return n; });
      } else if (msg.type === 'tts:error' && msg.payload?.messageId) {
        setTtsLoading((prev) => { const n = new Set(prev); n.delete(msg.payload.messageId); return n; });
      }
    };
    return wsService.addMessageListener(handler);
  }, [wsService]);

  // Subscribe to audio:* messages. Route the result based on voiceTargetSidRef:
  // - null  → chat input (mic in the input bar)
  // - sid   → inject into that pane's terminal (mic orb in the sidebar)
  useEffect(() => {
    const handler = (data: unknown) => {
      const msg = data as { type: string; sessionId?: string; payload?: any };
      if (!msg.type?.startsWith('audio:')) return;
      const targetSid = voiceTargetSidRef.current ?? 'manager';
      if (msg.sessionId && msg.sessionId !== targetSid) return;

      switch (msg.type) {
        case 'audio:transcription':
          if (msg.payload?.text) {
            const text: string = msg.payload.text;
            const targetSid = voiceTargetSidRef.current;
            if (targetSid) {
              // Terminal-mic flow: inject text into the target pane (look up
              // its current slot via the latest panes via ref to avoid stale
              // closure on this listener).
              const idx = panesRef.current.indexOf(targetSid);
              if (idx >= 0) spotlightRef.current?.injectIntoPane(idx, text);
            } else {
              setInput((prev) => prev + (prev ? ' ' : '') + text);
            }
          }
          setMicState('idle');
          setRecordingDuration(0);
          setVoiceFullscreen(false);
          voiceTargetSidRef.current = null;
          setMicFlow(null);
          break;
        case 'audio:progress':
          if (msg.payload?.chunk && msg.payload?.total) {
            setMicState('processing');
            setRecordingDuration(-msg.payload.chunk);
          }
          break;
        case 'audio:error':
          Alert.alert('Transkription fehlgeschlagen', msg.payload?.message ?? 'Unbekannter Fehler');
          setMicState('idle');
          setRecordingDuration(0);
          setVoiceFullscreen(false);
          voiceTargetSidRef.current = null;
          setMicFlow(null);
          break;
      }
    };
    return wsService.addMessageListener(handler);
  }, [wsService]);

  // Stop the recording + timer if the screen unmounts mid-record so we don't
  // leak the Audio.Recording handle (the OS will eventually reclaim it but
  // it can leave the mic LED on for a while).
  useEffect(() => {
    return () => {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, []);

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
  const [activeOrb, setActiveOrb] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'chat' | 'terminal'>('chat');
  const [input, setInput] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [providerTab, setProviderTab] = useState<'cloud' | 'local'>('cloud');
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [attachments, setAttachments] = useState<Array<{ uri: string; path?: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [ttsAudio, setTtsAudio] = useState<Record<string, { audio: string; duration: number }>>({});
  const [ttsLoading, setTtsLoading] = useState<Set<string>>(new Set());
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [voiceFullscreen, setVoiceFullscreen] = useState(false);
  // Distinguishes chat-mic (renders the Manager-Chat VoiceFullscreen overlay)
  // from terminal-mic (renders the small terminal-style pill, just like V1).
  const [micFlow, setMicFlow] = useState<'chat' | 'terminal' | null>(null);
  // When non-null, that pane fills the whole stage and the chat UI is hidden.
  // Set by double-tapping a pane; cleared by the close-button or keyboard hide.
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null);
  // Keyboard tracking + stage size — fed to OrbLayer so it can dock its orbs
  // above the keyboard and position them correctly inside the stage area.
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [stageSize, setStageSize] = useState({
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
  });

  const spotlightRef = useRef<MultiSpotlightRef>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Where the next audio:transcription result should land. null = chat input
  // (mic in the chat input bar), string = inject into that pane's terminal
  // (mic orb in the sidebar).
  const voiceTargetSidRef = useRef<string | null>(null);
  // Mirror of `panes` that the audio listener can read without re-subscribing
  // every time the user reshuffles panes (the listener is registered once at
  // mount, but we still need to find the right slot for transcription injection).
  const panesRef = useRef<(string | null)[]>([]);

  // Re-sync panes when tabs change (e.g. tab closed)
  useEffect(() => {
    setPanes((prev) =>
      prev.map((sid) => (sid && tabs.some((t) => t.sessionId === sid) ? sid : null)),
    );
  }, [tabs]);

  // Keep the panes ref in sync for non-React consumers (audio listener).
  panesRef.current = panes;

  // Track keyboard visibility + height so OrbLayer can dock its orbs above
  // it. Also exits pane-focus mode when the keyboard goes away (hardware
  // back, down-arrow, app-switch). The chat input path doesn't set
  // focusedPaneIdx, so chat-keyboard hides naturally bypass that branch.
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
      setFocusedPaneIdx((cur) => {
        if (cur != null) spotlightRef.current?.blurPaneKeyboard(cur);
        return null;
      });
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const handleStageLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setStageSize({ width, height });
  }, []);

  // Double-tap on a pane → enter fullscreen + focus that terminal's keyboard.
  const handlePaneDoubleTap = useCallback((idx: number) => {
    setFocusedPaneIdx(idx);
    // Defer focus by one tick so the layout swap completes first; otherwise
    // the keyboard can pop up before the pane has resized.
    setTimeout(() => spotlightRef.current?.focusPaneKeyboard(idx), 50);
  }, []);

  const exitPaneFocus = useCallback(() => {
    setFocusedPaneIdx((cur) => {
      if (cur != null) spotlightRef.current?.blurPaneKeyboard(cur);
      return null;
    });
  }, []);

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

  // Active provider — shown in the header pill, switched via the model picker dropdown
  const activeProviderObj = providers.find((p) => p.id === activeProvider);
  const activeProviderName = activeProviderObj?.name ?? activeProvider;
  const activeProviderIsLocal = activeProviderObj?.isLocal ?? false;

  // Default the picker tab to whatever the current provider is
  useEffect(() => {
    if (activeProviderObj) setProviderTab(activeProviderObj.isLocal ? 'local' : 'cloud');
  }, [activeProviderObj?.id]);

  const handleProviderSwitch = useCallback((id: string) => {
    setActiveProviderStore(id);
    wsService.send({ type: 'manager:set_provider', payload: { providerId: id } } as any);
    setShowModelPicker(false);
  }, [setActiveProviderStore, wsService]);

  // Re-poll the manager when the user picks "Aktualisieren" — mirrors V1's handlePoll
  const handlePoll = useCallback(() => {
    setLoading(true);
    wsService.send({ type: 'manager:poll' } as any);
  }, [wsService, setLoading]);

  const handleClearChat = useCallback(() => {
    Alert.alert('Chat löschen?', 'Alle Nachrichten in diesem Chat werden entfernt.', [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Löschen',
        style: 'destructive',
        onPress: () => { clearSessionMessages(activeChat); setLoading(false); },
      },
    ]);
  }, [clearSessionMessages, activeChat, setLoading]);

  // Filter messages by search query (case-insensitive substring on text only)
  const visibleMessages = useMemo(() => {
    if (!searchMode || !searchQuery.trim()) return messages;
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((m) => m.text.toLowerCase().includes(q));
  }, [messages, searchMode, searchQuery]);

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
  const closeTool = useCallback(() => setActiveOrb(null), []);

  const cycleSidebar = useCallback(() => {
    setSidebarState((s) =>
      s === 'collapsed' ? 'expanded' : s === 'expanded' ? 'hidden' : 'collapsed',
    );
  }, []);

  // ── Direct-Mode push ──────────────────────────────────────────────────────
  const pushToActivePane = useCallback((command: string) => {
    spotlightRef.current?.injectIntoActive(command + '\n');
  }, []);

  // ── Image attachment (mirrors V1 handlePickImage) ────────────────────────
  // Uploads each picked image as base64 to /upload/screenshot and stores both
  // the local URI (for thumbs/lightbox) and the server-side path (for the
  // assistant prompt). Failed uploads still keep the local URI so the user
  // sees what they attempted to attach.
  const handlePickImage = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: 4,
    });
    if (result.canceled || result.assets.length === 0) return;

    setUploading(true);
    const uploaded: Array<{ uri: string; path?: string }> = [];
    for (const asset of result.assets) {
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const filename = asset.fileName ?? `manager_${Date.now()}.jpg`;
        const res = await fetch(`http://${serverHost}:${serverPort}/upload/screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serverToken}`,
          },
          body: JSON.stringify({ filename, data: base64, mimeType: 'image/jpeg' }),
        });
        if (res.ok) {
          const json = (await res.json()) as { path: string };
          uploaded.push({ uri: asset.uri, path: json.path });
        } else {
          uploaded.push({ uri: asset.uri });
        }
      } catch {
        uploaded.push({ uri: asset.uri });
      }
    }
    setAttachments((prev) => [...prev, ...uploaded]);
    setUploading(false);
  }, [serverHost, serverPort, serverToken]);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Mic flow split into start / stop+send / cancel so the fullscreen overlay can
  // drive each independently (✓ button = stopAndSendRecording, ✕ = cancelRecording).
  // The format (wav, 16 kHz, mono) matches V1 so the server-side Whisper pipeline
  // is unchanged.
  const startRecording = useCallback(async () => {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert('Mikrofon-Zugriff', 'Bitte erlaube den Mikrofon-Zugriff in den Einstellungen.');
        return false;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync({
        android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
        ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
        web: {},
      });
      recordingRef.current = recording;
      setMicState('recording');
      setRecordingDuration(0);
      durationTimerRef.current = setInterval(() => setRecordingDuration((d) => d + 1), 1000);
      return true;
    } catch {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      setMicState('idle');
      return false;
    }
  }, []);

  const stopAndSendRecording = useCallback(async () => {
    try {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      const recording = recordingRef.current;
      if (!recording) return;
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;
      setMicState('processing');
      setRecordingDuration(0);
      if (!uri) return;
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await FileSystem.deleteAsync(uri, { idempotent: true });
      // Use the target sessionId set by whoever started the recording.
      // Default = 'manager' (chat input mic). Terminal-mic sets it to the
      // active pane's sessionId so the result lands in the terminal instead.
      const targetSid = voiceTargetSidRef.current ?? 'manager';
      wsService.send({
        type: 'audio:transcribe',
        sessionId: targetSid,
        payload: { audio: base64, format: 'wav', enhance: voicePromptEnhanceEnabled },
      } as any);
    } catch {
      setMicState('idle');
      setVoiceFullscreen(false);
      voiceTargetSidRef.current = null;
      setMicFlow(null);
    }
  }, [wsService, voicePromptEnhanceEnabled]);

  // Discards the current recording without sending it for transcription.
  const cancelRecording = useCallback(async () => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    const recording = recordingRef.current;
    recordingRef.current = null;
    setMicState('idle');
    setRecordingDuration(0);
    setVoiceFullscreen(false);
    voiceTargetSidRef.current = null;
    setMicFlow(null);
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        // best-effort cleanup
      }
    }
  }, []);

  // Tapping the mic button in the input bar opens the fullscreen voice UI and
  // starts recording. The transcription lands in the chat input.
  const handleMicPress = useCallback(async () => {
    if (micState === 'recording' || micState === 'processing') {
      if (micFlow === 'chat') setVoiceFullscreen(true);
      return;
    }
    voiceTargetSidRef.current = null; // chat input target
    setMicFlow('chat');
    setVoiceFullscreen(true);
    const ok = await startRecording();
    if (!ok) {
      setVoiceFullscreen(false);
      setMicFlow(null);
    }
  }, [micState, micFlow, startRecording]);

  // Mic ORB (sidebar) → terminal-mic flow. Same small pill UI as the V1
  // terminal screen; transcription is injected into the active pane.
  const handleOrbMic = useCallback(async () => {
    if (!activeSessionId) {
      Alert.alert('Kein aktives Terminal', 'Wähle zuerst ein Pane aus.');
      return;
    }
    if (micState === 'recording') {
      // Recording already running — second press = stop & send.
      stopAndSendRecording();
      return;
    }
    if (micState === 'processing') return;
    voiceTargetSidRef.current = activeSessionId;
    setMicFlow('terminal');
    const ok = await startRecording();
    if (!ok) {
      voiceTargetSidRef.current = null;
      setMicFlow(null);
    }
  }, [activeSessionId, micState, startRecording, stopAndSendRecording]);

  // ── Orb dispatcher ─────────────────────────────────────────────────────────
  // Tap on a sidebar orb → either fire its action against the active pane
  // (ctrl_c, esc, clear, …) or open a flyout for orbs that need a sub-UI
  // (tools, dpad). Mic re-uses the existing voice flow.
  const handleOrbPick = useCallback((orbId: string) => {
    const def = ORB_DEFS[orbId];
    if (!def) return;

    if (def.action === 'tools' || def.action === 'dpad') {
      setActiveOrb((cur) => (cur === orbId ? null : orbId));
      return;
    }
    if (def.action === 'mic') {
      handleOrbMic();
      return;
    }

    executeOrb(orbId, {
      sessionId: activeSessionId ?? null,
      sendInput: (data) => {
        if (!activeSessionId) return;
        wsService.send({ type: 'terminal:input', sessionId: activeSessionId, payload: { data } } as any);
      },
      clearTerminal: () => {
        if (!activeSessionId) return;
        wsService.send({ type: 'terminal:clear', sessionId: activeSessionId } as any);
      },
      scrollToBottom: () => {
        // MultiSpotlight doesn't expose a per-pane scroll yet — skip silently.
      },
      openTools: () => setActiveOrb('tools'),
      toggleDpad: () => setActiveOrb((cur) => (cur === 'dpad' ? null : 'dpad')),
      openMic: () => handleOrbMic(),
    });
  }, [activeSessionId, wsService, handleOrbMic]);

  // Helper for the dpad flyout — sends an arrow-key escape sequence to the
  // active pane via the same `terminal:input` channel as the orb actions.
  const sendKeyToActive = useCallback((data: string) => {
    if (!activeSessionId) return;
    wsService.send({ type: 'terminal:input', sessionId: activeSessionId, payload: { data } } as any);
  }, [activeSessionId, wsService]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    if (inputMode === 'terminal') {
      if (!activeSessionId) {
        Alert.alert('Kein aktives Terminal', 'Wähle zuerst ein Pane.');
        return;
      }
      if (!text) return;
      pushToActivePane(text);
      setInput('');
      return;
    }

    // Chat mode — append uploaded paths so the model can read them, mirror
    // attachments back into the user message for inline thumbnails.
    const attachmentPaths = attachments.filter((a) => a.path).map((a) => a.path!);
    const fullText = attachmentPaths.length > 0
      ? `${text}\n\n[Angehängte Bilder: ${attachmentPaths.join(', ')}]`
      : text;
    const userAttachmentUris = attachments.map((a) => a.uri);

    addMessage(
      {
        role: 'user',
        text: text || '(Bild)',
        targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
        attachmentUris: userAttachmentUris.length > 0 ? userAttachmentUris : undefined,
      },
      activeChat,
    );
    setLoading(true);

    const targetSessionId = activeChat === 'alle' ? undefined : activeChat;
    wsService.send({
      type: 'manager:chat',
      payload: { text: fullText, targetSessionId, onboarding: !onboarded },
    } as any);

    setInput('');
    setAttachments([]);
  }, [
    input, attachments, inputMode, activeSessionId, activeChat, onboarded,
    wsService, pushToActivePane, addMessage, setLoading,
  ]);

  // ── Render: Header ─────────────────────────────────────────────────────────
  function renderHeader() {
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

        <Pressable style={s.center} onPress={() => setShowModelPicker((v) => !v)}>
          <View style={s.titleRow}>
            <Text style={s.name}>{personality.agentName || 'Manager'}</Text>
            <Text style={s.modelMini}>
              · <Text style={s.model}>{activeProviderName}{activeProviderIsLocal ? ' · local' : ''}</Text>
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

        <TouchableOpacity style={s.menuBtn} onPress={() => setShowHeaderMenu((v) => !v)}>
          <Feather name="more-vertical" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render: Model Picker dropdown ─────────────────────────────────────────
  // Sits below the header as an overlay with a tap-outside-to-close backdrop.
  // Cloud / Local tab split mirrors V1 settings panel; only the configured rows
  // are tappable so users see-but-can't-pick unconfigured providers.
  function renderModelPicker() {
    if (!showModelPicker) return null;
    const filtered = providers.filter((p) => (providerTab === 'local' ? !!p.isLocal : !p.isLocal));
    return (
      <>
        <Pressable style={s.mpOverlay} onPress={() => setShowModelPicker(false)} />
        <View style={[s.mpPanel, { top: insets.top + 56 }]}>
          <View style={s.mpTabs}>
            <TouchableOpacity
              style={[s.mpTab, providerTab === 'cloud' && s.mpTabActive]}
              onPress={() => setProviderTab('cloud')}
              activeOpacity={0.7}
            >
              <Feather name="cloud" size={11} color={providerTab === 'cloud' ? colors.text : colors.textDim} />
              <Text style={[s.mpTabText, providerTab === 'cloud' && s.mpTabTextActive]}>Cloud</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.mpTab, providerTab === 'local' && s.mpTabActive]}
              onPress={() => setProviderTab('local')}
              activeOpacity={0.7}
            >
              <Feather name="hard-drive" size={11} color={providerTab === 'local' ? colors.text : colors.textDim} />
              <Text style={[s.mpTabText, providerTab === 'local' && s.mpTabTextActive]}>Local</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 320 }}>
            {filtered.length === 0 ? (
              <Text style={s.mpEmpty}>
                {providerTab === 'local' ? 'Kein lokales Modell verfügbar' : 'Keine Cloud-Provider konfiguriert'}
              </Text>
            ) : (
              filtered.map((p) => {
                const isActive = p.id === activeProvider;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[s.mpRow, isActive && s.mpRowActive]}
                    onPress={() => handleProviderSwitch(p.id)}
                    disabled={!p.configured}
                    activeOpacity={0.6}
                  >
                    <View style={[s.mpRadio, isActive && s.mpRadioActive]}>
                      {isActive && <View style={s.mpRadioDot} />}
                    </View>
                    <Text style={[s.mpRowName, !p.configured && { color: colors.textDim }]}>
                      {p.name}
                    </Text>
                    {!p.configured && (
                      <Text style={s.mpRowMeta}>nicht konfiguriert</Text>
                    )}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </View>
      </>
    );
  }

  // ── Render: ⋮ Header Menu ─────────────────────────────────────────────────
  function renderHeaderMenu() {
    if (!showHeaderMenu) return null;
    return (
      <>
        <Pressable style={s.mpOverlay} onPress={() => setShowHeaderMenu(false)} />
        <View style={[s.menuPanel, { top: insets.top + 56 }]}>
          <TouchableOpacity
            style={s.menuItem}
            onPress={() => { setShowHeaderMenu(false); setSearchMode((v) => !v); }}
          >
            <Feather name="search" size={15} color={colors.textMuted} />
            <Text style={s.menuItemText}>Suche</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.menuItem}
            onPress={() => {
              setShowHeaderMenu(false);
              navigation.navigate('ManagerMemory', { wsService, serverId });
            }}
          >
            <Feather name="database" size={15} color={colors.textMuted} />
            <Text style={s.menuItemText}>Memory</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.menuItem}
            onPress={() => {
              setShowHeaderMenu(false);
              navigation.navigate('ManagerArtifacts', {
                serverId,
                serverHost,
                serverPort: server?.port ?? serverPort,
                serverToken: server?.token ?? serverToken,
              });
            }}
          >
            <Feather name="package" size={15} color={colors.textMuted} />
            <Text style={s.menuItemText}>Artefakte</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.menuItem}
            onPress={() => { setShowHeaderMenu(false); handlePoll(); }}
            disabled={!enabled || loading}
          >
            <Feather name="refresh-cw" size={15} color={enabled && !loading ? colors.textMuted : colors.textDim} />
            <Text style={[s.menuItemText, (!enabled || loading) && { color: colors.textDim }]}>
              Aktualisieren
            </Text>
          </TouchableOpacity>
          {messages.length > 0 && (
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { setShowHeaderMenu(false); handleClearChat(); }}
            >
              <Feather name="trash-2" size={15} color={colors.destructive} />
              <Text style={[s.menuItemText, { color: colors.destructive }]}>Chat löschen</Text>
            </TouchableOpacity>
          )}
        </View>
      </>
    );
  }

  // ── Render: Search bar (above the multi-bar) ─────────────────────────────
  function renderSearchBar() {
    if (!searchMode) return null;
    return (
      <View style={s.searchBar}>
        <Feather name="search" size={14} color={colors.textDim} />
        <TextInput
          style={s.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Nachrichten durchsuchen…"
          placeholderTextColor={colors.textDim}
          autoFocus
        />
        {searchQuery.length > 0 && (
          <Text style={s.searchCount}>{visibleMessages.length}</Text>
        )}
        <TouchableOpacity
          onPress={() => { setSearchMode(false); setSearchQuery(''); }}
          hitSlop={8}
        >
          <Feather name="x" size={16} color={colors.textMuted} />
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

  // ── Render: Orb Flyout body ───────────────────────────────────────────────
  // Only orbs that need a sub-UI render here. Direct-action orbs fire and
  // never open the flyout.
  function renderOrbFlyoutBody() {
    const ctx = activeSessionId ? labelFor(activeSessionId) : null;
    switch (activeOrb) {
      case 'tools':
        return (
          <ScrollView>
            <ToolSection>Quick · in @{ctx ?? 'pane'} ausführen</ToolSection>
            {['git status', 'git pull', 'git log --oneline -10', 'ls -la', 'pwd', 'npm install', 'npm test', 'npm run build'].map((cmd) => (
              <ToolItem
                key={cmd}
                cmd={cmd}
                onPress={() => { pushToActivePane(cmd); closeTool(); }}
              />
            ))}
            <ToolSection>Snippets</ToolSection>
            <ToolItem emoji="📦" label="Backup DB" onPress={() => { pushToActivePane('pg_dump -Fc tms_prod > backup.dump'); closeTool(); }} />
            <ToolItem emoji="🚀" label="Deploy staging" onPress={() => { pushToActivePane('flyctl deploy --app tms-staging'); closeTool(); }} />
            <ToolItem emoji="🐳" label="Docker rebuild" onPress={() => { pushToActivePane('docker compose up -d --build'); closeTool(); }} />
          </ScrollView>
        );
      case 'dpad':
        // Rendered by renderDpadOverlay — same compact V1 style.
        return null;
      default:
        return null;
    }
  }

  // ── Render: Chat (very simple list — full markdown/lightbox/etc. ported later) ──
  function renderChat() {
    return (
      <View style={s.chat}>
        <FlatList
          inverted
          data={visibleMessages.slice().reverse()}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => (
            <View style={[s.msg, item.role === 'user' ? s.msgUser : s.msgAssistant]}>
              {item.role === 'assistant' ? (
                <Markdown style={mdStyles}>{item.text}</Markdown>
              ) : (
                <Text style={[s.msgText, s.msgTextUser]}>{item.text}</Text>
              )}

              {/* TTS player after generation, OR a "Vorlesen" button to start it */}
              {item.role === 'assistant' && ttsAudio[item.id] && (
                <VoiceMessagePlayer
                  audioBase64={ttsAudio[item.id].audio}
                  duration={ttsAudio[item.id].duration}
                />
              )}
              {item.role === 'assistant' && !ttsAudio[item.id] && item.text.length > 5 && (
                <TouchableOpacity
                  style={[s.ttsBtn, ttsLoading.has(item.id) && { opacity: 0.5 }]}
                  disabled={ttsLoading.has(item.id)}
                  onPress={() => {
                    setTtsLoading((prev) => new Set(prev).add(item.id));
                    wsService.send({
                      type: 'tts:generate',
                      payload: { text: item.text, messageId: item.id },
                    } as any);
                  }}
                >
                  <Feather
                    name={ttsLoading.has(item.id) ? 'loader' : 'volume-2'}
                    size={13}
                    color="#64748B"
                  />
                  <Text style={s.ttsBtnText}>
                    {ttsLoading.has(item.id) ? 'Wird vertont…' : 'Vorlesen'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* User-uploaded attachments — local URIs, full-width thumbs */}
              {item.attachmentUris && item.attachmentUris.length > 0 && (
                <View style={{ marginTop: 8, gap: 6 }}>
                  {item.attachmentUris.map((uri, i) => (
                    <TouchableOpacity
                      key={`a-${i}`}
                      activeOpacity={0.8}
                      onPress={() => setLightboxImage(uri)}
                    >
                      <Image
                        source={{ uri }}
                        style={s.msgImg}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Generated images from the assistant (server-served) */}
              {item.images && item.images.length > 0 && (
                <View style={{ marginTop: 8, gap: 8 }}>
                  {item.images.map((img, i) => {
                    const url = `http://${serverHost}:${serverPort}/generated-images/${encodeURIComponent(img)}?token=${serverToken}`;
                    return (
                      <TouchableOpacity
                        key={`g-${i}`}
                        activeOpacity={0.8}
                        onPress={() => setLightboxImage(url)}
                      >
                        <Image
                          source={{ uri: url }}
                          style={[s.msgImg, { aspectRatio: 1 }]}
                          resizeMode="contain"
                        />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
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

  // ── Render: Attachment Row (thumbs above the input) ──────────────────────
  function renderAttachments() {
    if (attachments.length === 0 && !uploading) return null;
    return (
      <View style={s.attachRow}>
        {attachments.map((att, idx) => (
          <View key={`${att.uri}-${idx}`} style={s.attachThumb}>
            <Image source={{ uri: att.uri }} style={s.attachImg} />
            <TouchableOpacity
              style={s.attachRemove}
              onPress={() => removeAttachment(idx)}
              hitSlop={6}
            >
              <Feather name="x" size={11} color="#fff" />
            </TouchableOpacity>
            {!att.path && (
              <View style={s.attachErrorDot}>
                <Feather name="alert-circle" size={10} color="#fff" />
              </View>
            )}
          </View>
        ))}
        {uploading && (
          <View style={[s.attachThumb, s.attachUploading]}>
            <Feather name="upload" size={16} color={colors.textMuted} />
          </View>
        )}
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

        <TouchableOpacity
          style={s.ibBtn}
          onPress={handlePickImage}
          disabled={isTerminal || uploading}
        >
          <Feather name="image" size={20} color={isTerminal ? colors.textDim : colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.ibBtn, micState === 'recording' && s.ibBtnRecording]}
          onPress={handleMicPress}
          disabled={micState === 'processing'}
        >
          <Feather
            name={micState === 'processing' ? 'loader' : micState === 'recording' ? 'square' : 'mic'}
            size={18}
            color={micState === 'recording' ? colors.destructive : colors.textMuted}
          />
          {micState === 'recording' && recordingDuration > 0 && (
            <Text style={s.micTime}>{formatMicDuration(recordingDuration)}</Text>
          )}
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

  // ── Render: Terminal-mic pill (mirrors V1 OrbLayer.micOverlay) ───────────
  // Small floating pill that shows red dot + mm:ss timer + send button while
  // recording, or a spinner + "Transkribiert…" while waiting for Whisper.
  // Positioned just to the right of the ToolSidebar, near the bottom.
  // Suppressed in focus mode — OrbLayer renders its own equivalent there.
  function renderTerminalMicPill() {
    if (focusedPaneIdx != null) return null;
    if (micFlow !== 'terminal') return null;
    if (micState !== 'recording' && micState !== 'processing') return null;
    const mm = String(Math.floor(Math.max(0, recordingDuration) / 60)).padStart(2, '0');
    const ss = String(Math.max(0, recordingDuration) % 60).padStart(2, '0');
    const sidebarOffset = sidebarState === 'expanded' ? 168 : 50;
    return (
      <View style={[s.micPill, { left: sidebarOffset, bottom: insets.bottom + 28 }]}>
        {micState === 'recording' ? (
          <>
            <View style={s.micDot} />
            <Text style={s.micTimer}>{mm}:{ss}</Text>
            <TouchableOpacity style={s.micSendBtn} onPress={stopAndSendRecording} activeOpacity={0.7}>
              <Feather name="send" size={14} color="#F8FAFC" />
            </TouchableOpacity>
            <TouchableOpacity onPress={cancelRecording} hitSlop={8} style={{ marginLeft: 4 }}>
              <Feather name="x" size={14} color="#94A3B8" />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={s.micProcessing}>Transkribiert…</Text>
          </>
        )}
      </View>
    );
  }

  // ── Render: D-Pad overlay (mirrors V1 OrbLayer.dpadOverlay) ──────────────
  // Compact 3-button cross floating just to the right of the ToolSidebar.
  // Suppressed in focus mode — OrbLayer's own dpad orb takes over.
  function renderDpadOverlay() {
    if (focusedPaneIdx != null) return null;
    if (activeOrb !== 'dpad') return null;
    const sidebarOffset = sidebarState === 'expanded' ? 168 : 50;
    return (
      <View style={[s.dpadOverlay, { left: sidebarOffset, bottom: insets.bottom + 100 }]}>
        <TouchableOpacity style={s.dpadKey} onPress={() => sendKeyToActive('\x1b[A')} activeOpacity={0.6}>
          <Feather name="chevron-up" size={18} color="#94A3B8" />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <TouchableOpacity style={s.dpadKey} onPress={() => sendKeyToActive('\x1b[D')} activeOpacity={0.6}>
            <Feather name="chevron-left" size={18} color="#94A3B8" />
          </TouchableOpacity>
          <TouchableOpacity style={s.dpadKey} onPress={() => sendKeyToActive('\x1b[B')} activeOpacity={0.6}>
            <Feather name="chevron-down" size={18} color="#94A3B8" />
          </TouchableOpacity>
          <TouchableOpacity style={s.dpadKey} onPress={() => sendKeyToActive('\x1b[C')} activeOpacity={0.6}>
            <Feather name="chevron-right" size={18} color="#94A3B8" />
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => setActiveOrb(null)} style={s.dpadCloseBtn}>
          <Text style={s.dpadCloseText}>Schließen</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Layout ─────────────────────────────────────────────────────────────────
  const inFocus = focusedPaneIdx != null;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {!inFocus && (
        <View style={{ paddingTop: insets.top, backgroundColor: colors.surface }}>
          {renderHeader()}
        </View>
      )}

      {!inFocus && renderModelPicker()}
      {!inFocus && renderHeaderMenu()}
      {!inFocus && renderSearchBar()}

      {!inFocus && (
        <GroupTabsBar
          groups={groups}
          activeId={activeGroupId}
          onLoad={onLoadGroup}
          onDelete={onDeleteGroup}
          onSave={onSaveGroup}
        />
      )}

      {/* Stage body: ToolSidebar | Multi-Spotlight (with overlay flyout)
          In focus mode the V1-style OrbLayer takes over so we hide the V2
          sidebar to give the same look as the terminal screen. */}
      <View
        style={[s.stageBody, inFocus && { paddingTop: insets.top }]}
        onLayout={handleStageLayout}
      >
        {!inFocus && (
          <ToolSidebar
            state={sidebarState}
            activeOrb={activeOrb}
            activeSessionId={activeSessionId ?? null}
            onToggleState={cycleSidebar}
            onPickOrb={handleOrbPick}
          />
        )}

        <View style={{ flex: 1, position: 'relative' }}>
          {!inFocus && renderMultiBar()}
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
            onPaneDoubleTap={handlePaneDoubleTap}
            focusedPaneIndex={focusedPaneIdx}
          />

          <ToolFlyout
            orbId={activeOrb === 'dpad' ? null : activeOrb}
            sidebarState={sidebarState}
            contextLabel={activeSessionId ? '@' + labelFor(activeSessionId) : undefined}
            onClose={closeTool}
          >
            {renderOrbFlyoutBody()}
          </ToolFlyout>

          {/* V1-style OrbLayer — replaces the V2 sidebar in focus mode so the
              user gets the exact same orb dock + tools + mic + dpad they're
              used to from the terminal screen when its keyboard opens. */}
          {inFocus && focusedPaneIdx != null && (
            <OrbLayer
              sessionId={panes[focusedPaneIdx] ?? undefined}
              wsService={wsService}
              onScrollToBottom={() => spotlightRef.current && undefined /* no-op */}
              onOpenTools={() => { /* TODO: hook ToolMenu in a follow-up */ }}
              onOpenSpotlight={() => { /* TODO: spotlight in V2 */ }}
              onOpenManager={() => exitPaneFocus()}
              onRangeToggle={() => { /* TODO: range select in V2 */ }}
              rangeActive={false}
              containerSize={stageSize}
              keyboardVisible={keyboardVisible}
              keyboardHeight={keyboardHeight}
              onTranscription={(text) => {
                if (focusedPaneIdx != null) {
                  spotlightRef.current?.injectIntoPane(focusedPaneIdx, text);
                }
              }}
            />
          )}

          {/* Floating close-button — only visible while a pane is in focus mode */}
          {inFocus && (
            <TouchableOpacity
              style={[s.focusCloseBtn, { top: insets.top + 8 }]}
              onPress={exitPaneFocus}
              hitSlop={10}
            >
              <Feather name="minimize-2" size={14} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {!inFocus && renderChipBar()}
      {!inFocus && renderChat()}
      {!inFocus && renderAttachments()}
      {!inFocus && renderInputBar()}

      {/* Fullscreen voice capture — only for chat-input mic. Terminal mic uses
          the small pill overlay (renderTerminalMicPill below). */}
      <VoiceFullscreen
        visible={voiceFullscreen && micFlow === 'chat'}
        state={micState === 'processing' ? 'processing' : 'recording'}
        duration={Math.max(0, recordingDuration)}
        onCancel={cancelRecording}
        onSend={stopAndSendRecording}
      />

      {renderTerminalMicPill()}
      {renderDpadOverlay()}

      {/* Lightbox — opens on tap of any image thumb in the chat */}
      <Modal
        visible={!!lightboxImage}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxImage(null)}
        statusBarTranslucent
      >
        <LightboxContent imageUri={lightboxImage} onClose={() => setLightboxImage(null)}>
          <View style={lbStyles.actions}>
            <TouchableOpacity
              style={lbStyles.btn}
              onPress={async () => {
                if (!lightboxImage) return;
                try {
                  const filename = `agent_image_${Date.now()}.png`;
                  const localUri = FileSystem.cacheDirectory + filename;
                  await FileSystem.downloadAsync(lightboxImage, localUri);
                  await Sharing.shareAsync(localUri, { mimeType: 'image/png', dialogTitle: 'Bild teilen' });
                } catch {
                  Alert.alert('Fehler', 'Bild konnte nicht geteilt werden.');
                }
              }}
            >
              <Feather name="share-2" size={16} color="#fff" />
              <Text style={lbStyles.btnText}>Teilen</Text>
            </TouchableOpacity>
          </View>
        </LightboxContent>
      </Modal>
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

  // ── Terminal-mic pill (V1 OrbLayer parity) ──────────────────────────────
  micPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0F172A',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    zIndex: 220,
  },
  micDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EF4444',
  },
  micTimer: {
    color: '#EF4444',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: fonts.mono,
  },
  micSendBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micProcessing: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },

  // ── D-Pad overlay (V1 OrbLayer parity) ───────────────────────────────────
  dpadOverlay: {
    position: 'absolute',
    alignItems: 'center',
    gap: 4,
    zIndex: 220,
    padding: 6,
    backgroundColor: 'rgba(15,23,42,0.85)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  dpadKey: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dpadCloseBtn: {
    marginTop: 4,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  dpadCloseText: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '600',
  },

  // Floating close button shown only in pane-focus mode (top-right corner).
  focusCloseBtn: {
    position: 'absolute',
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },

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
  msgImg: { width: '100%', aspectRatio: 1.5, borderRadius: 10, backgroundColor: colors.surface },
  ttsBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 4, paddingVertical: 4,
  },
  ttsBtnText: { fontSize: 11, color: '#64748B' },
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
    minWidth: 38, height: 38, borderRadius: 8,
    paddingHorizontal: 6,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  ibBtnRecording: {
    backgroundColor: colors.destructive + '1A',
    borderWidth: 1, borderColor: colors.destructive + '4D',
  },
  micTime: {
    fontFamily: fonts.mono, fontSize: 10, fontWeight: '700',
    color: colors.destructive,
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

  // Model picker dropdown
  mpOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 19,
  },
  mpPanel: {
    position: 'absolute',
    left: 56, right: 16,
    zIndex: 20,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
  },
  mpTabs: {
    flexDirection: 'row',
    paddingHorizontal: 6, paddingTop: 4, paddingBottom: 6,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  mpTab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 7, borderRadius: 7,
  },
  mpTabActive: { backgroundColor: colors.surfaceAlt },
  mpTabText: { fontSize: 11, fontWeight: '600', color: colors.textDim },
  mpTabTextActive: { color: colors.text },
  mpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  mpRowActive: { backgroundColor: colors.primary + '14' },
  mpRadio: {
    width: 14, height: 14, borderRadius: 7,
    borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  mpRadioActive: { borderColor: colors.primary },
  mpRadioDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  mpRowName: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  mpRowMeta: { fontSize: 10, color: colors.textDim, fontStyle: 'italic' },
  mpEmpty: { paddingVertical: 14, paddingHorizontal: 12, color: colors.textDim, fontSize: 12, textAlign: 'center' },

  // ⋮ Header menu — anchored to the right
  menuPanel: {
    position: 'absolute',
    right: 12,
    zIndex: 20,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 4,
    minWidth: 180,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 11,
    gap: 10,
  },
  menuItemText: { color: colors.text, fontSize: 14 },

  // Search bar — sits between header and groupTabsBar
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1, color: colors.text, fontSize: 13,
    paddingVertical: 0,
  },
  searchCount: {
    fontFamily: fonts.mono, fontSize: 10, fontWeight: '700',
    color: colors.textMuted,
    paddingHorizontal: 6, paddingVertical: 2,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 5,
  },

  // Attachment row above the input
  attachRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12, paddingTop: 8,
    backgroundColor: colors.surface,
  },
  attachThumb: {
    width: 56, height: 56, borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: colors.border,
    position: 'relative',
  },
  attachImg: { width: '100%', height: '100%' },
  attachRemove: {
    position: 'absolute', top: 2, right: 2,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center',
  },
  attachErrorDot: {
    position: 'absolute', bottom: 2, left: 2,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: 'center', justifyContent: 'center',
  },
  attachUploading: {
    alignItems: 'center', justifyContent: 'center',
  },
});
