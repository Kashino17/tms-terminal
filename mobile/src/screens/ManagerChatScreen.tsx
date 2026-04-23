import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  Dimensions,
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
import { VoiceMessagePlayer } from '../components/VoiceMessagePlayer';

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

// ── Search Highlight Helpers ─────────────────────────────────────────────────

/** Highlight search matches in plain text — returns Text elements with yellow background */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let idx = lower.indexOf(qLower);
  let key = 0;
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <Text key={key++} style={{ backgroundColor: 'rgba(250,204,21,0.3)', color: '#FBBF24', borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </Text>
    );
    lastIdx = idx + query.length;
    idx = lower.indexOf(qLower, lastIdx);
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : text;
}

/** Wrap search matches in markdown bold for Markdown renderer highlighting */
function highlightMarkdown(text: string, query: string): string {
  if (!query) return text;
  // Escape regex special chars in query
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '**$1**');
}

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

// ── Command Wizard Data ───────────────────────────────────────────────────

interface WizardOption {
  icon: string;
  label: string;
  hint?: string;
  value: string;
}

interface WizardStep {
  question: string;
  options: WizardOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
}

interface WizardFlow {
  cmd: string;
  title: string;
  icon: string;
  steps: WizardStep[];
  buildPrompt: (answers: string[]) => string;
}

const WIZARD_FLOWS: Record<string, WizardFlow> = {
  '/ppt': {
    cmd: '/ppt', title: 'Präsentation', icon: '📊',
    steps: [
      {
        question: 'Worüber soll die Präsentation sein?',
        options: [
          { icon: '📈', label: 'Projekt-Status', hint: 'Aktueller Stand aller Terminals & Tasks', value: 'Projekt-Status: aktueller Stand aller Terminals, Tasks und Fortschritt' },
          { icon: '🧠', label: 'Memory & Learnings', hint: 'Was ich gelernt habe', value: 'Memory-Übersicht: alles was du über mich, meine Projekte und Workflows gelernt hast' },
          { icon: '⚡', label: 'Tech-Stack', hint: 'Technologien & Architektur', value: 'Technologie-Stack und Architektur-Übersicht aller aktiven Projekte' },
        ],
        allowCustom: true, customPlaceholder: 'Eigenes Thema...',
      },
      {
        question: 'Welcher Stil?',
        options: [
          { icon: '📋', label: 'Kompakt & Daten', hint: 'Charts, Stats, wenig Text', value: 'kompakt und daten-fokussiert mit Charts und Stats' },
          { icon: '📝', label: 'Ausführlich', hint: 'Mehr Text und Kontext', value: 'ausführlich mit Erklärungen und Kontext' },
          { icon: '🎨', label: 'Visuell & Creative', hint: 'Gradients, Animationen', value: 'visuell ansprechend mit Gradients und Animationen' },
        ],
      },
    ],
    buildPrompt: (a) => `[PRÄSENTATION] Erstelle eine Präsentation zum Thema: "${a[0]}". Stil: ${a[1]}. Nutze create_presentation mit 5-8 Slides.`,
  },
  '/cron': {
    cmd: '/cron', title: 'Cron Job', icon: '⏰',
    steps: [
      {
        question: 'Was soll automatisiert werden?',
        options: [
          { icon: '🔄', label: 'Git Status Check', hint: 'Alle Repos prüfen', value: 'Git Status in allen Projekt-Verzeichnissen prüfen' },
          { icon: '🧪', label: 'Tests laufen lassen', hint: 'npm test / pytest', value: 'Automatische Tests laufen lassen' },
          { icon: '📊', label: 'Status-Report', hint: 'Terminal-Zusammenfassung', value: 'Regelmäßiger Status-Report aller Terminals' },
        ],
        allowCustom: true, customPlaceholder: 'Eigene Aufgabe...',
      },
      {
        question: 'Wie oft?',
        options: [
          { icon: '⚡', label: 'Alle 15 Min', value: '*/15 * * * *' },
          { icon: '🕐', label: 'Alle 30 Min', value: '*/30 * * * *' },
          { icon: '🕑', label: 'Stündlich', value: '0 */1 * * *' },
          { icon: '📅', label: 'Täglich', value: '0 0 * * *' },
        ],
        allowCustom: true, customPlaceholder: 'Eigener Zeitplan (z.B. alle 2h)...',
      },
      {
        question: 'Braucht es Claude oder reicht ein Shell-Befehl?',
        options: [
          { icon: '💻', label: 'Shell-Befehl', hint: 'git status, npm test, etc.', value: 'simple' },
          { icon: '🤖', label: 'Claude Code', hint: 'Für komplexe Aufgaben', value: 'claude' },
        ],
      },
    ],
    buildPrompt: (a) => `[CRON-SETUP] Erstelle einen Cron Job: Aufgabe="${a[0]}", Zeitplan="${a[1]}", Typ="${a[2]}". Nutze create_cron_job direkt.`,
  },
  '/askill': {
    cmd: '/askill', title: 'Skill erstellen', icon: '⚡',
    steps: [
      {
        question: 'Was für einen Skill brauchst du?',
        options: [
          { icon: '🎬', label: 'Media-Konvertierung', hint: 'Video, Audio, Bilder', value: 'Media-Konvertierung (Video, Audio, Bilder umwandeln)' },
          { icon: '📦', label: 'Daten-Verarbeitung', hint: 'CSV, JSON, APIs', value: 'Daten-Verarbeitung (CSV, JSON, API-Calls, Scraping)' },
          { icon: '🔧', label: 'System-Automatisierung', hint: 'Cleanup, Backups', value: 'System-Automatisierung (Cleanup, Backups, Monitoring)' },
        ],
        allowCustom: true, customPlaceholder: 'Eigene Idee...',
      },
      {
        question: 'Welche Tools/Dependencies?',
        options: [
          { icon: '🎥', label: 'ffmpeg', hint: 'Video/Audio', value: 'ffmpeg' },
          { icon: '🖼️', label: 'ImageMagick', hint: 'Bildverarbeitung', value: 'imagemagick' },
          { icon: '🐍', label: 'Python', hint: 'Script-basiert', value: 'python3' },
          { icon: '📦', label: 'Node.js', hint: 'JavaScript', value: 'node' },
        ],
        allowCustom: true, customPlaceholder: 'Andere Dependencies...',
      },
    ],
    buildPrompt: (a) => `[SKILL-ERSTELLUNG] Erstelle einen Skill: "${a[0]}". Dependencies: ${a[1]}. Nutze self_education Tool.`,
  },
};

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
const QWEN_CAPS = [
  { icon: 'tool', label: 'Tools', color: '#60A5FA' },
  { icon: 'cpu', label: 'Reasoning', color: '#4ADE80' },
  { icon: 'code', label: 'Code', color: '#A78BFA' },
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
  // Qwen 3 local variants
  'qwen-27b': QWEN_CAPS,
  'qwen-35b': QWEN_CAPS,
};

/** Look up capabilities for a provider, with fuzzy fallback for gemma/qwen variants */
function getProviderCaps(id: string): Array<{ icon: string; label: string; color: string }> | undefined {
  if (PROVIDER_CAPS[id]) return PROVIDER_CAPS[id];
  // Fallback: any qwen model gets code-focused caps
  if (id.includes('qwen')) return QWEN_CAPS;
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

        {/* Streaming text (scrollable, max 50% screen height) */}
        {isStreaming && (
          <ScrollView
            style={stripStyles.streamWrap}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <Markdown style={mdStyles}>{streamingText.length > 2000 ? streamingText.slice(-2000) : streamingText}</Markdown>
          </ScrollView>
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
    delegatedTasks, ttsEvent, ttsAudioMap, setTtsAudioEntry,
    modelStatus, setModelStatus,
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
  const [drillDownAnswer, setDrillDownAnswer] = useState<string | null>(null);
  const [drillDownLoading, setDrillDownLoading] = useState(false);
  // TTS audio cache: messageId → { url, duration } — initialized from persisted store
  const [ttsAudio, setTtsAudio] = useState<Record<string, { url: string; duration: number }>>(() => {
    // Restore from persisted ttsAudioMap on mount
    const restored: Record<string, { url: string; duration: number }> = {};
    for (const [msgId, entry] of Object.entries(ttsAudioMap)) {
      restored[msgId] = {
        url: `http://${serverHost}:${serverPort}/generated-tts/${encodeURIComponent(entry.filename)}?token=${serverToken}`,
        duration: entry.duration,
      };
    }
    return restored;
  });
  const [ttsLoading, setTtsLoading] = useState<Set<string>>(new Set());
  const [ttsProgress, setTtsProgress] = useState<Record<string, { chunk: number; total: number }>>({});
  const [ttsVersion, setTtsVersion] = useState(0); // bump to force FlatList re-render
  const [wizard, setWizard] = useState<{ flow: WizardFlow; step: number; answers: string[] } | null>(null);
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

  // Process TTS events from the store (set by TerminalScreen persistent listener)
  useEffect(() => {
    console.log('[TTS] ttsEvent changed:', ttsEvent?.type, ttsEvent?.payload?.messageId);
    if (!ttsEvent) return;
    const { type, payload } = ttsEvent;
    if (type === 'tts:result' && payload?.messageId && payload?.filename) {
      const audioUrl = `http://${serverHost}:${serverPort}/generated-tts/${encodeURIComponent(payload.filename)}?token=${serverToken}`;
      setTtsAudio(prev => ({ ...prev, [payload.messageId]: { url: audioUrl, duration: payload.duration ?? 0 } }));
      setTtsLoading(prev => { const n = new Set(prev); n.delete(payload.messageId); return n; });
      setTtsProgress(prev => { const n = { ...prev }; delete n[payload.messageId]; return n; });
      setTtsVersion(v => v + 1);
      // Persist to store so it survives app restart
      setTtsAudioEntry(payload.messageId, payload.filename, payload.duration ?? 0);
    } else if (type === 'tts:progress' && payload?.messageId) {
      setTtsProgress(prev => ({ ...prev, [payload.messageId]: { chunk: payload.chunk, total: payload.total } }));
      setTtsVersion(v => v + 1);
    } else if (type === 'tts:error' && payload?.messageId) {
      setTtsLoading(prev => { const n = new Set(prev); n.delete(payload.messageId); return n; });
      setTtsProgress(prev => { const n = { ...prev }; delete n[payload.messageId]; return n; });
      setTtsVersion(v => v + 1);
    }
  }, [ttsEvent]);

  // Forward AI answer to presentation drill-down overlay
  useEffect(() => {
    if (!activePres || !drillDownLoading) return;
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.text && !loading) {
      setDrillDownAnswer(lastMsg.text);
      setDrillDownLoading(false);
    }
  }, [messages.length, loading, activePres, drillDownLoading]);

  // ── WS Message Listener (audio only — manager:* handled persistently in TerminalScreen)

  useEffect(() => {
    const handler = (data: unknown) => {
      const msg = data as { type: string; sessionId?: string; payload?: any };
      if (!msg.type?.startsWith('audio:')) return;
      // Only handle transcriptions that were sent from THIS screen (sessionId='manager')
      // Terminal transcriptions have a terminal sessionId and are handled by TerminalToolbar
      if (msg.sessionId && msg.sessionId !== 'manager') return;

      switch (msg.type) {
        case 'audio:transcription':
          if (msg.payload?.text) {
            setInput((prev) => prev + (prev ? ' ' : '') + msg.payload.text);
          }
          setMicState('idle');
          setRecordingDuration(0);
          break;
        case 'audio:progress':
          if (msg.payload?.chunk && msg.payload?.total) {
            setMicState('processing');
            setRecordingDuration(-(msg.payload.chunk));
          }
          break;
        case 'audio:error':
          // busy = another transcription is still running; ignore silently.
          if (msg.payload?.busy) break;
          addError(msg.payload?.message ?? 'Transkription fehlgeschlagen');
          setMicState('idle');
          setRecordingDuration(0);
          break;
      }
    };

    const unsub1 = wsService.addMessageListener(handler);
    return unsub1;
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

  // ── Mic watchdog: reset button if server goes silent ─────────────────────
  useEffect(() => {
    if (micState !== 'processing') return;
    const t = setTimeout(() => {
      console.warn('[mic] watchdog fired — server never responded');
      addError('Transkription reagiert nicht. Bitte erneut versuchen.');
      setMicState('idle');
      setRecordingDuration(0);
    }, 60_000);
    return () => clearTimeout(t);
  }, [micState]);

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

  // Search: show ALL messages but highlight matches (don't filter)
  const filteredMessages = chatMessages;
  const searchMatchCount = searchQuery
    ? chatMessages.filter(m => m.text.toLowerCase().includes(searchQuery.toLowerCase())).length
    : 0;

  // ── Toggle Manager ────────────────────────────────────────────────────────

  const handleToggle = useCallback(() => {
    const next = !enabled;
    wsService.send({ type: 'manager:toggle', payload: { enabled: next } });
  }, [enabled, wsService]);

  // ── Send Chat ─────────────────────────────────────────────────────────────

  const isSendingRef = useRef(false);

  const handleSend = useCallback((customTextOrEvent?: string | unknown) => {
    // Guard: prevent ghost-touch / double-tap duplicate sends
    if (isSendingRef.current) return;

    // Guard: onPress passes a GestureResponderEvent, not a string
    const customText = typeof customTextOrEvent === 'string' ? customTextOrEvent : undefined;
    const text = (customText ?? input).trim();
    if (!text && attachments.length === 0) return;

    isSendingRef.current = true;

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
      // Commands with wizard flow
      if (cmd === '/askill' || cmd === '/cron' || cmd === '/ppt') {
        const extra = text.slice(cmd.length).trim();
        if (extra) {
          // User typed description after command — skip wizard, send directly
          const prompts: Record<string, string> = {
            '/ppt': `[PRÄSENTATION] Erstelle eine Präsentation: "${extra}". Nutze create_presentation mit 5-8 Slides.`,
            '/cron': `[CRON-SETUP] Erstelle einen Cron Job: "${extra}". Nutze create_cron_job.`,
            '/askill': `[SKILL-ERSTELLUNG] Erstelle einen Skill: "${extra}". Nutze self_education Tool.`,
          };
          addMessage({ role: 'user', text: `${cmd} ${extra}`, targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
          setLoading(true);
          wsService.send({ type: 'manager:chat', payload: { text: prompts[cmd], targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: false } });
        } else {
          // No description — start wizard
          const flow = WIZARD_FLOWS[cmd];
          if (flow) {
            addMessage({ role: 'user', text: cmd, targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
            setWizard({ flow, step: 0, answers: [] });
          }
        }
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
    if (!customText) setInput('');
    setAttachments([]);
    Keyboard.dismiss();
  }, [input, attachments, activeChat, wsService, addMessage, setLoading, clearSessionMessages, setPersonality, setOnboarded, onboarded, navigation, serverId]);

  // ── Manual Poll ───────────────────────────────────────────────────────────

  // ── Wizard Option Selection ─────────────────────────────────────────────

  const handleWizardSelect = useCallback((value: string) => {
    if (!wizard) return;
    const { flow, step, answers } = wizard;
    const newAnswers = [...answers, value];

    // Show user's choice as a message
    addMessage({ role: 'user', text: value, targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);

    if (step + 1 < flow.steps.length) {
      // Advance to next step
      setWizard({ flow, step: step + 1, answers: newAnswers });
    } else {
      // Final step — build prompt and send
      setWizard(null);
      const prompt = flow.buildPrompt(newAnswers);
      setLoading(true);
      wsService.send({ type: 'manager:chat', payload: { text: prompt, targetSessionId: activeChat !== 'alle' ? activeChat : undefined, onboarding: false } });
    }
  }, [wizard, wsService, activeChat, addMessage, setLoading]);

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
        wsService.send({
          type: 'audio:transcribe',
          sessionId: 'manager',
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

  // ── Reset send guard when loading finishes ────────────────────────────────
  useEffect(() => {
    if (!loading) isSendingRef.current = false;
  }, [loading]);

  // ── Model-load status: pulse online-dot on 'ready', auto-clear after 2s ──
  const dotPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (modelStatus?.state !== 'ready') return;
    // Pulse 2× then clear the status so the banner disappears.
    const pulse = Animated.sequence([
      Animated.timing(dotPulse, { toValue: 1.8, duration: 280, useNativeDriver: true }),
      Animated.timing(dotPulse, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(dotPulse, { toValue: 1.8, duration: 280, useNativeDriver: true }),
      Animated.timing(dotPulse, { toValue: 1, duration: 280, useNativeDriver: true }),
    ]);
    pulse.start();
    const clearTimer = setTimeout(() => setModelStatus(null), 2000);
    return () => { pulse.stop(); clearTimeout(clearTimer); };
  }, [modelStatus?.state, modelStatus?.readyAt, dotPulse, setModelStatus]);

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
                {searchQuery ? highlightText(item.text, searchQuery) : item.text}
              </Text>
            ) : (
              <Markdown style={searchQuery ? { ...mdStyles, strong: { ...mdStyles.strong, backgroundColor: 'rgba(250,204,21,0.25)', color: '#FBBF24' } } : mdStyles}>
                {searchQuery ? highlightMarkdown(item.text, searchQuery) : item.text}
              </Markdown>
            )}

            {/* TTS Voice Player (WhatsApp-style) */}
            {item.role === 'assistant' && ttsAudio[item.id] && (
              <VoiceMessagePlayer
                audioUrl={ttsAudio[item.id].url}
                duration={ttsAudio[item.id].duration}
              />
            )}

            {/* TTS: Loading state OR Vorlesen button */}
            {item.role === 'assistant' && !ttsAudio[item.id] && item.text.length > 5 && (
              ttsLoading.has(item.id) ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingVertical: 4 }}>
                  <ActivityIndicator size="small" color="#64748B" />
                  <Text style={{ fontSize: 11, color: '#64748B' }}>
                    {ttsProgress[item.id] ? `Vertont ${ttsProgress[item.id].chunk}/${ttsProgress[item.id].total}...` : 'Wird vertont...'}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingVertical: 4 }}
                  onPress={() => {
                    setTtsLoading(prev => new Set(prev).add(item.id));
                    setTtsVersion(v => v + 1);
                    wsService.send({ type: 'tts:generate', payload: { text: item.text, messageId: item.id } } as any);
                  }}
                >
                  <Feather name="volume-2" size={13} color="#64748B" />
                  <Text style={{ fontSize: 11, color: '#64748B' }}>Vorlesen</Text>
                </TouchableOpacity>
              )
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
                      onPress={() => {
                        // Extract title from message text (AI usually mentions it)
                        const presTitle = item.text.match(/(?:Präsentation|Presentation)[:\s]*["„]?([^"""\n]{5,60})/i)?.[1]?.trim()
                          || pres.replace(/^pres_\d+\.html$/, 'Präsentation');
                        setActivePres({ url: presUrl, title: presTitle });
                      }}
                      style={presCardStyles.card}
                    >
                      <Feather name="monitor" size={20} color={colors.primary} />
                      <View style={presCardStyles.cardContent}>
                        <Text style={presCardStyles.cardTitle} numberOfLines={1}>
                          {item.text.match(/(?:Präsentation|Presentation)[:\s]*["„]?([^"""\n]{5,60})/i)?.[1]?.trim() || 'Präsentation'}
                        </Text>
                        <Text style={presCardStyles.cardSub}>
                          {(() => {
                            const ts = pres.match(/pres_(\d+)/)?.[1];
                            if (!ts) return 'Tippen zum Anzeigen';
                            const d = new Date(parseInt(ts, 10));
                            return `${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · Tippen zum Anzeigen`;
                          })()}
                        </Text>
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
  }, [handleMessageLongPress, filteredMessages, reversedMessages, searchQuery, ttsAudio, ttsLoading, ttsProgress]);

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
            <Animated.View style={[
              styles.toggleDot,
              enabled && connQuality === 'good' && styles.toggleDotActive,
              enabled && connQuality === 'fair' && { backgroundColor: '#F59E0B' },
              enabled && (connQuality === 'poor' || connQuality === 'bad') && { backgroundColor: '#EF4444' },
              modelStatus?.state === 'ready' && { transform: [{ scale: dotPulse }] },
            ]} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('Voice' as any, { wsService })}
            hitSlop={8}
            accessibilityLabel="Voice Chat öffnen"
          >
            <Feather name="mic" size={18} color={colors.textMuted} />
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
            <TouchableOpacity style={headerMenuStyles.item} onPress={() => { setShowHeaderMenu(false); navigation.navigate('ManagerArtifacts', { serverId, serverHost, serverPort: server?.port ?? 8767, serverToken: server?.token ?? '' }); }}>
              <Feather name="package" size={15} color={colors.textMuted} />
              <Text style={headerMenuStyles.itemText}>Artefakte</Text>
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
            <Text style={styles.searchCount}>{searchMatchCount}</Text>
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
        const totalSteps = delegatedTasks.reduce((sum, t) => sum + (t.steps?.length ?? 1), 0);
        const doneSteps = delegatedTasks.reduce((sum, t) => sum + (t.steps?.filter(s => s.status === 'done').length ?? (t.status === 'done' ? 1 : 0)), 0);
        const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
        if (active.length === 0 && doneCount === 0) return null;

        return (
          <TouchableOpacity
            style={styles.taskChip}
            activeOpacity={0.7}
            onPress={() => setTaskPanelOpen(v => !v)}
          >
            <View style={styles.taskChipDot} />
            <Text style={styles.taskChipText}>
              {active.length > 0 ? `${active.length} aktiv` : 'Fertig'}
            </Text>
            <Text style={styles.taskChipProgress}>{progress}%</Text>
            {doneCount > 0 && <Text style={styles.taskChipDone}>{doneCount} ✓</Text>}
            <Feather name={taskPanelOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
          </TouchableOpacity>
        );
      })()}

      {/* Expanded task list with steps */}
      {taskPanelOpen && delegatedTasks.length > 0 && (
        <View style={styles.taskPanel}>
          {/* Progress bar */}
          {(() => {
            const totalSteps = delegatedTasks.reduce((sum, t) => sum + (t.steps?.length ?? 1), 0);
            const doneSteps = delegatedTasks.reduce((sum, t) => sum + (t.steps?.filter(s => s.status === 'done').length ?? (t.status === 'done' ? 1 : 0)), 0);
            const pct = totalSteps > 0 ? (doneSteps / totalSteps) * 100 : 0;
            return (
              <View style={styles.taskProgressWrap}>
                <View style={[styles.taskProgressBar, { width: `${pct}%` as any }]} />
              </View>
            );
          })()}

          {delegatedTasks.map((task) => {
            const steps = task.steps && task.steps.length > 0 ? task.steps : [{ label: task.description, status: task.status }];
            const taskDone = task.status === 'done' || steps.every(s => s.status === 'done');
            const taskRunning = steps.some(s => s.status === 'running');
            const taskStepsDone = steps.filter(s => s.status === 'done').length;
            const age = Math.round((Date.now() - task.createdAt) / 1000);
            const ageStr = age > 3600 ? `${Math.round(age / 3600)}h` : age > 60 ? `${Math.round(age / 60)}min` : `${age}s`;

            // Find current running step index for "next up" logic
            const runningIdx = steps.findIndex(s => s.status === 'running');
            const nextIdx = runningIdx >= 0 ? runningIdx + 1 : steps.findIndex(s => s.status === 'pending');

            return (
              <View key={task.id} style={[styles.taskGroup, taskDone && styles.taskGroupDone]}>
                {/* Task header */}
                <View style={styles.taskGroupHeader}>
                  <View style={[styles.taskStatusDot, taskDone ? styles.taskStatusDone : taskRunning ? styles.taskStatusRunning : styles.taskStatusPending]} />
                  <Text style={[styles.taskRowLabel, taskDone && { color: colors.textDim }]} numberOfLines={1}>{task.sessionLabel}</Text>
                  <Text style={styles.taskMeta}>{taskStepsDone}/{steps.length}</Text>
                  <Text style={styles.taskAge}>{ageStr}</Text>
                </View>

                {steps.map((step, i) => {
                  const isDone = step.status === 'done';
                  const isFailed = step.status === 'failed';
                  const isRunning = step.status === 'running';
                  const isPending = step.status === 'pending';
                  const isNext = i === nextIdx && !isDone && !isRunning;

                  return (
                    <View key={i} style={[styles.taskRow, isPending && !isNext && { opacity: 0.3 }]}>
                      <View style={[
                        styles.taskCheckbox,
                        { borderColor: isDone ? '#10B981' : isFailed ? '#EF4444' : isRunning ? colors.primary : isNext ? '#F59E0B' : colors.textDim },
                        (isDone || isFailed) && { backgroundColor: isDone ? '#10B981' : '#EF4444' },
                      ]}>
                        {isDone && <Feather name="check" size={10} color="#fff" />}
                        {isFailed && <Feather name="x" size={10} color="#fff" />}
                        {isRunning && <View style={[styles.taskCheckboxDot, { backgroundColor: colors.primary }]} />}
                        {isNext && <Feather name="arrow-right" size={8} color="#F59E0B" />}
                      </View>
                      <Text
                        style={[
                          styles.taskRowDesc,
                          { flex: 1 },
                          isDone && { textDecorationLine: 'line-through' as const, color: colors.textDim },
                          isRunning && { color: colors.text, fontWeight: '500' as const },
                          isNext && { color: '#F59E0B' },
                        ]}
                        numberOfLines={2}
                      >
                        {step.label}
                      </Text>
                      {isRunning && <Text style={styles.taskRunningBadge}>LÄUFT</Text>}
                      {isNext && <Text style={styles.taskNextBadge}>NEXT</Text>}
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
        extraData={`${activeChat}-${ttsVersion}`}
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

      {/* Wizard Card — interactive command flow */}
      {wizard && (
        <View style={wizardStyles.wrap}>
          <View style={wizardStyles.bubble}>
            <View style={wizardStyles.labelRow}>
              <Text style={wizardStyles.labelBadge}>{wizard.flow.icon} {wizard.flow.title}</Text>
            </View>
            {/* Progress dots */}
            <View style={wizardStyles.progress}>
              {wizard.flow.steps.map((_, i) => (
                <View key={i} style={[
                  wizardStyles.pDot,
                  i < wizard.step && wizardStyles.pDotDone,
                  i === wizard.step && wizardStyles.pDotActive,
                ]} />
              ))}
            </View>
            <Text style={wizardStyles.question}>{wizard.flow.steps[wizard.step].question}</Text>
            <View style={wizardStyles.options}>
              {wizard.flow.steps[wizard.step].options.map((opt, i) => (
                <TouchableOpacity
                  key={i}
                  style={wizardStyles.optBtn}
                  activeOpacity={0.7}
                  onPress={() => handleWizardSelect(opt.value)}
                >
                  <Text style={wizardStyles.optIcon}>{opt.icon}</Text>
                  <View style={wizardStyles.optText}>
                    <Text style={wizardStyles.optLabel}>{opt.label}</Text>
                    {opt.hint && <Text style={wizardStyles.optHint}>{opt.hint}</Text>}
                  </View>
                  <Feather name="chevron-right" size={14} color="#334155" />
                </TouchableOpacity>
              ))}
              {wizard.flow.steps[wizard.step].allowCustom && (
                <TouchableOpacity
                  style={[wizardStyles.optBtn, { borderStyle: 'dashed' as any }]}
                  activeOpacity={0.7}
                  onPress={() => {
                    setWizard(null);
                    setInput(`${wizard.flow.cmd} `);
                  }}
                >
                  <Text style={wizardStyles.optIcon}>✏️</Text>
                  <View style={wizardStyles.optText}>
                    <Text style={wizardStyles.optLabel}>Eigene Eingabe...</Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity onPress={() => setWizard(null)}>
              <Text style={wizardStyles.cancel}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Thinking / Streaming indicator — shows immediately on send */}
      {(loading || (thinking && thinking.phase !== '')) && <ThinkingBubble
        phase={thinking?.phase || '__sending'}
        streamingText={streamingText}
        requestStartTime={requestStartTime}
        tokenStats={streamTokenStats}
        onCancel={() => {
          // Send cancel to server — aborts AI processing
          wsService.send({ type: 'manager:cancel' } as any);
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
                  // Directly execute the command inline (avoids stale closure on input)
                  const cmd = c.cmd;
                  setInput('');
                  Keyboard.dismiss();

                  if (cmd === '/sm') {
                    setLoading(true);
                    wsService.send({ type: 'manager:poll', payload: { targetSessionId: activeChat !== 'alle' ? activeChat : undefined } } as any);
                  } else if (cmd === '/clear') {
                    clearSessionMessages(activeChat);
                  } else if (cmd === '/memory') {
                    navigation.navigate('ManagerMemory', { wsService, serverId });
                  } else if (cmd === '/help') {
                    addMessage({ role: 'system', text: 'Verfügbare Befehle:\n/sm — Terminal-Zusammenfassung\n/askill — Neuen Skill erstellen\n/cron — Cron Job einrichten\n/ppt — Präsentation erstellen\n/reset — Agent zurücksetzen\n/clear — Chat leeren\n/memory — Memory-Viewer\n/help — Diese Hilfe' });
                  } else if (cmd === '/reset') {
                    Alert.alert('Agent zurücksetzen', 'Memory und Persönlichkeit werden gelöscht.', [
                      { text: 'Abbrechen', style: 'cancel' },
                      { text: 'Zurücksetzen', style: 'destructive', onPress: () => {
                        wsService.send({ type: 'manager:memory_write', payload: { section: 'user', data: { name: '', role: '', techStack: [], preferences: [], learnedFacts: [] } } } as any);
                        clearSessionMessages(activeChat);
                        setPersonality({ agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, customInstruction: '' });
                        setOnboarded(false);
                        addMessage({ role: 'system', text: 'Agent wurde zurückgesetzt.' });
                      }},
                    ]);
                  } else if (cmd === '/cron' || cmd === '/ppt' || cmd === '/askill') {
                    // Start wizard flow
                    const flow = WIZARD_FLOWS[cmd];
                    if (flow) {
                      addMessage({ role: 'user', text: cmd, targetSessionId: activeChat !== 'alle' ? activeChat : undefined }, activeChat);
                      setWizard({ flow, step: 0, answers: [] });
                    }
                  }
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

      {/* Model-load status banner */}
      {modelStatus && modelStatus.state !== 'ready' && (
        <View style={[
          styles.modelStatusBanner,
          modelStatus.state === 'error' && styles.modelStatusBannerError,
        ]}>
          {modelStatus.state === 'loading' ? (
            <>
              <Feather name="loader" size={14} color={colors.primary} />
              <Text style={styles.modelStatusText}>
                Lade {providers.find(p => p.id === modelStatus.providerId)?.name ?? modelStatus.modelId}…
                {' '}
                <Text style={styles.modelStatusTimer}>
                  {Math.floor(modelStatus.elapsedMs / 60000)}:
                  {String(Math.floor((modelStatus.elapsedMs % 60000) / 1000)).padStart(2, '0')}
                </Text>
                {modelStatus.message ? <Text style={styles.modelStatusTimer}> · {modelStatus.message}</Text> : null}
              </Text>
            </>
          ) : (
            <>
              <Feather name="alert-circle" size={14} color="#EF4444" />
              <Text style={[styles.modelStatusText, { color: '#EF4444' }]}>
                Laden fehlgeschlagen{modelStatus.message ? `: ${modelStatus.message}` : ''}
              </Text>
              <TouchableOpacity onPress={() => setModelStatus(null)} hitSlop={8}>
                <Feather name="x" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            </>
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
          placeholder={
            modelStatus?.state === 'loading'
              ? 'Warten auf Modell…'
              : enabled ? 'Nachricht an Manager...' : 'Manager ist deaktiviert'
          }
          placeholderTextColor={colors.textDim}
          editable={enabled && modelStatus?.state !== 'loading'}
          multiline
          maxLength={4000}
          returnKeyType="default"
        />
        <TouchableOpacity
          style={[styles.sendButton, ((!input.trim() && attachments.length === 0) || !enabled || loading || modelStatus?.state === 'loading') && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={(!input.trim() && attachments.length === 0) || !enabled || loading || modelStatus?.state === 'loading'}
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
        onClose={() => { setActivePres(null); setDrillDownAnswer(null); setDrillDownLoading(false); }}
        drillDownAnswer={drillDownAnswer}
        drillDownLoading={drillDownLoading}
        onDrillDown={(text, _slideIndex) => {
          // Send question to manager WITHOUT closing the viewer
          setDrillDownAnswer(null);
          setDrillDownLoading(true);
          const question = `Erkläre mir diesen Punkt aus der Präsentation genauer: "${text}"`;
          handleSend(question);
        }}
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
  modelStatusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  modelStatusBannerError: {
    backgroundColor: '#3a1e1e',
  },
  modelStatusText: {
    flex: 1,
    color: colors.text,
    fontSize: fontSizes.sm,
  },
  modelStatusTimer: {
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
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
  taskChipProgress: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  taskChipDone: {
    color: '#10B981',
    fontSize: 10,
  },
  taskPanel: {
    marginHorizontal: 12,
    marginBottom: 4,
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border + '30',
  },
  taskProgressWrap: {
    height: 3,
    backgroundColor: 'rgba(148,163,184,0.06)',
    borderRadius: 2,
    marginBottom: 10,
    overflow: 'hidden' as const,
  },
  taskProgressBar: {
    height: '100%' as any,
    backgroundColor: '#10B981',
    borderRadius: 2,
  },
  taskGroup: {
    marginBottom: 10,
  },
  taskGroupDone: {
    opacity: 0.5,
  },
  taskGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  taskStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  taskStatusRunning: {
    backgroundColor: colors.primary,
  },
  taskStatusDone: {
    backgroundColor: '#10B981',
  },
  taskStatusPending: {
    backgroundColor: colors.textDim,
  },
  taskMeta: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    marginLeft: 'auto' as any,
  },
  taskAge: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
    paddingLeft: 4,
  },
  taskCheckbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  taskCheckboxDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  taskRunningBadge: {
    fontSize: 8,
    fontWeight: '700' as const,
    color: colors.primary,
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    letterSpacing: 0.5,
  },
  taskNextBadge: {
    fontSize: 8,
    fontWeight: '700' as const,
    color: '#F59E0B',
    backgroundColor: 'rgba(245,158,11,0.1)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    letterSpacing: 0.5,
  },
  taskRowLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600' as const,
    flex: 1,
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

const wizardStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  bubble: {
    backgroundColor: '#1B2336',
    borderRadius: 16,
    borderTopLeftRadius: 4,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.04)',
  },
  labelRow: {
    marginBottom: 8,
  },
  labelBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.primary,
    backgroundColor: 'rgba(59,130,246,0.08)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  progress: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 10,
  },
  pDot: {
    height: 3,
    flex: 1,
    borderRadius: 2,
    backgroundColor: 'rgba(148,163,184,0.08)',
  },
  pDotActive: {
    backgroundColor: colors.primary,
  },
  pDotDone: {
    backgroundColor: '#22C55E',
  },
  question: {
    fontSize: 14,
    color: '#CBD5E1',
    fontWeight: '500',
    marginBottom: 10,
    lineHeight: 20,
  },
  options: {
    gap: 6,
  },
  optBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.06)',
    borderRadius: 10,
  },
  optIcon: {
    fontSize: 16,
    width: 24,
    textAlign: 'center',
  },
  optText: {
    flex: 1,
  },
  optLabel: {
    fontSize: 13,
    color: '#F8FAFC',
    fontWeight: '500',
  },
  optHint: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1,
  },
  cancel: {
    fontSize: 10,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: 10,
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
    maxHeight: Dimensions.get('window').height * 0.5, // Never taller than half the screen
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
