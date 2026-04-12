import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Audio } from 'expo-av';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import type { WebSocketService } from '../services/websocket.service';
import { useManagerStore, ManagerMessage, PhaseInfo } from '../store/managerStore';
import { useTerminalStore } from '../store/terminalStore';
import { useServerStore } from '../store/serverStore';
import { tabDisplayName } from '../utils/tabDisplayName';
import { colors, spacing, fontSizes } from '../theme';
import Markdown from 'react-native-markdown-display';
import { PresentationViewer } from '../components/PresentationViewer';

// ── Markdown Styles ──────────────────────────────────────────────────────────

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

// ── Date Separator Helper ────────────────────────────────────────────────────

function formatDateSeparator(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today.getTime() - msgDay.getTime()) / 86400000;
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Types ───────────────────────────────────────────────────────────────────

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerChat'>;
  route: RouteProp<RootStackParamList, 'ManagerChat'>;
};

// ── Slash Commands ─────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/sm', label: 'Zusammenfassung', desc: 'Terminal-Summary' },
  { cmd: '/askill', label: 'Neuer Skill', desc: 'Skill erstellen lassen' },
  { cmd: '/cron', label: 'Cron Job', desc: 'Wiederkehrende Aufgabe erstellen' },
  { cmd: '/ppt', label: 'Präsentation', desc: 'Slides erstellen lassen' },
  { cmd: '/reset', label: 'Zurücksetzen', desc: 'Agent neu starten' },
  { cmd: '/clear', label: 'Chat leeren', desc: 'Verlauf löschen' },
  { cmd: '/memory', label: 'Memory', desc: 'Memory-Viewer öffnen' },
  { cmd: '/help', label: 'Hilfe', desc: 'Befehle anzeigen' },
];

// ── Phase Labels ───────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  analyzing_terminals: 'Terminals...',
  building_context: 'Kontext...',
  calling_ai: 'Sende an AI...',
  streaming: 'Schreibt...',
  executing_actions: 'Tools...',
  tool_response: 'Verarbeite...',
};

// ── Provider Capability Badges ────────────────────────────────────────────

const GEMMA_CAPS_VISION = [
  { icon: 'tool', label: 'Tools', color: '#60A5FA' },
  { icon: 'eye', label: 'Vision', color: '#FBBF24' },
  { icon: 'cpu', label: 'Reasoning', color: '#4ADE80' },
];
const GEMMA_CAPS_TEXT = [
  { icon: 'tool', label: 'Tools', color: '#60A5FA' },
  { icon: 'cpu', label: 'Reasoning', color: '#4ADE80' },
];

const PROVIDER_CAPS: Record<string, Array<{ icon: string; label: string; color: string }>> = {
  'glm': [
    { icon: 'tool', label: 'Tools', color: '#60A5FA' },
    { icon: 'eye', label: 'Vision', color: '#FBBF24' },
    { icon: 'cpu', label: 'Reasoning', color: '#4ADE80' },
  ],
  'kimi': [
    { icon: 'eye', label: 'Vision', color: '#FBBF24' },
    { icon: 'cpu', label: 'Reasoning', color: '#4ADE80' },
    { icon: 'code', label: 'Code', color: '#A78BFA' },
  ],
  // Gemma variants — exact IDs
  'gemma-4': GEMMA_CAPS_VISION,
  'gemma-4-26b': GEMMA_CAPS_TEXT,
  'gemma-4-31b': GEMMA_CAPS_VISION,
};

/** Look up capabilities for a provider, with fuzzy fallback for gemma variants */
function getProviderCaps(id: string): Array<{ icon: string; label: string; color: string }> | undefined {
  if (PROVIDER_CAPS[id]) return PROVIDER_CAPS[id];
  // Fallback: any gemma model gets at least text caps
  if (id.includes('gemma')) {
    // 31B+ and models with vision get vision caps
    if (id.includes('31') || id.includes('27b-it') || !id.includes('26')) return GEMMA_CAPS_VISION;
    return GEMMA_CAPS_TEXT;
  }
  return undefined;
}

// ── Lightbox with swipe-to-dismiss ─────────────────────────────────────────

function LightboxContent({ imageUri, onClose, children }: {
  imageUri: string | null;
  onClose: () => void;
  serverHost: string;
  serverPort: number;
  children: React.ReactNode;
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e: any, gs: any) => Math.abs(gs.dy) > 10,
      onPanResponderMove: (_e: any, gs: any) => {
        if (gs.dy > 0) {
          translateY.setValue(gs.dy);
          opacity.setValue(1 - gs.dy / 400);
        }
      },
      onPanResponderRelease: (_e: any, gs: any) => {
        if (gs.dy > 120 || gs.vy > 0.5) {
          // Dismiss — animate out
          Animated.parallel([
            Animated.timing(translateY, { toValue: 600, duration: 200, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
          ]).start(() => {
            translateY.setValue(0);
            opacity.setValue(1);
            onClose();
          });
        } else {
          // Snap back
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 80 }).start();
          Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  return (
    <Animated.View style={[styles.lightboxOverlay, { opacity }]}>
      <TouchableOpacity style={styles.lightboxClose} onPress={onClose}>
        <Feather name="x" size={28} color="#fff" />
      </TouchableOpacity>
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateY }], width: '100%', alignItems: 'center' }}>
        {imageUri && (
          <Image
            source={{ uri: imageUri }}
            style={styles.lightboxImage}
            resizeMode="contain"
          />
        )}
      </Animated.View>
      {children}
    </Animated.View>
  );
}

// ── Thinking Strip (Inline Indicator) ─────────────────────────────────────

// Color map: phase → index for interpolation
const PHASE_COLOR_MAP: Record<string, number> = {
  '__sending': 0,
  'analyzing_terminals': 1, 'building_context': 1, 'calling_ai': 1, 'streaming_start': 1,
  'tool_response': 2, 'executing_actions': 2,
  'streaming': 3,
};
const PHASE_COLORS = [colors.textDim, colors.primary, '#C8913A', '#22C55E'];
const PHASE_TEXT_COLORS = [colors.textDim, colors.textMuted, colors.textMuted, '#4ADE80'];

function ThinkingBubble({ phase, streamingText, onCancel, requestStartTime, tokenStats }: {
  phase: string;
  streamingText: string;
  onCancel: () => void;
  requestStartTime: number | null;
  tokenStats: { completionTokens: number; tps: number } | null;
}) {
  // Equalizer bar animations (native driver only — safe)
  const bar1 = useRef(new Animated.Value(0.3)).current;
  const bar2 = useRef(new Animated.Value(0.3)).current;
  const bar3 = useRef(new Animated.Value(0.3)).current;
  const [elapsed, setElapsed] = useState(() =>
    requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0
  );
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const isSending = phase === '__sending';
  const isStreaming = phase === 'streaming' && streamingText.length > 0;
  const label = isSending ? 'Gesendet...' : (PHASE_LABELS[phase] ?? phase);
  const tokenCount = tokenStats?.completionTokens ?? 0;
  const tps = tokenStats?.tps ?? 0;

  // Direct color from phase — no Animated interpolation (avoids native/non-native driver crash)
  const targetColorIdx = PHASE_COLOR_MAP[phase] ?? 1;
  const barColor = PHASE_COLORS[targetColorIdx] ?? colors.primary;
  const textColor = PHASE_TEXT_COLORS[targetColorIdx] ?? colors.textMuted;

  // Track elapsed from store's requestStartTime (with unmount guard)
  useEffect(() => {
    const start = requestStartTime ?? Date.now();
    if (mountedRef.current) setElapsed((Date.now() - start) / 1000);
    const timer = setInterval(() => {
      if (mountedRef.current) setElapsed((Date.now() - start) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, [requestStartTime]);

  // Equalizer bar animations (useNativeDriver: true only — no crash)
  useEffect(() => {
    const animate = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, { toValue: 1, duration: 400, delay, easing: Easing.ease, useNativeDriver: true }),
          Animated.timing(val, { toValue: 0.3, duration: 400, easing: Easing.ease, useNativeDriver: true }),
        ]),
      );
    const a1 = animate(bar1, 0);
    const a2 = animate(bar2, 150);
    const a3 = animate(bar3, 300);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [bar1, bar2, bar3]);

  return (
    <View style={stripStyles.wrap}>
      <View style={stripStyles.strip}>
        {/* Main row */}
        <View style={stripStyles.main}>
          {/* Equalizer bars */}
          <View style={stripStyles.eqWrap}>
            <Animated.View style={[stripStyles.eqBar, { backgroundColor: barColor, transform: [{ scaleY: bar1 }] }]} />
            <Animated.View style={[stripStyles.eqBarTall, { backgroundColor: barColor, transform: [{ scaleY: bar2 }] }]} />
            <Animated.View style={[stripStyles.eqBar, { backgroundColor: barColor, transform: [{ scaleY: bar3 }] }]} />
          </View>

          {/* Phase label */}
          <Text style={[stripStyles.phase, { color: textColor }]}>
            {label}
          </Text>

          <View style={stripStyles.spacer} />

          {/* Stats (hidden in sending state) */}
          {!isSending && (
            <View style={stripStyles.stats}>
              {tokenCount > 0 && <Text style={stripStyles.stat}><Text style={stripStyles.statVal}>{tokenCount}</Text> tok</Text>}
              {tps > 0 && <Text style={stripStyles.stat}><Text style={stripStyles.statVal}>{tps}</Text> t/s</Text>}
            </View>
          )}

          {/* Timer */}
          <Text style={stripStyles.time}>{elapsed.toFixed(1)}s</Text>
        </View>

        {/* Progress line (2px) */}
        <View style={stripStyles.progressTrack}>
          <View style={[
            stripStyles.progressFill,
            { backgroundColor: barColor },
            isSending && { width: '2%' },
            !isSending && !isStreaming && { width: '50%' },
            isStreaming && { width: '80%' },
          ]} />
        </View>

        {/* Streaming text (expands) */}
        {isStreaming && (
          <View style={stripStyles.streamWrap}>
            <Markdown style={mdStyles}>{streamingText.length > 2000 ? streamingText.slice(-2000) : streamingText}</Markdown>
          </View>
        )}

        {/* Cancel */}
        <TouchableOpacity onPress={onCancel} activeOpacity={0.7}>
          <Text style={stripStyles.cancel}>Abbrechen</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Phase Popup ────────────────────────────────────────────────────────────

function PhasePopup({
  phases,
  provider,
  visible,
  onClose,
}: {
  phases: PhaseInfo[];
  provider: string;
  visible: boolean;
  onClose: () => void;
}) {
  const totalDuration = phases.reduce((sum, p) => sum + p.duration, 0);

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.popupOverlay} onPress={onClose}>
        <View style={styles.popupContent}>
          <Text style={styles.popupTitle}>Verarbeitungsdetails</Text>
          {phases.map((p, i) => (
            <View key={i} style={styles.popupRow}>
              <Text style={styles.popupPhase}>{p.label}</Text>
              <Text style={styles.popupDuration}>{(p.duration / 1000).toFixed(1)}s</Text>
            </View>
          ))}
          <View style={[styles.popupRow, styles.popupTotal]}>
            <Text style={styles.popupTotalLabel}>Gesamt</Text>
            <Text style={styles.popupTotalDuration}>{(totalDuration / 1000).toFixed(1)}s</Text>
          </View>
          <Text style={styles.popupProvider}>Provider: {provider}</Text>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export function ManagerChatScreen({ navigation, route }: Props) {
  const { wsService, serverId, serverHost, serverPort, serverToken } = route.params;
  const insets = useSafeAreaInsets();

  const {
    enabled, messages, activeProvider, providers, loading,
    addMessage, addError,
    setLoading, clearMessages, clearSessionMessages, deleteMessage,
    personality, onboarded, setPersonality, setOnboarded,
    thinking, streamingText, streamTokenStats, lastPhases, requestStartTime,
    setThinking,
    sessionMessages, activeChat, setActiveChat,
    delegatedTasks,
  } = useManagerStore();

  const tabs = useTerminalStore((s) => s.tabs[serverId] ?? []);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const [input, setInput] = useState('');
  const [chipMenu, setChipMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [providerTab, setProviderTab] = useState<'cloud' | 'local'>(() => {
    const active = providers.find(p => p.id === activeProvider);
    return active?.isLocal ? 'local' : 'cloud';
  });
  const [editName, setEditName] = useState(personality.agentName);
  const [attachments, setAttachments] = useState<Array<{ uri: string; path?: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<ManagerMessage>>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [activePres, setActivePres] = useState<{ url: string; title: string } | null>(null);
  const [connQuality, setConnQuality] = useState<string>('good');
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [phasePopupVisible, setPhasePopupVisible] = useState(false);
  const [, setTaskTick] = useState(0); // Force re-render for task age display
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);

  // Update task age display every 10s
  useEffect(() => {
    if (delegatedTasks.length === 0) return;
    const timer = setInterval(() => setTaskTick(t => t + 1), 10_000);
    return () => clearInterval(timer);
  }, [delegatedTasks.length]);

  // ── WS Message Listener (audio only — manager:* handled persistently in TerminalScreen)

  useEffect(() => {
    const handler = (data: unknown) => {
      const msg = data as { type: string; payload?: any };
      if (!msg.type?.startsWith('audio:')) return;

      switch (msg.type) {
        case 'audio:transcription':
          if (msg.payload?.text) {
            setInput((prev) => prev + (prev ? ' ' : '') + msg.payload.text);
          }
          setMicState('idle');
          break;
        case 'audio:error':
          addError(msg.payload?.message ?? 'Transkription fehlgeschlagen');
          setMicState('idle');
          break;
      }
    };

    const unsub = wsService.addMessageListener(handler);
    return unsub;
  }, [wsService]);

  // ── Cleanup on unmount (audio timer + recording) ─────────────────────────

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

  // ── Sync terminal labels to Manager Agent ────────────────────────────────

  useEffect(() => {
    if (tabs.length === 0) return;
    const labels = tabs.map((tab, idx) => ({
      sessionId: tab.sessionId ?? '',
      name: `Shell ${idx + 1} · ${tabDisplayName(tab)}`,
    })).filter(l => l.sessionId);
    wsService.send({ type: 'manager:sync_labels', payload: { labels } } as any);
  }, [tabs, wsService]);

  // ── Connection Quality ────────────────────────────────────────────────────

  useEffect(() => {
    const timer = setInterval(() => {
      setConnQuality((wsService as any).getQuality?.() ?? 'good');
    }, 3000);
    return () => clearInterval(timer);
  }, [wsService]);

  // ── Filtered Messages ─────────────────────────────────────────────────────

  // Use per-session messages when a specific terminal is selected, otherwise global
  const chatMessages = activeChat === 'alle'
    ? messages
    : (sessionMessages[activeChat] ?? []);

  const filteredMessages = searchQuery
    ? chatMessages.filter(m => m.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : chatMessages;

  // ── Toggle Manager ────────────────────────────────────────────────────────

  const handleToggle = useCallback(() => {
    const next = !enabled;
    wsService.send({ type: 'manager:toggle', payload: { enabled: next } });
  }, [enabled, wsService]);

  // ── Send Chat ─────────────────────────────────────────────────────────────

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    // Slash commands
    if (text.startsWith('/')) {
      const cmd = text.toLowerCase().split(' ')[0];
      if (cmd === '/reset') {
        Alert.alert(
          'Agent zurücksetzen',
          'Memory und Persönlichkeit werden gelöscht. Der Agent startet komplett neu mit dem Onboarding.',
          [
            { text: 'Abbrechen', style: 'cancel' },
            {
              text: 'Zurücksetzen',
              style: 'destructive',
              onPress: () => {
                // Reset memory on server
                wsService.send({ type: 'manager:memory_write', payload: { section: 'user', data: { name: '', role: '', techStack: [], preferences: [], learnedFacts: [] } } } as any);
                wsService.send({ type: 'manager:memory_write', payload: { section: 'personality', data: { agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, traits: [], sharedHistory: [] } } } as any);
                wsService.send({ type: 'manager:memory_write', payload: { section: 'projects', data: [] } } as any);
                wsService.send({ type: 'manager:memory_write', payload: { section: 'insights', data: [] } } as any);
                // Reset local state
                clearSessionMessages(activeChat);
                setPersonality({ agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, customInstruction: '' });
                setOnboarded(false);
                setInput('');
                addMessage({ role: 'system', text: 'Agent wurde zurückgesetzt. Schreib "Hi" um das Onboarding zu starten.' });
              },
            },
          ],
        );
        setInput('');
        return;
      }
      if (cmd === '/help') {
        addMessage({ role: 'system', text: 'Verfügbare Befehle:\n/sm — Terminal-Zusammenfassung\n/askill — Neuen Skill erstellen\n/cron — Cron Job einrichten\n/ppt — Präsentation erstellen\n/reset — Agent zurücksetzen\n/clear — Chat leeren\n/memory — Memory-Viewer\n/help — Diese Hilfe' });
        setInput('');
        return;
      }
      if (cmd === '/clear') {
        clearSessionMessages(activeChat);
        setInput('');
        return;
      }
      if (cmd === '/memory') {
        navigation.navigate('ManagerMemory', { wsService, serverId });
        setInput('');
        return;
      }
      if (cmd === '/sm') {
        setLoading(true);
        wsService.send({ type: 'manager:poll', payload: { targetSessionId: activeChat !== 'alle' ? activeChat : undefined } } as any);
        setInput('');
        return;
      }
      if (cmd === '/askill') {
        const skillDesc = text.slice('/askill'.length).trim();
        const askillPrompt = skillDesc
          ? `[SKILL-ERSTELLUNG] Der User möchte einen neuen Skill erstellen: "${skillDesc}". Frage nach Details die du brauchst (was genau soll der Skill können, welche Tools/Dependencies werden benötigt, Input/Output-Format). Plane den Skill sorgfältig bevor du ihn implementierst. Nutze dein self_education Tool.`
          : `[SKILL-ERSTELLUNG] Der User möchte einen neuen Skill für dich erstellen. Frage ihn: 1) Was soll der Skill können? 2) Gibt es bestimmte Tools oder Programme die verwendet werden sollen? 3) Wie soll das Input/Output aussehen? Sei neugierig und stelle gezielte Fragen bevor du mit der Implementierung beginnst. Nutze dein self_education Tool.`;

        addMessage({ role: 'user', text: skillDesc ? `/askill ${skillDesc}` : '/askill', targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
        setLoading(true);
        wsService.send({
          type: 'manager:chat',
          payload: { text: askillPrompt, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: !onboarded },
        });
        setInput('');
        Keyboard.dismiss();
        return;
      }
      if (cmd === '/cron') {
        const cronDesc = text.slice('/cron'.length).trim();
        const cronPrompt = cronDesc
          ? `[CRON-SETUP] Der User möchte einen Cron Job erstellen: "${cronDesc}". Frage nach den fehlenden Details: Zeitplan (z.B. alle 30 Min, täglich um 9 Uhr), Typ (simple Shell-Befehl oder Claude Code Auftrag), Befehl/Auftrag, Arbeitsverzeichnis. Erstelle den Job dann mit create_cron_job.`
          : `[CRON-SETUP] Der User möchte einen wiederkehrenden Cron Job einrichten. Frage interaktiv ab:\n1. Was soll der Job tun?\n2. Wie oft? (z.B. alle 30 Min, stündlich, täglich um 9 Uhr)\n3. Typ: einfacher Shell-Befehl oder Claude Code Auftrag?\n4. In welchem Verzeichnis?\nErstelle den Job dann mit create_cron_job.`;
        addMessage({ role: 'user', text: cronDesc ? `/cron ${cronDesc}` : '/cron', targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
        setLoading(true);
        wsService.send({
          type: 'manager:chat',
          payload: { text: cronPrompt, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: !onboarded },
        });
        setInput('');
        Keyboard.dismiss();
        return;
      }
      if (cmd === '/ppt') {
        const pptDesc = text.slice('/ppt'.length).trim();
        const pptPrompt = pptDesc
          ? `[PRÄSENTATION] Der User möchte eine Präsentation erstellen: "${pptDesc}". Erstelle eine professionelle Präsentation mit 5-8 Slides. Nutze das create_presentation Tool mit HTML-Slides. Verwende die verfügbaren CSS-Klassen (card, grid-2, stat, badge, gradient-*, fade-in, etc.), Chart.js Canvas für Diagramme und Mermaid für Flowcharts wo sinnvoll.`
          : `[PRÄSENTATION] Der User möchte eine Präsentation erstellen. Frage: 1) Worüber? 2) Für welches Publikum? 3) Wie viele Slides ungefähr? Erstelle dann eine professionelle Präsentation mit dem create_presentation Tool.`;
        addMessage({ role: 'user', text: pptDesc ? `/ppt ${pptDesc}` : '/ppt', targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
        setLoading(true);
        wsService.send({
          type: 'manager:chat',
          payload: { text: pptPrompt, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: !onboarded },
        });
        setInput('');
        Keyboard.dismiss();
        return;
      }
    }

    // Build message text including attachment references
    const attachmentPaths = attachments.filter(a => a.path).map(a => a.path!);
    const fullText = attachmentPaths.length > 0
      ? `${text}\n\n[Angehängte Bilder: ${attachmentPaths.join(', ')}]`
      : text;

    const userAttachmentUris = attachments.filter(a => a.uri).map(a => a.uri);
    addMessage({
      role: 'user',
      text: text || '(Bild)',
      targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
      attachmentUris: userAttachmentUris.length > 0 ? userAttachmentUris : undefined,
    }, activeChat);
    setLoading(true);
    wsService.send({
      type: 'manager:chat',
      payload: { text: fullText, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: !onboarded },
    });
    setInput('');
    setAttachments([]);
    Keyboard.dismiss();
  }, [input, attachments, activeChat, wsService, addMessage, setLoading, clearSessionMessages, setPersonality, setOnboarded, onboarded, navigation, serverId]);

  // ── Manual Poll ───────────────────────────────────────────────────────────

  const handlePoll = useCallback(() => {
    setLoading(true);
    wsService.send({ type: 'manager:poll' });
  }, [wsService, setLoading]);

  // ── Image Attachment ───────────────────────────────────────────────────────

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
          const json = await res.json() as { path: string };
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

  // ── Avatar Picker ───────────────────────────────────────────────────────

  const handlePickAvatar = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (result.canceled || result.assets.length === 0) return;

    const uri = result.assets[0].uri;
    // Copy to app's document directory for persistence
    const filename = `agent_avatar_${Date.now()}.jpg`;
    const destUri = FileSystem.documentDirectory + filename;
    await FileSystem.copyAsync({ from: uri, to: destUri });

    setPersonality({ agentAvatarUri: destUri });
  }, [setPersonality]);

  // ── Mic / Audio Transcription ─────────────────────────────────────────────

  const handleMicPress = useCallback(async () => {
    if (micState === 'recording') {
      try {
        if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
        const recording = recordingRef.current;
        if (!recording) return;
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        recordingRef.current = null;
        setMicState('processing');
        setRecordingDuration(0);
        if (!uri) return;
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.deleteAsync(uri, { idempotent: true });
        const activeTab = tabs.find(t => t.sessionId);
        wsService.send({
          type: 'audio:transcribe',
          sessionId: activeTab?.sessionId ?? 'manager',
          payload: { audio: base64, format: 'wav' },
        } as any);
      } catch {
        setMicState('idle');
      }
    } else {
      try {
        const { granted } = await Audio.requestPermissionsAsync();
        if (!granted) return;
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync({
          android: { extension: '.wav', outputFormat: 3, audioEncoder: 1, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000 },
          ios: { extension: '.wav', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
          web: {},
        });
        recordingRef.current = recording;
        setMicState('recording');
        setRecordingDuration(0);
        durationTimerRef.current = setInterval(() => setRecordingDuration(d => d + 1), 1000);
      } catch {
        if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
        setMicState('idle');
      }
    }
  }, [micState, wsService, tabs]);

  // ── Provider Switch ───────────────────────────────────────────────────────

  const handleProviderSwitch = useCallback((id: string) => {
    useManagerStore.getState().setActiveProvider(id);
    wsService.send({ type: 'manager:set_provider', payload: { providerId: id } });
    setShowSettings(false);
  }, [wsService]);

  // ── Scroll to Bottom ──────────────────────────────────────────────────────

  // Reset stuck state when screen regains focus
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      // Close any stuck overlays
      setShowHeaderMenu(false);
      setShowSettings(false);
      // If loading but no thinking phase active, the request probably failed silently
      const state = useManagerStore.getState();
      if (state.loading && !state.thinking && !state.streamingText) {
        setLoading(false);
      }
    });
    return unsub;
  }, [navigation, setLoading]);

  // No manual scroll needed — FlatList is inverted (newest at bottom by default)

  const scrollBtnRef = useRef(false);
  const handleScroll = useCallback((e: any) => {
    const { contentOffset } = e.nativeEvent;
    // Inverted list: offset 0 = bottom (newest). Show scroll btn when scrolled up
    const shouldShow = contentOffset.y > 300;
    if (shouldShow !== scrollBtnRef.current) {
      scrollBtnRef.current = shouldShow;
      setShowScrollBtn(shouldShow);
    }
  }, []);

  // ── Retry ─────────────────────────────────────────────────────────────────

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;
    setLoading(true);
    wsService.send({
      type: 'manager:chat',
      payload: { text: lastUserMsg.text, targetSessionId: lastUserMsg.targetSessionId, onboarding: !onboarded },
    });
  }, [messages, wsService, onboarded, setLoading]);

  // ── Long-Press Message Actions ────────────────────────────────────────────

  const handleMessageLongPress = useCallback((msg: ManagerMessage) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      msg.role === 'user' ? 'Deine Nachricht' : 'Agent-Nachricht',
      undefined,
      [
        {
          text: 'Kopieren',
          onPress: () => {
            Clipboard.setStringAsync(msg.text);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: () => deleteMessage(msg.id),
        },
        { text: 'Abbrechen', style: 'cancel' },
      ],
    );
  }, [deleteMessage]);

  // Memoize reversed message list — avoid creating new array on every render
  const reversedMessages = useMemo(() => [...filteredMessages].reverse(), [filteredMessages]);

  // ── Render Message ────────────────────────────────────────────────────────

  const renderMessage = useCallback(({ item, index }: { item: ManagerMessage; index: number }) => {
    const isUser = item.role === 'user';
    const isSystem = item.role === 'system';

    // Inverted list: data is reversed, so index+1 is the "previous" message (older one)
    const nextInList = index < reversedMessages.length - 1 ? reversedMessages[index + 1] : null;
    const showDateSep = !nextInList || formatDateSeparator(item.timestamp) !== formatDateSeparator(nextInList.timestamp);
    const dateSep = showDateSep ? formatDateSeparator(item.timestamp) : null;

    return (
      <>
        {dateSep && (
          <View style={styles.dateSeparator}>
            <View style={styles.dateSepLine} />
            <Text style={styles.dateSepText}>{dateSep}</Text>
            <View style={styles.dateSepLine} />
          </View>
        )}
        <Pressable
          style={[styles.messageRow, isUser && styles.messageRowUser]}
          onLongPress={() => handleMessageLongPress(item)}
          delayLongPress={400}
        >
          {/* Agent avatar for assistant messages */}
          {!isUser && !isSystem && (
            personality.agentAvatarUri ? (
              <Image source={{ uri: personality.agentAvatarUri }} style={styles.messageAvatar} />
            ) : (
              <View style={[styles.messageAvatar, styles.messageAvatarPlaceholder]}>
                <Text style={{ fontSize: 12 }}>🤖</Text>
              </View>
            )
          )}
          <View
            style={[
              styles.messageBubble,
              isUser ? styles.bubbleUser : isSystem ? styles.bubbleSystem : styles.bubbleAssistant,
            ]}
          >
            {/* Phase duration chip (last response only) */}
            {!isUser && !isSystem && lastPhases && index === filteredMessages.length - 1 && (
              <TouchableOpacity
                style={styles.phaseChip}
                onPress={() => setPhasePopupVisible(true)}
              >
                <Feather name="clock" size={10} color={colors.textMuted} />
                <Text style={styles.phaseChipText}>
                  {(lastPhases.reduce((s, p) => s + p.duration, 0) / 1000).toFixed(1)}s
                </Text>
              </TouchableOpacity>
            )}

            {/* Session chips */}
            {item.sessions && item.sessions.length > 0 && (
              <View style={styles.sessionChips}>
                {item.sessions.map((s) => (
                  <View
                    key={s.sessionId}
                    style={[styles.sessionChip, s.hasActivity && styles.sessionChipActive]}
                  >
                    <Text style={styles.sessionChipText}>{s.label}</Text>
                  </View>
                ))}
              </View>
            )}

            {isUser || isSystem ? (
              <Text style={[styles.messageText, isSystem && styles.messageTextSystem]}>
                {item.text}
              </Text>
            ) : (
              <Markdown style={mdStyles}>{item.text}</Markdown>
            )}

            {/* User-uploaded attachments */}
            {item.attachmentUris && item.attachmentUris.length > 0 && (
              <View style={{ marginTop: 8, gap: 6 }}>
                {item.attachmentUris.map((uri, i) => (
                  <TouchableOpacity key={i} activeOpacity={0.8} onPress={() => setLightboxImage(uri)}>
                    <Image
                      source={{ uri }}
                      style={{ width: '100%', aspectRatio: 1.5, borderRadius: 10, backgroundColor: colors.surface }}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Generated Images — tap to open lightbox */}
            {item.images && item.images.length > 0 && (
              <View style={{ marginTop: 8, gap: 8 }}>
                {item.images.map((img, i) => {
                  const imageUrl = `http://${serverHost}:${serverPort}/generated-images/${encodeURIComponent(img)}?token=${serverToken}`;
                  return (
                    <TouchableOpacity key={i} activeOpacity={0.8} onPress={() => setLightboxImage(imageUrl)}>
                      <Image
                        source={{ uri: imageUrl }}
                        style={{ width: '100%', aspectRatio: 1, borderRadius: 12, backgroundColor: colors.surface }}
                        resizeMode="contain"
                      />
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Generated Presentations — tap to open viewer */}
            {item.presentations && item.presentations.length > 0 && (
              <View style={{ marginTop: 8, gap: 8 }}>
                {item.presentations.map((pres, i) => {
                  const presUrl = `http://${serverHost}:${serverPort}/generated-presentations/${encodeURIComponent(pres)}?token=${serverToken}`;
                  return (
                    <TouchableOpacity
                      key={i}
                      activeOpacity={0.7}
                      onPress={() => setActivePres({ url: presUrl, title: pres.replace(/^pres_\d+\.html$/, 'Presentation') })}
                      style={presCardStyles.card}
                    >
                      <Feather name="monitor" size={20} color={colors.primary} />
                      <View style={presCardStyles.cardContent}>
                        <Text style={presCardStyles.cardTitle}>Presentation</Text>
                        <Text style={presCardStyles.cardSub}>Tippen zum Anzeigen</Text>
                      </View>
                      <Feather name="chevron-right" size={16} color={colors.textDim} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Actions */}
            {item.actions && item.actions.length > 0 && (
              <View style={styles.actions}>
                {item.actions.map((a, i) => (
                  <View key={i} style={styles.actionRow}>
                    <Feather
                      name={a.type === 'write_to_terminal' ? 'terminal' : 'corner-down-left'}
                      size={12}
                      color={colors.accent}
                    />
                    <Text style={styles.actionText}>
                      {a.type === 'write_to_terminal'
                        ? `→ ${a.detail.slice(0, 60)}`
                        : 'Enter gesendet'}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* Timestamp + Response Duration */}
            <View style={styles.timestampRow}>
              <Text style={styles.timestamp}>
                {new Date(item.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
              </Text>
              {item.responseDuration != null && item.role === 'assistant' && (
                <Pressable onPress={() => setPhasePopupVisible(true)} hitSlop={6}>
                  <View style={styles.durationBadge}>
                    <Feather name="clock" size={8} color={colors.textDim} />
                    <Text style={styles.durationText}>
                      {item.responseDuration < 1000
                        ? `${item.responseDuration}ms`
                        : `${(item.responseDuration / 1000).toFixed(1)}s`}
                    </Text>
                  </View>
                </Pressable>
              )}
            </View>
          </View>
        </Pressable>
      </>
    );
  }, [handleMessageLongPress, filteredMessages, reversedMessages]);

  // ── Active Provider Label ─────────────────────────────────────────────────

  const activeProviderObj = providers.find((p) => p.id === activeProvider);
  const activeProviderName = activeProviderObj?.name ?? activeProvider;
  const activeProviderIsLocal = activeProviderObj?.isLocal ?? false;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={88}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8}>
          <Feather name="arrow-left" size={22} color={colors.text} />
        </TouchableOpacity>

        <TouchableOpacity onPress={handlePickAvatar} activeOpacity={0.7} style={styles.avatarContainer}>
          {personality.agentAvatarUri ? (
            <Image source={{ uri: personality.agentAvatarUri }} style={styles.headerAvatar} />
          ) : (
            <View style={[styles.headerAvatar, styles.headerAvatarPlaceholder]}>
              <Feather name="user" size={18} color={colors.textDim} />
            </View>
          )}
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{personality.agentName}</Text>
          <Pressable onPress={() => setShowSettings((v) => !v)}>
            <Text style={styles.headerSubtitle}>
              {activeProviderName}{activeProviderIsLocal ? ' · local' : ''} <Feather name="chevron-down" size={12} color={colors.textMuted} />
            </Text>
          </Pressable>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity onPress={handleToggle} hitSlop={8}>
            <View style={[
              styles.toggleDot,
              enabled && connQuality === 'good' && styles.toggleDotActive,
              enabled && connQuality === 'fair' && { backgroundColor: '#F59E0B' },
              enabled && (connQuality === 'poor' || connQuality === 'bad') && { backgroundColor: '#EF4444' },
            ]} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowHeaderMenu(v => !v)} hitSlop={8}>
            <Feather name="more-vertical" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Header Menu Dropdown */}
      {showHeaderMenu && (
        <Pressable style={headerMenuStyles.overlay} onPress={() => setShowHeaderMenu(false)}>
          <View style={[headerMenuStyles.menu, { top: insets.top + 52 }]}>
            <TouchableOpacity style={headerMenuStyles.item} onPress={() => { setShowHeaderMenu(false); setSearchMode(v => !v); }}>
              <Feather name="search" size={15} color={colors.textMuted} />
              <Text style={headerMenuStyles.itemText}>Suche</Text>
            </TouchableOpacity>
            <TouchableOpacity style={headerMenuStyles.item} onPress={() => { setShowHeaderMenu(false); navigation.navigate('ManagerMemory', { wsService, serverId }); }}>
              <Feather name="database" size={15} color={colors.textMuted} />
              <Text style={headerMenuStyles.itemText}>Memory</Text>
            </TouchableOpacity>
            <TouchableOpacity style={headerMenuStyles.item} onPress={() => { setShowHeaderMenu(false); handlePoll(); }} disabled={!enabled || loading}>
              <Feather name="refresh-cw" size={15} color={enabled ? colors.textMuted : colors.textDim} />
              <Text style={[headerMenuStyles.itemText, (!enabled || loading) && { color: colors.textDim }]}>Aktualisieren</Text>
            </TouchableOpacity>
            {messages.length > 0 && (
              <TouchableOpacity style={headerMenuStyles.item} onPress={() => { setShowHeaderMenu(false); clearSessionMessages(activeChat); setLoading(false); }}>
                <Feather name="trash-2" size={15} color={colors.destructive} />
                <Text style={[headerMenuStyles.itemText, { color: colors.destructive }]}>Chat löschen</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      )}

      {/* Settings Overlay */}
      {showSettings && (
        <Pressable style={settingStyles.overlay} onPress={() => setShowSettings(false)} />
      )}

      {/* Settings Panel */}
      {showSettings && (
        <View style={settingStyles.panel}>
          {/* Agent Name */}
          <View style={settingStyles.nameRow}>
            <TextInput
              style={settingStyles.nameInput}
              value={editName}
              onChangeText={setEditName}
              onEndEditing={() => {
                if (editName.trim() && editName !== personality.agentName) {
                  setPersonality({ agentName: editName.trim() });
                  wsService.send({ type: 'manager:set_personality' as any, payload: { agentName: editName.trim() } });
                }
              }}
              maxLength={20}
              placeholder="Agent Name"
              placeholderTextColor={colors.textDim}
            />
            <Feather name="edit-2" size={12} color={colors.textDim} />
          </View>

          <View style={settingStyles.divider} />

          {/* Cloud / Local Tabs */}
          <View style={settingStyles.tabRow}>
            <TouchableOpacity
              style={[settingStyles.tab, providerTab === 'cloud' && settingStyles.tabActive]}
              onPress={() => setProviderTab('cloud')}
              activeOpacity={0.7}
            >
              <Feather name="cloud" size={12} color={providerTab === 'cloud' ? colors.text : colors.textDim} />
              <Text style={[settingStyles.tabText, providerTab === 'cloud' && settingStyles.tabTextActive]}>Cloud</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[settingStyles.tab, providerTab === 'local' && settingStyles.tabActive]}
              onPress={() => setProviderTab('local')}
              activeOpacity={0.7}
            >
              <Feather name="hard-drive" size={12} color={providerTab === 'local' ? colors.text : colors.textDim} />
              <Text style={[settingStyles.tabText, providerTab === 'local' && settingStyles.tabTextActive]}>Local</Text>
            </TouchableOpacity>
          </View>

          {/* Provider List (filtered by tab) */}
          {providers
            .filter(p => providerTab === 'local' ? !!p.isLocal : !p.isLocal)
            .map((p) => {
              const isActive = p.id === activeProvider;
              const caps = getProviderCaps(p.id);
              return (
                <TouchableOpacity
                  key={p.id}
                  style={[settingStyles.providerRow, isActive && settingStyles.providerRowActive]}
                  onPress={() => handleProviderSwitch(p.id)}
                  disabled={!p.configured}
                  activeOpacity={0.6}
                >
                  <View style={settingStyles.providerLeft}>
                    <View style={[settingStyles.radioOuter, isActive && settingStyles.radioOuterActive]}>
                      {isActive && <View style={settingStyles.radioInner} />}
                    </View>
                    <View>
                      <Text style={[settingStyles.providerName, !p.configured && { color: colors.textDim }]}>{p.name}</Text>
                      {caps && (
                        <View style={settingStyles.capsRow}>
                          {caps.map((cap, i) => (
                            <View key={i} style={settingStyles.capBadge}>
                              <Feather name={cap.icon as any} size={9} color={cap.color} />
                              <Text style={[settingStyles.capText, { color: cap.color }]}>{cap.label}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          {providers.filter(p => providerTab === 'local' ? !!p.isLocal : !p.isLocal).length === 0 && (
            <Text style={settingStyles.emptyTab}>
              {providerTab === 'local' ? 'Kein lokales Modell verfügbar' : 'Keine Cloud-Provider konfiguriert'}
            </Text>
          )}
        </View>
      )}

      {/* Search Bar */}
      {searchMode && (
        <View style={styles.searchBar}>
          <Feather name="search" size={14} color={colors.textDim} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Nachrichten durchsuchen..."
            placeholderTextColor={colors.textDim}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <Text style={styles.searchCount}>{filteredMessages.length}</Text>
          )}
          <TouchableOpacity onPress={() => { setSearchMode(false); setSearchQuery(''); }}>
            <Feather name="x" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      {/* Not enabled banner */}
      {!enabled && (
        <View style={styles.disabledBanner}>
          <Feather name="info" size={16} color={colors.textMuted} />
          <Text style={styles.disabledText}>
            Manager ist deaktiviert. Tippe auf den grünen Punkt, um ihn zu starten.
          </Text>
        </View>
      )}

      {/* Active Tasks — collapsible indicator */}
      {delegatedTasks.length > 0 && (() => {
        const active = delegatedTasks.filter(t => t.status !== 'done');
        const doneCount = delegatedTasks.length - active.length;
        if (active.length === 0) return null;

        return (
          <TouchableOpacity
            style={styles.taskChip}
            activeOpacity={0.7}
            onPress={() => setTaskPanelOpen(v => !v)}
          >
            <View style={styles.taskChipDot} />
            <Text style={styles.taskChipText}>
              {active.length} Aufgabe{active.length > 1 ? 'n' : ''} aktiv
            </Text>
            {doneCount > 0 && <Text style={styles.taskChipDone}>{doneCount} erledigt</Text>}
            <Feather name={taskPanelOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
          </TouchableOpacity>
        );
      })()}

      {/* Expanded task list with steps */}
      {taskPanelOpen && delegatedTasks.length > 0 && (
        <View style={styles.taskPanel}>
          {delegatedTasks.map((task) => {
            const steps = task.steps && task.steps.length > 0 ? task.steps : [{ label: task.description, status: task.status }];

            return (
              <View key={task.id} style={{ marginBottom: 4 }}>
                <Text style={styles.taskRowLabel}>{task.sessionLabel}</Text>
                {steps.map((step, i) => {
                  const isDone = step.status === 'done';
                  const isFailed = step.status === 'failed';
                  const isRunning = step.status === 'running';
                  const isPending = step.status === 'pending';
                  const checkColor = isDone ? '#10B981' : isFailed ? '#EF4444' : isRunning ? colors.primary : colors.textDim;

                  return (
                    <View key={i} style={[styles.taskRow, isPending && { opacity: 0.4 }]}>
                      <View style={[styles.taskCheckbox, { borderColor: checkColor, backgroundColor: isDone ? '#10B981' : isFailed ? '#EF4444' : 'transparent' }]}>
                        {isDone && <Feather name="check" size={11} color="#fff" />}
                        {isFailed && <Feather name="x" size={11} color="#fff" />}
                        {isRunning && <View style={[styles.taskCheckboxDot, { backgroundColor: checkColor }]} />}
                      </View>
                      <Text
                        style={[styles.taskRowDesc, { flex: 1 }, isDone && { textDecorationLine: 'line-through' as const, color: colors.textDim }]}
                        numberOfLines={2}
                      >
                        {step.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      )}

      {/* Message List */}
      <FlatList
        ref={listRef}
        data={reversedMessages}
        extraData={activeChat}
        inverted
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        style={styles.messageList}
        contentContainerStyle={[
          styles.messageListContent,
          filteredMessages.length === 0 && styles.messageListEmpty,
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={200}
        ListEmptyComponent={
          <View style={[styles.emptyState, { transform: [{ scaleY: -1 }] }]}>
            <View style={styles.emptyIcon}>
              <Feather name="cpu" size={32} color={colors.textDim} />
            </View>
            <Text style={styles.emptyTitle}>Manager Agent</Text>
            <Text style={styles.emptySubtitle}>
              {enabled
                ? 'Der Manager überwacht deine Terminals und fasst Aktivitäten alle 15 Min zusammen. Du kannst auch direkt Fragen stellen.'
                : 'Aktiviere den Manager über den grünen Punkt oben rechts, um loszulegen.'}
            </Text>
          </View>
        }
      />

      {/* Thinking / Streaming indicator — shows immediately on send */}
      {(loading || (thinking && thinking.phase !== '')) && <ThinkingBubble
        phase={thinking?.phase || '__sending'}
        streamingText={streamingText}
        requestStartTime={requestStartTime}
        tokenStats={streamTokenStats}
        onCancel={() => {
          setLoading(false);
          setThinking('', undefined, undefined);
          addError('Anfrage abgebrochen', activeChat);
        }}
      />}

      {chatMessages.length > 0 && chatMessages[chatMessages.length - 1]?.isError && !loading && (
        <TouchableOpacity style={styles.retryBtn} onPress={handleRetry}>
          <Feather name="refresh-cw" size={14} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 11, marginLeft: 4 }}>Erneut versuchen</Text>
        </TouchableOpacity>
      )}

      {/* Slash Command Picker */}
      {input.startsWith('/') && (() => {
        const filtered = SLASH_COMMANDS.filter(c =>
          c.cmd.startsWith(input.toLowerCase().split(' ')[0])
        );
        if (filtered.length === 0) return null;
        return (
          <View style={styles.slashPicker}>
            {filtered.map(c => (
              <TouchableOpacity
                key={c.cmd}
                style={styles.slashPickerItem}
                onPress={() => {
                  setInput('');
                  // Execute command directly
                  if (c.cmd === '/sm') {
                    setLoading(true);
                    wsService.send({ type: 'manager:poll', payload: { targetSessionId: activeChat !== 'alle' ? activeChat : undefined } } as any);
                  } else if (c.cmd === '/reset') {
                    setInput('/reset');
                    setTimeout(() => handleSend(), 0);
                    return;
                  } else if (c.cmd === '/clear') {
                    clearSessionMessages(activeChat);
                  } else if (c.cmd === '/memory') {
                    navigation.navigate('ManagerMemory', { wsService, serverId });
                  } else if (c.cmd === '/cron') {
                    setInput('/cron');
                    setTimeout(() => handleSend(), 0);
                    return;
                  } else if (c.cmd === '/ppt') {
                    setInput('/ppt');
                    setTimeout(() => handleSend(), 0);
                    return;
                  } else if (c.cmd === '/help') {
                    addMessage({ role: 'system', text: 'Verfügbare Befehle:\n/sm — Terminal-Zusammenfassung\n/askill — Neuen Skill erstellen\n/cron — Cron Job einrichten\n/ppt — Präsentation erstellen\n/reset — Agent zurücksetzen\n/clear — Chat leeren\n/memory — Memory-Viewer\n/help — Diese Hilfe' });
                  }
                  Keyboard.dismiss();
                }}
              >
                <Text style={styles.slashPickerCmd}>{c.cmd}</Text>
                <Text style={styles.slashPickerDesc}>{c.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      })()}

      {/* Terminal Selector */}
      {tabs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.terminalSelector} contentContainerStyle={styles.terminalSelectorContent}>
          <TouchableOpacity
            style={[styles.terminalChip, activeChat === 'alle' && styles.terminalChipActive]}
            onPress={() => setActiveChat('alle')}
          >
            <Text style={[styles.terminalChipText, activeChat === 'alle' && styles.terminalChipTextActive]}>Alle</Text>
          </TouchableOpacity>
          {tabs.map((tab, idx) => (
            <TouchableOpacity
              key={tab.id}
              style={[styles.terminalChip, activeChat === tab.sessionId && styles.terminalChipActive]}
              onPress={() => setActiveChat(tab.sessionId ?? 'alle')}
              onLongPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setChipMenu({ tabId: tab.id, x: 0, y: 0 });
              }}
            >
              <Text
                style={[
                  styles.terminalChipText,
                  activeChat === tab.sessionId && styles.terminalChipTextActive,
                ]}
                numberOfLines={1}
              >
                {`S${idx + 1} · ${tabDisplayName(tab)}`}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Chip Context Menu */}
      {chipMenu && (() => {
        const menuTab = tabs.find(t => t.id === chipMenu.tabId);
        const menuIdx = tabs.findIndex(t => t.id === chipMenu.tabId);
        const menuLabel = menuTab ? `S${menuIdx + 1} · ${tabDisplayName(menuTab)}` : '';
        return (
          <Modal transparent visible animationType="fade" onRequestClose={() => setChipMenu(null)}>
            <Pressable style={styles.chipMenuOverlay} onPress={() => setChipMenu(null)}>
              <View style={styles.chipMenuSheet}>
                <View style={styles.chipMenuHandle} />
                <Text style={styles.chipMenuTitle}>{menuLabel}</Text>
                <TouchableOpacity
                  style={styles.chipMenuItem}
                  onPress={() => {
                    setChipMenu(null);
                    if (menuTab) {
                      setActiveTab(serverId, menuTab.id);
                      navigation.navigate('Terminal', {
                        serverId,
                        serverName: server?.name ?? '',
                        serverHost: serverHost,
                        serverPort: serverPort,
                        token: serverToken,
                      });
                    }
                  }}
                >
                  <Feather name="terminal" size={18} color={colors.primary} />
                  <Text style={styles.chipMenuText}>Terminal öffnen</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Modal>
        );
      })()}

      {/* Attachment Preview */}
      {attachments.length > 0 && (
        <View style={styles.attachmentRow}>
          {attachments.map((att, idx) => (
            <View key={idx} style={styles.attachmentThumb}>
              <Image source={{ uri: att.uri }} style={styles.attachmentImage} />
              <TouchableOpacity
                style={styles.attachmentRemove}
                onPress={() => removeAttachment(idx)}
                hitSlop={4}
              >
                <Feather name="x" size={10} color={colors.text} />
              </TouchableOpacity>
              {!att.path && (
                <View style={styles.attachmentError}>
                  <Feather name="alert-circle" size={10} color={colors.destructive} />
                </View>
              )}
            </View>
          ))}
          {uploading && (
            <View style={[styles.attachmentThumb, styles.attachmentUploading]}>
              <Feather name="upload" size={16} color={colors.textDim} />
            </View>
          )}
        </View>
      )}

      {/* Input Bar */}
      <View style={[styles.inputBar, { paddingBottom: insets.bottom + spacing.sm }]}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={handlePickImage}
          disabled={!enabled || uploading}
          hitSlop={8}
        >
          <Feather name="image" size={20} color={enabled ? colors.textMuted : colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={handleMicPress}
          disabled={!enabled}
          hitSlop={8}
        >
          <Feather
            name={micState === 'recording' ? 'square' : 'mic'}
            size={20}
            color={micState === 'recording' ? '#EF4444' : enabled ? colors.textMuted : colors.textDim}
          />
        </TouchableOpacity>
        {micState === 'recording' && (
          <Text style={{ color: '#EF4444', fontSize: 11, fontWeight: '600', minWidth: 35 }}>
            {Math.floor(recordingDuration / 60)}:{String(recordingDuration % 60).padStart(2, '0')}
          </Text>
        )}
        {micState === 'processing' && (
          <Text style={{ color: colors.textMuted, fontSize: 11, fontStyle: 'italic' }}>
            Transkribiert...
          </Text>
        )}
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          placeholder={enabled ? 'Nachricht an Manager...' : 'Manager ist deaktiviert'}
          placeholderTextColor={colors.textDim}
          editable={enabled}
          multiline
          maxLength={4000}
          returnKeyType="default"
        />
        <TouchableOpacity
          style={[styles.sendButton, ((!input.trim() && attachments.length === 0) || !enabled) && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={(!input.trim() && attachments.length === 0) || !enabled}
        >
          <Feather name="send" size={18} color={(input.trim() || attachments.length > 0) && enabled ? colors.primary : colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Phase details popup */}
      {lastPhases && (
        <PhasePopup
          phases={lastPhases}
          provider={activeProviderName}
          visible={phasePopupVisible}
          onClose={() => setPhasePopupVisible(false)}
        />
      )}
      {/* Image Lightbox Modal — swipe down to dismiss */}
      <Modal
        visible={!!lightboxImage}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxImage(null)}
        statusBarTranslucent
      >
        <LightboxContent
          imageUri={lightboxImage}
          onClose={() => setLightboxImage(null)}
          serverHost={serverHost}
          serverPort={serverPort}
        >
          <View style={styles.lightboxActions}>
            <TouchableOpacity
              style={styles.lightboxBtn}
              onPress={async () => {
                if (!lightboxImage) return;
                try {
                  const filename = `agent_image_${Date.now()}.png`;
                  const localUri = FileSystem.cacheDirectory + filename;
                  await FileSystem.downloadAsync(lightboxImage, localUri);
                  await Sharing.shareAsync(localUri, { mimeType: 'image/png', dialogTitle: 'Bild speichern' });
                } catch {
                  Alert.alert('Fehler', 'Bild konnte nicht gespeichert werden.');
                }
              }}
            >
              <Feather name="download" size={20} color="#fff" />
              <Text style={styles.lightboxBtnText}>Speichern</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.lightboxBtn}
              onPress={async () => {
                if (!lightboxImage) return;
                try {
                  const filename = `agent_image_${Date.now()}.png`;
                  const localUri = FileSystem.cacheDirectory + filename;
                  await FileSystem.downloadAsync(lightboxImage, localUri);
                  await Sharing.shareAsync(localUri, { mimeType: 'image/png' });
                } catch {
                  Alert.alert('Fehler', 'Teilen fehlgeschlagen.');
                }
              }}
            >
              <Feather name="share-2" size={20} color="#fff" />
              <Text style={styles.lightboxBtnText}>Teilen</Text>
            </TouchableOpacity>
          </View>
        </LightboxContent>
      </Modal>
      {/* Presentation Viewer Modal */}
      <PresentationViewer
        visible={!!activePres}
        url={activePres?.url ?? ''}
        title={activePres?.title ?? ''}
        onClose={() => setActivePres(null)}
      />
    </KeyboardAvoidingView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerCenter: {
    flex: 1,
    marginLeft: spacing.md,
  },
  headerTitle: {
    color: colors.text,
    fontSize: fontSizes.lg,
    fontWeight: '700',
  },
  headerSubtitle: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    marginTop: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  toggleDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.textDim,
  },
  toggleDotActive: {
    backgroundColor: colors.accent,
  },

  // Settings Panel
  // (settings panel styles moved to settingStyles)

  // Search Bar
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
  },
  searchCount: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  // (provider styles moved to settingStyles)

  // Disabled Banner
  disabledBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceAlt,
  },
  disabledText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    flex: 1,
  },

  // Messages
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  messageListEmpty: {
    flex: 1,
    justifyContent: 'center',
  },

  // Empty State
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: fontSizes.lg,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Thinking Bubble — chat bubble style
  // (thinking styles moved to stripStyles)

  // Phase Chip
  phaseChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
  },
  phaseChipText: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },

  // Phase Popup
  popupOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  popupContent: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: spacing.lg,
    width: '80%',
    maxWidth: 320,
  },
  popupTitle: {
    color: colors.text,
    fontSize: fontSizes.md,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  popupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  popupPhase: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  popupDuration: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontFamily: 'monospace',
  },
  popupTotal: {
    borderBottomWidth: 0,
    marginTop: 4,
  },
  popupTotalLabel: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontWeight: '700',
  },
  popupTotalDuration: {
    color: colors.primary,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  popupProvider: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  avatarContainer: {
    marginLeft: spacing.sm,
  },
  headerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  headerAvatarPlaceholder: {
    backgroundColor: colors.surface,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderWidth: 1,
    borderColor: colors.border,
  },
  messageAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    marginRight: 6,
    marginTop: 2,
    alignSelf: 'flex-end' as const,
  },
  messageAvatarPlaceholder: {
    backgroundColor: colors.surface,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  messageRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '80%',
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexShrink: 1,
  },
  bubbleAssistant: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 4,
    maxWidth: undefined,
    flex: 1,
  },
  bubbleUser: {
    backgroundColor: colors.primary + '22',
    borderTopRightRadius: 4,
  },
  bubbleSystem: {
    backgroundColor: colors.warning + '18',
    borderRadius: 10,
  },
  messageText: {
    color: colors.text,
    fontSize: fontSizes.sm,
    lineHeight: 20,
  },
  messageTextSystem: {
    color: colors.warning,
    fontSize: fontSizes.xs,
  },
  timestampRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: spacing.xs,
    gap: 6,
  },
  timestamp: {
    color: colors.textDim,
    fontSize: 10,
  },
  durationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(100, 116, 139, 0.12)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 6,
  },
  durationText: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '500' as const,
  },

  // Session Chips
  sessionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  sessionChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.surfaceAlt,
  },
  sessionChipActive: {
    backgroundColor: colors.accent + '30',
  },
  sessionChipText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },

  // Actions
  actions: {
    marginTop: spacing.xs,
    gap: 4,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  actionText: {
    color: colors.accent,
    fontSize: fontSizes.xs,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },

  // Loading
  loadingRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontStyle: 'italic',
  },

  // Slash Command Picker
  slashPicker: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 4,
  },
  slashPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    gap: spacing.sm,
  },
  slashPickerCmd: {
    color: colors.primary,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    fontFamily: 'monospace',
    minWidth: 60,
  },
  slashPickerDesc: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },

  // Terminal Selector
  terminalSelector: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    flexGrow: 0,
  },
  terminalSelectorContent: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  terminalChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
  },
  terminalChipActive: {
    backgroundColor: colors.primary + '30',
  },
  terminalChipText: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontWeight: '500',
  },
  terminalChipTextActive: {
    color: colors.primary,
  },

  // Chip Context Menu
  chipMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  chipMenuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    paddingBottom: 24,
    paddingHorizontal: 16,
  },
  chipMenuHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textDim,
    alignSelf: 'center',
    marginBottom: 12,
    opacity: 0.4,
  },
  chipMenuTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
    paddingHorizontal: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chipMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    gap: 12,
  },
  chipMenuText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },

  // Attachments
  attachmentRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  attachmentThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  attachmentImage: {
    width: '100%',
    height: '100%',
  },
  attachmentRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentError: {
    position: 'absolute',
    bottom: 2,
    right: 2,
  },
  attachmentUploading: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  attachButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Input Bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  textInput: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: fontSizes.sm,
    maxHeight: 100,
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },

  // Scroll-to-bottom button
  scrollToBottomBtn: {
    position: 'absolute',
    right: 12,
    bottom: 180,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Retry button
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginLeft: 12,
    marginBottom: 4,
  },

  // Date separators
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 12,
    gap: 8,
  },
  dateSepLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  dateSepText: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '500',
  },
  taskChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginLeft: 12,
    marginVertical: 4,
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
  },
  taskChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  taskChipText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '600' as const,
  },
  taskChipDone: {
    color: '#10B981',
    fontSize: 10,
  },
  taskPanel: {
    marginHorizontal: 12,
    marginBottom: 4,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border + '30',
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 4,
  },
  taskCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: 1,
  },
  taskCheckboxDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  taskRowLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600' as const,
  },
  taskRowAge: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '400' as const,
    fontFamily: 'monospace',
  },
  taskRowDesc: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 1,
    lineHeight: 14,
  },
  lightboxOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightboxClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  lightboxImage: {
    width: '100%',
    height: '70%',
  },
  lightboxActions: {
    position: 'absolute',
    bottom: 50,
    flexDirection: 'row',
    gap: 24,
  },
  lightboxBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
  },
  lightboxBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

});

const stripStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  strip: {
    backgroundColor: '#1B2336',
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.04)',
  },
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 10,
  },
  eqWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2.5,
    height: 16,
  },
  eqBar: {
    width: 3,
    height: 12,
    borderRadius: 1.5,
  },
  eqBarTall: {
    width: 3,
    height: 16,
    borderRadius: 1.5,
  },
  phase: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '500',
  },
  phaseDim: {
    color: colors.textDim,
    fontStyle: 'italic' as const,
  },
  spacer: {
    flex: 1,
  },
  stats: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  stat: {
    fontSize: 9,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    color: colors.textDim,
  },
  statVal: {
    fontWeight: '600',
    color: colors.textMuted,
  },
  time: {
    fontSize: 10,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    color: colors.textDim,
    minWidth: 32,
    textAlign: 'right',
  },
  progressTrack: {
    height: 2,
    backgroundColor: 'rgba(59,130,246,0.06)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  streamWrap: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148,163,184,0.04)',
  },
  cancel: {
    fontSize: 10,
    color: colors.textDim,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
});

const headerMenuStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
  },
  menu: {
    position: 'absolute',
    right: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    minWidth: 180,
    zIndex: 51,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 10,
  },
  itemText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '400',
  },
});

const settingStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 9,
  },
  panel: {
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    zIndex: 10,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nameInput: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    paddingVertical: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 12,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 8,
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 3,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    borderRadius: 6,
  },
  tabActive: {
    backgroundColor: colors.surfaceAlt,
  },
  tabText: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '500',
  },
  tabTextActive: {
    color: colors.text,
  },
  emptyTab: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 16,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginVertical: 1,
  },
  providerRowActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.06)',
  },
  providerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  radioOuter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterActive: {
    borderColor: colors.primary,
  },
  radioInner: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  providerName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  capsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 3,
  },
  capBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  capText: {
    fontSize: 9,
    fontWeight: '500',
  },
});

const presCardStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  cardSub: {
    color: colors.textDim,
    fontSize: 11,
    marginTop: 2,
  },
});
