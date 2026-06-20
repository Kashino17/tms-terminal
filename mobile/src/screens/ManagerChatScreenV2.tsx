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
  Easing,
  PanResponder,
  Keyboard,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import Markdown from 'react-native-markdown-display';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
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
import { ToolMenu } from '../components/ToolMenu';
import { ToolPanelSheet } from '../components/ToolPanelSheet';
import { SnippetsPanel } from '../components/SnippetsPanel';
import { ScreenshotPanel } from '../components/ScreenshotPanel';
import { SQLPanel } from '../components/SQLPanel';
import { AutoApprovePanel } from '../components/AutoApprovePanel';
import { AutopilotPanel } from '../components/AutopilotPanel';
import { WatchersPanel } from '../components/WatchersPanel';
import { FileBrowserPanel } from '../components/FileBrowserPanel';
import { PortForwardingPanel } from '../components/PortForwardingPanel';
import { RenderPanel } from '../components/RenderPanel';
import { VercelPanel } from '../components/VercelPanel';
import { useOrbLayoutStore } from '../store/orbLayoutStore';
import { type LayoutChangeEvent } from 'react-native';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerChat'>;
  route: RouteProp<RootStackParamList, 'ManagerChat'>;
};

// "MM:SS" — used for the recording time pill on the mic button
// ── Provider Capability Badges ────────────────────────────────────────────
// Mirrors V1 (ManagerChatScreen.tsx) so the model picker shows the same
// Tools/Vision/Reasoning/Code badges per provider.
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
  'gemma-4': GEMMA_CAPS_VISION,
  'gemma-4-26b': GEMMA_CAPS_TEXT,
  'gemma-4-31b': GEMMA_CAPS_VISION,
  'qwen-3-27b': QWEN_CAPS,
  'qwen-3-35b': QWEN_CAPS,
};
function getProviderCaps(id: string): Array<{ icon: string; label: string; color: string }> | undefined {
  if (PROVIDER_CAPS[id]) return PROVIDER_CAPS[id];
  if (id.includes('qwen')) return QWEN_CAPS;
  if (id.includes('gemma')) {
    if (id.includes('31') || id.includes('27b-it') || !id.includes('26')) return GEMMA_CAPS_VISION;
    return GEMMA_CAPS_TEXT;
  }
  return undefined;
}

// ── Phase / ThinkingBubble (mirror of V1) ─────────────────────────────────
// The store fields (`thinking`, `streamingText`, `streamTokenStats`,
// `requestStartTime`) are populated by the persistent manager:* handler
// registered in TerminalScreen — no separate listener needed here, V2 just
// subscribes to the store and renders.
const PHASE_LABELS: Record<string, string> = {
  analyzing_terminals: 'Terminals...',
  building_context: 'Kontext...',
  calling_ai: 'Sende an AI...',
  streaming: 'Schreibt...',
  executing_actions: 'Tools...',
  tool_response: 'Verarbeite...',
};
const PHASE_COLOR_MAP: Record<string, number> = {
  '__sending': 0,
  'analyzing_terminals': 1, 'building_context': 1, 'calling_ai': 1, 'streaming_start': 1,
  'tool_response': 2, 'executing_actions': 2,
  'streaming': 3,
};
const PHASE_COLORS = [colors.textDim, colors.primary, '#C8913A', '#22C55E'];
const PHASE_TEXT_COLORS = [colors.textDim, colors.textMuted, colors.textMuted, '#4ADE80'];

function ThinkingBubble({ phase, streamingText, onCancel, requestStartTime, tokenStats, mdStyles: mdS }: {
  phase: string;
  streamingText: string;
  onCancel: () => void;
  requestStartTime: number | null;
  tokenStats: { completionTokens: number; tps: number } | null;
  mdStyles: Record<string, any>;
}) {
  const bar1 = useRef(new Animated.Value(0.3)).current;
  const bar2 = useRef(new Animated.Value(0.3)).current;
  const bar3 = useRef(new Animated.Value(0.3)).current;
  const [elapsed, setElapsed] = useState(() =>
    requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0,
  );
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const isSending = phase === '__sending';
  const isStreaming = phase === 'streaming' && streamingText.length > 0;
  const label = isSending ? 'Gesendet...' : (PHASE_LABELS[phase] ?? phase);
  const tokenCount = tokenStats?.completionTokens ?? 0;
  const tps = tokenStats?.tps ?? 0;
  const targetColorIdx = PHASE_COLOR_MAP[phase] ?? 1;
  const barColor = PHASE_COLORS[targetColorIdx] ?? colors.primary;
  const textColor = PHASE_TEXT_COLORS[targetColorIdx] ?? colors.textMuted;

  useEffect(() => {
    const start = requestStartTime ?? Date.now();
    if (mountedRef.current) setElapsed((Date.now() - start) / 1000);
    const timer = setInterval(() => {
      if (mountedRef.current) setElapsed((Date.now() - start) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, [requestStartTime]);

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
    <View style={tbStyles.wrap}>
      <View style={tbStyles.strip}>
        <View style={tbStyles.main}>
          <View style={tbStyles.eqWrap}>
            <Animated.View style={[tbStyles.eqBar, { backgroundColor: barColor, transform: [{ scaleY: bar1 }] }]} />
            <Animated.View style={[tbStyles.eqBarTall, { backgroundColor: barColor, transform: [{ scaleY: bar2 }] }]} />
            <Animated.View style={[tbStyles.eqBar, { backgroundColor: barColor, transform: [{ scaleY: bar3 }] }]} />
          </View>
          <Text style={[tbStyles.phase, { color: textColor }]}>{label}</Text>
          <View style={tbStyles.spacer} />
          {!isSending && (
            <View style={tbStyles.stats}>
              {tokenCount > 0 && <Text style={tbStyles.stat}><Text style={tbStyles.statVal}>{tokenCount}</Text> tok</Text>}
              {tps > 0 && <Text style={tbStyles.stat}><Text style={tbStyles.statVal}>{tps}</Text> t/s</Text>}
            </View>
          )}
          <Text style={tbStyles.time}>{elapsed.toFixed(1)}s</Text>
        </View>
        <View style={tbStyles.progressTrack}>
          <View style={[
            tbStyles.progressFill,
            { backgroundColor: barColor },
            isSending && { width: '2%' },
            !isSending && !isStreaming && { width: '50%' },
            isStreaming && { width: '80%' },
          ]} />
        </View>
        {isStreaming && (
          <ScrollView
            style={tbStyles.streamWrap}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <Markdown style={mdS}>{streamingText.length > 2000 ? streamingText.slice(-2000) : streamingText}</Markdown>
          </ScrollView>
        )}
        <TouchableOpacity onPress={onCancel} activeOpacity={0.7}>
          <Text style={tbStyles.cancel}>Abbrechen</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function formatMicDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Wizard Flows (mirror of V1) ────────────────────────────────────────────
// Multi-step interactive flows triggered by /ppt, /cron, /askill. Each step
// presents preset options + an optional "custom" fall-through. The final
// answers are fed into buildPrompt() and sent as a manager:chat message
// — same prompts V1 uses, so the AI's tool-calling behaviour is unchanged.
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

// ── Slash Commands (mirror of V1) ─────────────────────────────────────────
// Mirrors the list in ManagerChatScreen.tsx so V2 has the same quick-actions.
// Wizard-based commands (/ppt, /cron, /askill) currently fall through and are
// sent as plain text — the V1 wizard UI hasn't been ported. The simple ones
// (/sm, /clear, /reset, /memory, /help) execute inline.
const SLASH_COMMANDS = [
  { cmd: '/sm', desc: 'Terminal-Zusammenfassung' },
  { cmd: '/askill', desc: 'Skill erstellen' },
  { cmd: '/cron', desc: 'Cron Job einrichten' },
  { cmd: '/ppt', desc: 'Präsentation erstellen' },
  { cmd: '/reset', desc: 'Agent zurücksetzen' },
  { cmd: '/clear', desc: 'Chat leeren' },
  { cmd: '/memory', desc: 'Memory-Viewer öffnen' },
  { cmd: '/help', desc: 'Befehle anzeigen' },
];

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
  // Override the library's hard-coded light-grey defaults — without these
  // explicit values, blockquote ends up with #F5F5F5 (white) and our white
  // body text becomes invisible. Same fix applies for fence/code_block.
  code_inline: { backgroundColor: '#243044', color: '#06B6D4', fontFamily: 'monospace', fontSize: 11, paddingHorizontal: 4, borderRadius: 3, borderWidth: 0 },
  fence: { backgroundColor: '#243044', color: '#F8FAFC', padding: 8, borderRadius: 8, marginVertical: 4, borderWidth: 0 },
  code_block: { backgroundColor: '#243044', color: '#F8FAFC', fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 8, marginVertical: 4, borderWidth: 0 },
  link: { color: '#3B82F6' },
  blockquote: { backgroundColor: 'rgba(59,130,246,0.08)', borderLeftColor: '#3B82F6', borderLeftWidth: 3, borderColor: 'transparent', paddingLeft: 10, paddingRight: 8, paddingVertical: 6, marginVertical: 4, marginLeft: 0, borderRadius: 4 },
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

// Themed confirm-dialog styles. Slate card on a dimmed backdrop, destructive
// red used only on the confirm CTA so the dialog reads as "warning, not info".
const cdStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1B2336',
    borderRadius: 16,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 12,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(239,68,68,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    marginBottom: 6,
  },
  body: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCancel: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  btnCancelText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  btnConfirm: {
    backgroundColor: '#EF4444',
  },
  btnConfirmText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
});

// Wizard-card styles — direct port from V1's wizardStyles. Uses raw hex
// values for the bubble interior so the look is identical to ManagerChatScreen.
const ws = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 8 },
  bubble: {
    backgroundColor: '#1B2336',
    borderRadius: 16,
    borderTopLeftRadius: 4,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.04)',
  },
  labelRow: { marginBottom: 8 },
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
  progress: { flexDirection: 'row', gap: 4, marginBottom: 10 },
  pDot: {
    height: 3,
    flex: 1,
    borderRadius: 2,
    backgroundColor: 'rgba(148,163,184,0.08)',
  },
  pDotActive: { backgroundColor: colors.primary },
  pDotDone: { backgroundColor: '#22C55E' },
  question: {
    fontSize: 14,
    color: '#CBD5E1',
    fontWeight: '500',
    marginBottom: 10,
    lineHeight: 20,
  },
  options: { gap: 6 },
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
  optIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  optText: { flex: 1 },
  optLabel: { fontSize: 13, color: '#F8FAFC', fontWeight: '500' },
  optHint: { fontSize: 10, color: '#64748B', marginTop: 1 },
  cancel: {
    fontSize: 10,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: 10,
  },
});

// ThinkingBubble strip styles — direct port from V1's stripStyles, kept
// separate from the main `s` sheet because the bubble lives outside the
// component closure (top-level function).
const tbStyles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 4 },
  strip: {
    backgroundColor: '#1B2336',
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.04)',
  },
  main: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, gap: 10 },
  eqWrap: { flexDirection: 'row', alignItems: 'center', gap: 2.5, height: 16 },
  eqBar: { width: 3, height: 12, borderRadius: 1.5 },
  eqBarTall: { width: 3, height: 16, borderRadius: 1.5 },
  phase: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  spacer: { flex: 1 },
  stats: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  stat: { fontSize: 9, fontFamily: fonts.mono, color: colors.textDim },
  statVal: { fontWeight: '600', color: colors.textMuted },
  time: { fontSize: 10, fontFamily: fonts.mono, color: colors.textDim, minWidth: 32, textAlign: 'right' },
  progressTrack: { height: 2, backgroundColor: 'rgba(59,130,246,0.06)' },
  progressFill: { height: '100%' as const, backgroundColor: colors.primary },
  streamWrap: {
    maxHeight: Dimensions.get('window').height * 0.5,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148,163,184,0.04)',
  },
  cancel: { fontSize: 10, color: colors.textDim, paddingHorizontal: 14, paddingVertical: 6 },
});

// Floating task-panel styles. Anchored top-right via absolute, with a tap-
// outside dismiss layer. Visual lineage: V1's inline taskPanel, restyled
// for V2's denser top-of-screen chrome.
const tp = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: {
    position: 'absolute',
    right: 12,
    width: 320,
    maxWidth: '92%',
    backgroundColor: '#1B2336',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 18,
    elevation: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
    flex: 1,
  },
  headerStats: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  headerStat: {
    color: colors.textDim,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  headerStatVal: {
    color: colors.textMuted,
    fontWeight: '600',
  },
  progressTrack: {
    height: 3,
    backgroundColor: 'rgba(148,163,184,0.08)',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: {
    height: '100%' as const,
    backgroundColor: '#10B981',
    borderRadius: 2,
  },
  empty: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 18,
    fontStyle: 'italic',
  },
  taskGroup: {
    marginBottom: 8,
    paddingTop: 4,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  groupLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  metaMono: {
    color: colors.textDim,
    fontSize: 9,
    fontFamily: fonts.mono,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
    paddingLeft: 4,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  stepText: {
    color: colors.textMuted,
    fontSize: 11,
    flex: 1,
    lineHeight: 15,
  },
  runningBadge: {
    fontSize: 8,
    fontWeight: '700',
    color: colors.primary,
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    letterSpacing: 0.5,
  },
  nextBadge: {
    fontSize: 8,
    fontWeight: '700',
    color: '#F59E0B',
    backgroundColor: 'rgba(245,158,11,0.1)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    letterSpacing: 0.5,
  },
});

// Long-press message menu — bottom sheet with copy/delete actions. Themed
// to match V2 (slate card on dimmed backdrop, no native Alert chrome).
const mm = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1B2336',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 8,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: 12,
  },
  heading: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  preview: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 4,
  },
  actionDestructive: {},
  actionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  actionDestructiveText: {
    color: colors.destructive,
  },
  cancel: {
    marginTop: 6,
    marginBottom: 4,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
});

const rs = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1B2336',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 8,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: 12,
  },
  heading: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  preview: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  btnSecondary: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  btnSecondaryText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  btnPrimaryText: {
    color: '#0B1220',
    fontSize: 14,
    fontWeight: '700',
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  resetText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
});

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
  const allMessages = useManagerStore((s) => s.messages);
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
  const deleteMessage = useManagerStore((s) => s.deleteMessage);
  const setPersonality = useManagerStore((s) => s.setPersonality);
  const setOnboarded = useManagerStore((s) => s.setOnboarded);
  // Thinking / streaming subscriptions — populated by the persistent
  // manager:* handler in TerminalScreen, rendered as a strip below the chat
  // history while the AI is processing.
  const thinking = useManagerStore((s) => s.thinking);
  const streamingText = useManagerStore((s) => s.streamingText);
  const streamTokenStats = useManagerStore((s) => s.streamTokenStats);
  const requestStartTime = useManagerStore((s) => s.requestStartTime);
  const setThinking = useManagerStore((s) => s.setThinking);
  const addError = useManagerStore((s) => s.addError);

  // Wizard state — drives the multi-step picker for /ppt /cron /askill.
  const [wizard, setWizard] = useState<{ flow: WizardFlow; step: number; answers: string[] } | null>(null);
  // Floating task panel — opens below the active-task badge in the header.
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  // Long-press message menu — kopieren / löschen for any chat bubble.
  const [messageMenu, setMessageMenu] = useState<{ id: string; text: string; role: string } | null>(null);
  // Rename-sheet state — set by long-press on a pane header in MultiSpotlight.
  // `tabId` identifies the tab being renamed; `value` is the controlled
  // TextInput state. `null` means the sheet is closed.
  const [renameSheet, setRenameSheet] = useState<{ tabId: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const onboarded = useManagerStore((s) => s.onboarded);
  const voicePromptEnhanceEnabled = useSettingsStore((s) => s.voicePromptEnhanceEnabled);

  const tabs = useTerminalStore((s) => s.tabs[serverId] ?? []);
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));

  // AI-thinking state per session — set true when a CLI in that pane is busy
  // (Claude "Contemplating…", "esc to interrupt", etc.). Drives the pane glow.
  // Only flipped sessions live in the map; idle sessions are pruned to keep
  // the object stable and re-render-friendly.
  const [thinkingMap, setThinkingMap] = useState<Record<string, boolean>>({});
  // Renamed from `setThinking` to avoid collision with the manager-chat
  // thinking callback that already lives in this component.
  const setPaneThinking = useCallback((sid: string, thinking: boolean) => {
    // Diagnostic — remove once the glow is verified working in the wild.
    // eslint-disable-next-line no-console
    console.log('[GLOW] setPaneThinking', sid, thinking);
    setThinkingMap((prev) => {
      if (prev[sid] === thinking) return prev;
      if (!thinking) {
        if (!(sid in prev)) return prev;
        const { [sid]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [sid]: true };
    });
  }, []);
  const thinkingFor = useCallback(
    (sid: string) => thinkingMap[sid] === true,
    [thinkingMap],
  );
  // Prune entries for sessions that no longer have a tab record (terminal closed).
  useEffect(() => {
    setThinkingMap((prev) => {
      const live = new Set(tabs.map((t) => t.sessionId).filter(Boolean) as string[]);
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const k of Object.keys(prev)) {
        if (live.has(k)) next[k] = prev[k];
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  const paneGroupsLoaded = usePaneGroupsStore((s) => s.loaded);
  const loadPaneGroups = usePaneGroupsStore((s) => s.load);
  const groups = usePaneGroupsStore((s) => s.groups[serverId] ?? []);
  const activeGroupId = usePaneGroupsStore((s) => s.activeId[serverId] ?? null);
  const saveGroup = usePaneGroupsStore((s) => s.saveGroup);
  const updateGroup = usePaneGroupsStore((s) => s.updateGroup);
  const removeGroup = usePaneGroupsStore((s) => s.removeGroup);
  const setActiveGroup = usePaneGroupsStore((s) => s.setActive);

  useEffect(() => {
    if (!paneGroupsLoaded) loadPaneGroups();
  }, [paneGroupsLoaded, loadPaneGroups]);

  // ── Sync terminal labels to Manager Agent ────────────────────────────────
  // Mirrors V1's ManagerChatScreen useEffect. Without this, the server-side
  // AI has no knowledge of which terminals exist (no sessionId list, no
  // names) and falls back to "answer with text" mode — its tool calls like
  // write_to_terminal can't target a valid session, so it skips them.
  // Fires whenever tabs change (open/close/rename/CWD update).
  useEffect(() => {
    if (tabs.length === 0) return;
    const labels = tabs
      .map((tab, idx) => ({
        sessionId: tab.sessionId ?? '',
        name: `Shell ${idx + 1} · ${tabDisplayName(tab)}`,
      }))
      .filter((l) => l.sessionId);
    if (labels.length > 0) {
      wsService.send({ type: 'manager:sync_labels', payload: { labels } } as any);
    }
  }, [tabs, wsService]);

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
  // Transcription inactivity watchdog — without it the mic stays stuck on
  // 'processing' forever if the result never arrives. Reset on audio:progress.
  const transcriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTxTimer = useCallback(() => {
    if (transcriptionTimerRef.current) { clearTimeout(transcriptionTimerRef.current); transcriptionTimerRef.current = null; }
  }, []);
  const armTxTimer = useCallback(() => {
    clearTxTimer();
    transcriptionTimerRef.current = setTimeout(() => {
      transcriptionTimerRef.current = null;
      setMicState('idle');
      setRecordingDuration(0);
      setVoiceFullscreen(false);
      voiceTargetSidRef.current = null;
      setMicFlow(null);
      Alert.alert('Transkription Timeout', 'Keine Antwort vom Server – bitte erneut versuchen.');
    }, 150_000);
  }, [clearTxTimer]);

  useEffect(() => {
    const handler = (data: unknown) => {
      const msg = data as { type: string; sessionId?: string; payload?: any };
      if (!msg.type?.startsWith('audio:')) return;
      const targetSid = voiceTargetSidRef.current ?? 'manager';
      if (msg.sessionId && msg.sessionId !== targetSid) return;

      switch (msg.type) {
        case 'audio:transcription':
          clearTxTimer();
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
          armTxTimer();
          if (msg.payload?.chunk && msg.payload?.total) {
            setMicState('processing');
            setRecordingDuration(-msg.payload.chunk);
          }
          break;
        case 'audio:error':
          clearTxTimer();
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
  }, [wsService, clearTxTimer, armTxTimer]);

  // Stop the recording + timer if the screen unmounts mid-record so we don't
  // leak the Audio.Recording handle (the OS will eventually reclaim it but
  // it can leave the mic LED on for a while).
  useEffect(() => {
    return () => {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (transcriptionTimerRef.current) {
        clearTimeout(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, []);

  // ── Local state ────────────────────────────────────────────────────────────
  // Mount-time restore: if an active group exists from a previous session,
  // start with its panes/mode instead of the default. Otherwise default to
  // first 2 tabs of this server (or empty slots). Without this, every
  // remount of ManagerChatV2 would clobber the active group's auto-save
  // (mount → defaults → useEffect persists defaults to the active group).
  const [mode, setMode] = useState<SpotlightMode>(() => {
    const store = usePaneGroupsStore.getState();
    const activeId = store.activeId[serverId];
    if (activeId) {
      const g = (store.groups[serverId] || []).find((x) => x.id === activeId);
      if (g) {
        return (g.terminals.length === 1 ? 1 : g.terminals.length === 2 ? 2 : 4) as SpotlightMode;
      }
    }
    return 2;
  });
  const [panes, setPanes] = useState<(string | null)[]>(() => {
    const store = usePaneGroupsStore.getState();
    const activeId = store.activeId[serverId];
    if (activeId) {
      const g = (store.groups[serverId] || []).find((x) => x.id === activeId);
      if (g) return [...g.terminals];
    }
    const initial = tabs.slice(0, 2).map((t) => t.sessionId ?? null);
    while (initial.length < 2) initial.push(null);
    return initial;
  });
  // Gate for the auto-save effect. True from the start if the store was
  // already hydrated at mount (warm path); flipped by the restore effect
  // below once async hydration finishes (cold path). Without this gate,
  // a cold start would fire auto-save with default panes BEFORE the saved
  // active-group state could be restored — silently corrupting the group.
  const [autoSaveReady, setAutoSaveReady] = useState(
    () => usePaneGroupsStore.getState().loaded,
  );
  const [activePaneIdx, setActivePaneIdx] = useState(0);
  // Chat-as-target selection: tap on the chat to mark it active (subtle top
  // border) — mirrors the pane-active highlight so the user can tell which
  // surface their next action will affect.
  const [chatSelected, setChatSelected] = useState(false);
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
  // V1-style ToolMenu (opens when the focused-pane OrbLayer's Tools orb is tapped)
  const [toolMenuVisible, setToolMenuVisible] = useState(false);
  const [toolMenuAnchor, setToolMenuAnchor] = useState({ x: 200, y: 400 });
  const toolSections = useOrbLayoutStore((s) => s.toolSections);
  const updateToolSections = useOrbLayoutStore((s) => s.updateToolSections);
  // Mirror of toolMenuVisible the keyboard listener can read (its useEffect
  // uses an empty deps array to avoid re-subscribing).
  const toolMenuVisibleRef = useRef(false);
  toolMenuVisibleRef.current = toolMenuVisible;

  // Active tool panel (bottom-sheet). Mirrors TerminalScreen.tsx so all
  // panel tools work the same way in the manager chat.
  const [activePanelTool, setActivePanelTool] = useState<string | null>(null);
  // Pane the panel was opened from, captured at open-time so the panel keeps
  // targeting the right session even if focusedPaneIdx changes mid-flight.
  const panelTargetSidRef = useRef<string | null>(null);

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
      // Don't exit focus mode just because a child modal (ToolMenu, etc.)
      // stole the keyboard — the user expects to land back in the focused
      // pane after closing the modal.
      if (toolMenuVisibleRef.current) return;
      setFocusedPaneIdx((cur) => {
        if (cur != null) spotlightRef.current?.blurPaneKeyboard(cur);
        return null;
      });
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const handleStageLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    // Skip the setState when nothing changed — onLayout fires multiple times
    // during keyboard transitions and re-renders cascade through OrbLayer +
    // every TerminalView, costing us frames during scroll.
    setStageSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, []);

  // Stable handler for MultiSpotlight — avoids creating a new arrow each
  // render which would re-render every TerminalView (WebViews can't truly
  // unmount, but prop-diff cost adds up across 2-4 panes).
  const handleActivePaneChange = useCallback((idx: number) => {
    setActivePaneIdx(idx);
    setChatSelected(false);
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

  // Re-open the focused pane's soft keyboard after a child modal closes.
  // setTimeout + requestAnimationFrame gives the layout a chance to settle so
  // Android actually shows the keyboard instead of swallowing the focus call.
  const refocusFocusedPane = useCallback(() => {
    if (focusedPaneIdx != null) {
      setTimeout(() => spotlightRef.current?.focusPaneKeyboard(focusedPaneIdx), 120);
    }
  }, [focusedPaneIdx]);

  // ── Rename sheet (long-press a pane header to rename the terminal) ────────
  const handlePaneLongPress = useCallback((idx: number) => {
    const sid = panes[idx];
    if (!sid) return;                                  // empty pane → no-op
    const tab = tabs.find((t) => t.sessionId === sid);
    if (!tab) return;                                  // session without tab record
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRenameValue(tab.title);
    setRenameSheet({ tabId: tab.id });
  }, [panes, tabs]);

  const commitRename = useCallback(() => {
    if (!renameSheet) return;
    const trimmed = renameValue.trim();
    if (trimmed.length > 0) {
      useTerminalStore.getState().updateTab(serverId, renameSheet.tabId, {
        title: trimmed,
        customTitle: true,
      });
    }
    setRenameSheet(null);
    setRenameValue('');
    refocusFocusedPane();
  }, [renameSheet, renameValue, serverId, refocusFocusedPane]);

  const resetToAutoName = useCallback(() => {
    if (!renameSheet) return;
    useTerminalStore.getState().updateTab(serverId, renameSheet.tabId, {
      customTitle: false,
    });
    setRenameSheet(null);
    setRenameValue('');
    refocusFocusedPane();
  }, [renameSheet, serverId, refocusFocusedPane]);

  const closeRenameSheet = useCallback(() => {
    setRenameSheet(null);
    setRenameValue('');
    refocusFocusedPane();
  }, [refocusFocusedPane]);

  // ── Header browser shortcut ───────────────────────────────────────────────
  // Tapping the globe icon in the V2 header opens the per-server browser
  // screen, scoped to the active pane's terminal (or the first available
  // tab as fallback). BrowserScreen uses navigation.goBack(), so returning
  // lands the user back here with no extra wiring.
  const handleHeaderBrowserPress = useCallback(() => {
    const activeSid = panes[activePaneIdx];
    const activeTab = activeSid ? tabs.find((t) => t.sessionId === activeSid) : null;
    const tab = activeTab ?? tabs[0];
    if (!tab) {
      Alert.alert('Browser', 'Kein aktiver Terminal-Tab.');
      return;
    }
    if (!tab.browserOpen) {
      useTerminalStore.getState().updateTab(serverId, tab.id, { browserOpen: true });
    }
    navigation.navigate('Browser', {
      serverHost,
      serverId,
      terminalTabId: tab.id,
    } as any);
  }, [panes, activePaneIdx, tabs, serverId, serverHost, navigation]);

  // True when *any* terminal on this server has its browser open. Drives the
  // header globe icon's tint so the user gets a passive "browser is live"
  // signal without having to navigate in to check.
  const anyBrowserOpen = useMemo(() => tabs.some((t) => t.browserOpen), [tabs]);

  // ── Tool menu (focus-mode only) ────────────────────────────────────────────
  const handleOpenTools = useCallback((position: { x: number; y: number }) => {
    setToolMenuAnchor(position);
    setToolMenuVisible(true);
  }, []);

  const handleCloseToolMenu = useCallback(() => {
    setToolMenuVisible(false);
    refocusFocusedPane();
  }, [refocusFocusedPane]);

  // Hoisted above handleSelectTool/renderPanelContent so their useCallback
  // closures can reference it without hitting TDZ on first render.
  const activeSessionId = panes[activePaneIdx];

  // Panel tools that mount a child component inside ToolPanelSheet (mirrors
  // TerminalScreen's panelTools list — keep in sync if you add new panels).
  const PANEL_TOOLS = useMemo(
    () => new Set(['autoApprove', 'snippets', 'files', 'screenshots', 'sql', 'autopilot', 'watchers', 'ports', 'render', 'vercel', 'supabase']),
    [],
  );

  const handleSelectTool = useCallback((toolId: string) => {
    setToolMenuVisible(false);
    // Navigation tools — these intentionally leave focus mode.
    if (toolId === 'manager') { exitPaneFocus(); return; }
    if (toolId === 'drawing') {
      navigation.navigate('Drawing', {
        serverHost,
        serverPort: server?.port ?? serverPort,
        serverToken: server?.token ?? serverToken,
      } as any);
      return;
    }
    if (toolId === 'browser') {
      const focusedSid = focusedPaneIdx != null ? panes[focusedPaneIdx] : null;
      const tab = focusedSid ? tabs.find((t) => t.sessionId === focusedSid) : null;
      if (!tab) { Alert.alert('Browser', 'Kein aktiver Tab.'); refocusFocusedPane(); return; }
      navigation.navigate('Browser', {
        serverHost,
        serverId,
        terminalTabId: tab.id,
      } as any);
      return;
    }
    if (toolId === 'processes') {
      navigation.navigate('Processes', { wsService } as any);
      return;
    }
    // Panel tools open as a bottom sheet over the spotlight stage.
    if (PANEL_TOOLS.has(toolId)) {
      // Capture the focused pane's session at open-time so the panel keeps
      // targeting it even if the user taps elsewhere while the sheet is up.
      panelTargetSidRef.current = focusedPaneIdx != null ? panes[focusedPaneIdx] ?? null : activeSessionId ?? null;
      setActivePanelTool(toolId);
      return;
    }
    // Unknown tool — stay in focus mode and surface the gap.
    Alert.alert(
      'Tool',
      `"${toolId}" ist nicht verfügbar.`,
      [{ text: 'OK', onPress: refocusFocusedPane }],
    );
  }, [PANEL_TOOLS, exitPaneFocus, navigation, serverHost, server, serverPort, serverToken, serverId, focusedPaneIdx, panes, tabs, wsService, refocusFocusedPane, activeSessionId]);

  // Panel content factory — same switch as TerminalScreen.tsx but keyed off
  // the captured pane session (panelTargetSidRef) instead of "active tab".
  const renderPanelContent = useCallback(() => {
    if (!activePanelTool) return null;
    const targetSid = panelTargetSidRef.current ?? activeSessionId ?? undefined;
    switch (activePanelTool) {
      case 'autoApprove':
        return <AutoApprovePanel serverId={serverId} />;
      case 'snippets':
        return <SnippetsPanel sessionId={targetSid} wsService={wsService} />;
      case 'files':
        return (
          <FileBrowserPanel
            serverHost={serverHost}
            serverPort={server?.port ?? serverPort}
            serverToken={server?.token ?? serverToken}
            sessionId={targetSid}
            wsService={wsService}
          />
        );
      case 'screenshots':
        return (
          <ScreenshotPanel
            sessionId={targetSid}
            wsService={wsService}
            serverHost={serverHost}
            serverPort={server?.port ?? serverPort}
            serverToken={server?.token ?? serverToken}
            onUploaded={(path) => {
              // Deliver to the pane captured when the panel opened, falling back
              // to the active session — so the path is never silently dropped.
              const sid = panelTargetSidRef.current ?? activeSessionId;
              if (sid) wsService.send({ type: 'terminal:input', sessionId: sid, payload: { data: path } });
            }}
          />
        );
      case 'sql':
        return <SQLPanel sessionId={targetSid} serverId={serverId} />;
      case 'autopilot':
        return <AutopilotPanel sessionId={targetSid} wsService={wsService} serverId={serverId} />;
      case 'watchers':
        return <WatchersPanel serverId={serverId} wsService={wsService} />;
      case 'ports':
        return <PortForwardingPanel serverId={serverId} />;
      case 'render':
        return <RenderPanel />;
      case 'vercel':
        return <VercelPanel />;
      default:
        return null;
    }
  }, [activePanelTool, serverId, serverHost, serverPort, serverToken, server, wsService, activeSessionId]);

  const handleClosePanel = useCallback(() => {
    setActivePanelTool(null);
    panelTargetSidRef.current = null;
    refocusFocusedPane();
  }, [refocusFocusedPane]);

  // ── Derived ────────────────────────────────────────────────────────────────
  // "Alle" shows the flat global feed; a specific chip shows that pane's
  // bucket. Previously this returned [] for "Alle" — that's why typing in the
  // chat did nothing visible (the messages were stored, the FlatList just
  // wasn't seeing them).
  const messages = useMemo(
    () => (activeChat === 'alle' ? allMessages : sessionMessages[activeChat] ?? []),
    [activeChat, allMessages, sessionMessages],
  );

  // activeSessionId is hoisted above handleSelectTool — see earlier in this file.

  // ── Direct-mode (terminal) input mirroring ───────────────────────────────
  // In terminal input mode, every keystroke mirrors *immediately* to the
  // active pane via terminal:input — including backspaces. Enter then sends
  // a bare \r to execute. Without this, the input was buffered and only
  // flushed once on submit (with \n which most shells ignore as command
  // delimiter), so users couldn't iterate or delete typos.
  const prevTerminalInputRef = useRef('');

  // Reset the diff baseline whenever the user switches modes or active pane.
  useEffect(() => {
    prevTerminalInputRef.current = '';
  }, [inputMode, activeSessionId]);

  const handleInputChange = useCallback((newText: string) => {
    if (inputMode === 'terminal' && activeSessionId) {
      // Common-prefix diff: how many chars to backspace, then what to insert.
      const prev = prevTerminalInputRef.current;
      let cp = 0;
      const minLen = Math.min(prev.length, newText.length);
      while (cp < minLen && prev.charCodeAt(cp) === newText.charCodeAt(cp)) cp++;
      const toDelete = prev.length - cp;
      const toInsert = newText.slice(cp);
      let payload = '';
      for (let i = 0; i < toDelete; i++) payload += '\x7f'; // DEL = backspace in xterm
      payload += toInsert;
      if (payload) {
        wsService.send({
          type: 'terminal:input',
          sessionId: activeSessionId,
          payload: { data: payload },
        } as any);
      }
      prevTerminalInputRef.current = newText;
    }
    setInput(newText);
  }, [inputMode, activeSessionId, wsService]);

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
    setExpandedPaneIdx(null);
    setActiveGroup(serverId, groupId);
  }, [groups, serverId, setActiveGroup]);

  const onDeleteGroup = useCallback((groupId: string) => {
    if (groups.length <= 1) return;
    removeGroup(serverId, groupId);
  }, [groups.length, serverId, removeGroup]);

  const onSaveGroup = useCallback((name: string) => {
    saveGroup(serverId, name, panes.slice(0, mode));
  }, [serverId, panes, mode, saveGroup]);

  // ── Cold-start restore — if AsyncStorage hydration finished AFTER mount,
  // pull the active group's panes into local state ONCE, then arm auto-save.
  useEffect(() => {
    if (autoSaveReady) return;
    if (!paneGroupsLoaded) return;
    const store = usePaneGroupsStore.getState();
    const activeId = store.activeId[serverId];
    if (activeId) {
      const g = (store.groups[serverId] || []).find((x) => x.id === activeId);
      if (g && g.terminals.length > 0) {
        const newMode: SpotlightMode = (
          g.terminals.length === 1 ? 1 : g.terminals.length === 2 ? 2 : 4
        ) as SpotlightMode;
        setMode(newMode);
        setPanes([...g.terminals]);
        setActivePaneIdx(0);
      }
    }
    setAutoSaveReady(true);
  }, [paneGroupsLoaded, autoSaveReady, serverId]);

  // ── Auto-save: active group <- live pane layout ───────────────────────────
  // When a group is active, every pane / mode change persists into that group
  // so switching between groups round-trips the latest state. Without this,
  // groups behaved as one-shot snapshots: changes after save were lost on
  // group switch ("verworfen"). Guarded by autoSaveReady so the lazy-init or
  // restore step has already populated panes from the store.
  useEffect(() => {
    if (!autoSaveReady || !activeGroupId) return;
    updateGroup(serverId, activeGroupId, panes.slice(0, mode));
  }, [autoSaveReady, activeGroupId, serverId, panes, mode, updateGroup]);

  // ── Inline group editor (lives in the merged toolbar) ──────────────────────
  const [groupEditing, setGroupEditing] = useState(false);
  const [groupEditName, setGroupEditName] = useState('');
  const groupInputRef = useRef<TextInput>(null);
  const startGroupEdit = useCallback(() => {
    setGroupEditName('');
    setGroupEditing(true);
    requestAnimationFrame(() => groupInputRef.current?.focus());
  }, []);
  const commitGroupEdit = useCallback(() => {
    const name = groupEditName.trim();
    if (name) onSaveGroup(name);
    setGroupEditing(false);
    setGroupEditName('');
  }, [groupEditName, onSaveGroup]);
  const cancelGroupEdit = useCallback(() => {
    setGroupEditing(false);
    setGroupEditName('');
  }, []);

  // ── Spotlight callbacks ────────────────────────────────────────────────────
  // Expand-toggle: instead of mutating mode/panes (which would auto-save into
  // the active group and lose the other slots), we keep the layout intact
  // and just overlay the selected pane on top of the grid via the existing
  // `focusedPaneIndex` mechanism in MultiSpotlight. Second tap = collapse.
  const [expandedPaneIdx, setExpandedPaneIdx] = useState<number | null>(null);
  const onPromote = useCallback((slot: number) => {
    const sid = panes[slot];
    if (!sid) return;
    setExpandedPaneIdx((cur) => (cur === slot ? null : slot));
    setActivePaneIdx(slot);
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
    // Mode change exits the expanded view — the user explicitly picked a
    // different layout, the overlay no longer represents their intent.
    setExpandedPaneIdx(null);
  }, [activePaneIdx]);

  const onChipPress = useCallback((sessionId: string) => {
    setPanes((prev) => {
      const next = [...prev];
      next[activePaneIdx] = sessionId;
      return next;
    });
  }, [activePaneIdx]);

  // ── Long-press close: groups (toolbar pills) and terminals (chip bar) ─────
  // Native Alert.alert clashes with the app's dark slate aesthetic, so we use
  // a custom themed confirmation modal driven by state. The pending action is
  // captured in `confirmDialog` and fired on the user's "Bestätigen" tap.
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    icon: 'trash-2' | 'x-circle' | 'alert-triangle';
    onConfirm: () => void;
  } | null>(null);

  const confirmCloseGroup = useCallback((groupId: string, name: string) => {
    if (groups.length <= 1) return; // mirror onDeleteGroup guard
    setConfirmDialog({
      title: 'Gruppe löschen',
      body: `"${name}" wird unwiderruflich entfernt.`,
      confirmLabel: 'Löschen',
      icon: 'trash-2',
      onConfirm: () => onDeleteGroup(groupId),
    });
  }, [groups.length, onDeleteGroup]);

  const confirmCloseTerminal = useCallback((tabId: string, sessionId: string, label: string) => {
    setConfirmDialog({
      title: 'Terminal schließen',
      body: `"${label}" wird beendet — laufende Prozesse werden abgebrochen.`,
      confirmLabel: 'Schließen',
      icon: 'x-circle',
      onConfirm: () => {
        try { wsService.send({ type: 'terminal:close', sessionId } as any); } catch {}
        useTerminalStore.getState().removeTab(serverId, tabId);
      },
    });
  }, [wsService, serverId]);

  // ── "+ neuer Terminal" in chip bar ────────────────────────────────────────
  // Spawns a fresh shell on the server and assigns it to the first empty pane
  // (or the active pane if all are filled). We track the in-flight tab via
  // pendingNewTabRef so the terminal:created handler knows which tab to
  // hydrate with the resulting sessionId — this also avoids races with V1's
  // listener if TerminalScreen is in the back stack.
  const pendingNewTabRef = useRef<{ tabId: string; assignToPane: number } | null>(null);

  useEffect(() => {
    const off = wsService.addMessageListener((data: unknown) => {
      const msg = data as { type: string; sessionId?: string; payload?: any };
      if (msg.type !== 'terminal:created' || !msg.sessionId) return;
      const pending = pendingNewTabRef.current;
      if (!pending) return; // not from our "+", let other handlers claim it
      pendingNewTabRef.current = null;
      useTerminalStore.getState().updateTab(serverId, pending.tabId, { sessionId: msg.sessionId });
      const newSid = msg.sessionId;
      setPanes((prev) => {
        const next = [...prev];
        if (pending.assignToPane < next.length) next[pending.assignToPane] = newSid;
        return next;
      });
      setActivePaneIdx(pending.assignToPane);
    });
    return off;
  }, [wsService, serverId]);

  const handleAddNewTerminal = useCallback(() => {
    if ((wsService as any).state && (wsService as any).state !== 'connected') return;
    const currentTabs = useTerminalStore.getState().getTabs(serverId);
    const tabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    // Pick assignment target: first empty in current mode, else active pane
    let target = -1;
    for (let i = 0; i < mode; i++) {
      if (!panes[i]) { target = i; break; }
    }
    if (target === -1) target = activePaneIdx;
    pendingNewTabRef.current = { tabId, assignToPane: target };
    useTerminalStore.getState().addTab(serverId, {
      id: tabId,
      title: `Shell ${currentTabs.length + 1}`,
      serverId,
      active: false,
    });
    wsService.send({
      type: 'terminal:create',
      payload: { cols: 80, rows: 30 },
    } as any);
  }, [wsService, serverId, mode, panes, activePaneIdx]);

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
      armTxTimer();
    } catch {
      setMicState('idle');
      setVoiceFullscreen(false);
      voiceTargetSidRef.current = null;
      setMicFlow(null);
    }
  }, [wsService, voicePromptEnhanceEnabled, armTxTimer]);

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

  // ── Wizard option select ──────────────────────────────────────────────────
  // User tapped one of the preset options. Append to answers, advance step,
  // and on the final step build the prompt + send to manager:chat.
  const handleWizardSelect = useCallback((value: string) => {
    if (!wizard) return;
    const { flow, step, answers } = wizard;
    const newAnswers = [...answers, value];
    addMessage({
      role: 'user',
      text: value,
      targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
    }, activeChat);
    if (step + 1 < flow.steps.length) {
      setWizard({ flow, step: step + 1, answers: newAnswers });
    } else {
      setWizard(null);
      const prompt = flow.buildPrompt(newAnswers);
      setLoading(true);
      wsService.send({
        type: 'manager:chat',
        payload: {
          text: prompt,
          targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
          onboarding: false,
        },
      } as any);
    }
  }, [wizard, wsService, activeChat, addMessage, setLoading]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendMessage = useCallback(() => {
    if (inputMode === 'terminal') {
      if (!activeSessionId) {
        Alert.alert('Kein aktives Terminal', 'Wähle zuerst ein Pane.');
        return;
      }
      // The command text is already in the terminal (mirrored char-by-char
      // via handleInputChange). Just send a carriage return to execute it,
      // then clear the local input field — keyboard stays open thanks to
      // blurOnSubmit={false} on the TextInput.
      wsService.send({
        type: 'terminal:input',
        sessionId: activeSessionId,
        payload: { data: '\r' },
      } as any);
      setInput('');
      prevTerminalInputRef.current = '';
      return;
    }

    const text = input.trim();
    if (!text && attachments.length === 0) return;

    // ── Slash commands (chat-mode only) ─────────────────────────────────
    // Mirrors V1's handler. Wizard-based commands (/ppt, /cron, /askill)
    // are not ported; they fall through and get sent to the AI as plain
    // text so the model can interpret them.
    if (text.startsWith('/')) {
      const cmd = text.toLowerCase().split(' ')[0];
      if (cmd === '/help') {
        addMessage({ role: 'system', text: 'Verfügbare Befehle:\n/sm — Terminal-Zusammenfassung\n/askill — Neuen Skill erstellen\n/cron — Cron Job einrichten\n/ppt — Präsentation erstellen\n/reset — Agent zurücksetzen\n/clear — Chat leeren\n/memory — Memory-Viewer\n/help — Diese Hilfe' }, activeChat);
        setInput('');
        return;
      }
      if (cmd === '/clear') {
        clearSessionMessages(activeChat);
        setInput('');
        return;
      }
      if (cmd === '/memory') {
        (navigation as any).navigate('ManagerMemory', { wsService, serverId });
        setInput('');
        return;
      }
      if (cmd === '/sm') {
        setLoading(true);
        wsService.send({
          type: 'manager:poll',
          payload: { targetSessionId: activeChat !== 'alle' ? activeChat : undefined },
        } as any);
        setInput('');
        return;
      }
      if (cmd === '/reset') {
        setConfirmDialog({
          title: 'Agent zurücksetzen',
          body: 'Memory und Persönlichkeit werden gelöscht. Der Agent startet neu mit dem Onboarding.',
          confirmLabel: 'Zurücksetzen',
          icon: 'alert-triangle',
          onConfirm: () => {
            wsService.send({ type: 'manager:memory_write', payload: { section: 'user', data: { name: '', role: '', techStack: [], preferences: [], learnedFacts: [] } } } as any);
            wsService.send({ type: 'manager:memory_write', payload: { section: 'personality', data: { agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, traits: [], sharedHistory: [] } } } as any);
            wsService.send({ type: 'manager:memory_write', payload: { section: 'projects', data: [] } } as any);
            wsService.send({ type: 'manager:memory_write', payload: { section: 'insights', data: [] } } as any);
            clearSessionMessages(activeChat);
            setPersonality({ agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, customInstruction: '' });
            setOnboarded(false);
            addMessage({ role: 'system', text: 'Agent wurde zurückgesetzt. Schreib "Hi" um das Onboarding zu starten.' }, activeChat);
          },
        });
        setInput('');
        return;
      }
      // Wizard commands — open the multi-step picker if no extra description,
      // or send a fully-built prompt directly if the user wrote one inline.
      if (cmd === '/askill' || cmd === '/cron' || cmd === '/ppt') {
        const extra = text.slice(cmd.length).trim();
        if (extra) {
          const prompts: Record<string, string> = {
            '/ppt': `[PRÄSENTATION] Erstelle eine Präsentation: "${extra}". Nutze create_presentation mit 5-8 Slides.`,
            '/cron': `[CRON-SETUP] Erstelle einen Cron Job: "${extra}". Nutze create_cron_job.`,
            '/askill': `[SKILL-ERSTELLUNG] Erstelle einen Skill: "${extra}". Nutze self_education Tool.`,
          };
          addMessage({
            role: 'user',
            text: `${cmd} ${extra}`,
            targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
          }, activeChat);
          setLoading(true);
          wsService.send({
            type: 'manager:chat',
            payload: {
              text: prompts[cmd],
              targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
              onboarding: false,
            },
          } as any);
        } else {
          const flow = WIZARD_FLOWS[cmd];
          if (flow) {
            addMessage({
              role: 'user',
              text: cmd,
              targetSessionId: activeChat !== 'alle' ? activeChat : undefined,
            }, activeChat);
            setWizard({ flow, step: 0, answers: [] });
          }
        }
        setInput('');
        Keyboard.dismiss();
        return;
      }
      // Unknown commands fall through and get sent to the AI as plain text.
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
    clearSessionMessages, setPersonality, setOnboarded, navigation, serverId,
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

        <Pressable style={s.titleStack} onPress={() => setShowModelPicker((v) => !v)}>
          <View style={s.titleNameRow}>
            <Text style={s.titleName}>{personality.agentName || 'Manager'}</Text>
            <Feather name="chevron-down" size={10} color={colors.textDim} />
          </View>
          <Text style={s.titleSub} numberOfLines={1}>
            {activeProviderName}{activeProviderIsLocal ? ' · local' : ''}
          </Text>
        </Pressable>

        {activeTaskCount > 0 && (
          <Pressable
            style={({ pressed }) => [s.tasksMini, pressed && { opacity: 0.7 }]}
            onPress={() => setTaskPanelOpen((v) => !v)}
            hitSlop={6}
          >
            <View style={s.tasksDot} />
            <Text style={s.tasksText}>{activeTaskCount}</Text>
          </Pressable>
        )}

        <TouchableOpacity
          style={s.menuBtn}
          onPress={handleHeaderBrowserPress}
          accessibilityLabel="Browser öffnen"
          hitSlop={6}
        >
          <Feather
            name="globe"
            size={16}
            color={anyBrowserOpen ? '#22C55E' : colors.textMuted}
          />
        </TouchableOpacity>

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
                const caps = getProviderCaps(p.id);
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
                    <View style={{ flex: 1 }}>
                      <Text style={[s.mpRowName, !p.configured && { color: colors.textDim }]}>
                        {p.name}
                      </Text>
                      {caps && (
                        <View style={s.mpCapsRow}>
                          {caps.map((cap, i) => (
                            <View key={i} style={s.mpCapBadge}>
                              <Feather name={cap.icon as any} size={9} color={cap.color} />
                              <Text style={[s.mpCapText, { color: cap.color }]}>{cap.label}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
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
      <View style={s.toolbar}>
        {/* Mode segmented (1/2/4) */}
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

        {/* Group pills — scroll horizontally, fills the space between the
            segmented mode picker and the right edge. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.tbGroupRow}
          style={{ flex: 1 }}
        >
          {groups.map((g) => {
            const active = g.id === activeGroupId;
            const filled = g.terminals.filter((t): t is string => !!t);
            return (
              <Pressable
                key={g.id}
                style={({ pressed }) => [
                  s.tbPill,
                  active && s.tbPillActive,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => onLoadGroup(g.id)}
                onLongPress={() => confirmCloseGroup(g.id, g.name)}
                delayLongPress={450}
              >
                <View style={s.tbPillDots}>
                  {filled.slice(0, 4).map((sid, i) => (
                    <View
                      key={`${sid}-${i}`}
                      style={[s.tbPillDot, { backgroundColor: colorForSession(sid) }]}
                    />
                  ))}
                </View>
                <Text style={[s.tbPillText, active && s.tbPillTextActive]} numberOfLines={1}>
                  {g.name}
                </Text>
              </Pressable>
            );
          })}

          {groupEditing ? (
            <View style={[s.tbPill, s.tbPillActive, { paddingRight: 6 }]}>
              <TextInput
                ref={groupInputRef}
                style={s.tbPillInput}
                value={groupEditName}
                onChangeText={setGroupEditName}
                placeholder="Name…"
                placeholderTextColor={colors.textDim}
                onSubmitEditing={commitGroupEdit}
                onBlur={commitGroupEdit}
                returnKeyType="done"
                maxLength={20}
                autoCorrect={false}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={cancelGroupEdit} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Feather name="x" size={11} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={s.tbAdd} onPress={startGroupEdit} activeOpacity={0.7}>
              <Feather name="plus" size={11} color={colors.textDim} />
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Render: Chip Bar (terminals) ──────────────────────────────────────────
  function renderChipBar() {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[s.chipBar, chatFocusKBMode && { paddingTop: insets.top }]}
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
          const label = tabDisplayName(t);
          return (
            <Pressable
              key={sid}
              style={[
                s.chip,
                inPane && { backgroundColor: tcolor + '26', borderColor: tcolor + '4D' },
              ]}
              onPress={() => onChipPress(sid)}
              onLongPress={() => confirmCloseTerminal(t.id, sid, label)}
              delayLongPress={500}
            >
              <View style={[s.chipDot, { backgroundColor: tcolor }]} />
              <Text style={[s.chipText, inPane && { color: tcolor }]}>
                S{i + 1}·{label}
              </Text>
            </Pressable>
          );
        })}
        {/* Spawn a new terminal and auto-assign to first empty / active pane. */}
        <TouchableOpacity
          style={s.chipAdd}
          onPress={handleAddNewTerminal}
          activeOpacity={0.7}
        >
          <Feather name="plus" size={12} color={colors.textDim} />
        </TouchableOpacity>
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
      // Plain View — Pressable around FlatList intercepted the scroll-pan
      // responder on Android, blocking vertical scrolling of chat history.
      // The chat-selected highlight is now driven elsewhere (or unused).
      <View style={[s.chat, chatSelected && s.chatSelected]}>
        <FlatList
          inverted
          data={visibleMessages.slice().reverse()}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                s.msg,
                item.role === 'user' ? s.msgUser : s.msgAssistant,
                pressed && { opacity: 0.85 },
              ]}
              onLongPress={() => setMessageMenu({ id: item.id, text: item.text, role: item.role })}
              delayLongPress={400}>
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
            </Pressable>
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
              borderRadius: 14,
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
            style={[
              s.ibInputText,
              isTerminal && s.ibInputTextTerm,
            ]}
            value={input}
            onChangeText={handleInputChange}
            placeholder={isTerminal ? 'Befehl eingeben…' : 'Nachricht…'}
            placeholderTextColor={colors.textDim}
            onSubmitEditing={sendMessage}
            returnKeyType="send"
            // Multiline so the field can show several typed lines while the
            // keyboard is open. submitBehavior='submit' makes Enter still
            // dispatch onSubmitEditing without inserting a newline (default
            // for multiline would be 'newline'). 'blurAndSubmit' in chat
            // mode also closes the keyboard, matching pre-multiline UX.
            multiline
            // RN 0.73 supports submitBehavior at runtime but the bundled TS
            // types only declare blurOnSubmit — cast keeps the prop usable.
            {...({ submitBehavior: isTerminal ? 'submit' : 'blurAndSubmit' } as any)}
            textAlignVertical="top"
            // Disable autocorrect/capitalization in terminal mode so commands
            // aren't mangled before they reach the shell.
            autoCorrect={!isTerminal}
            autoCapitalize={isTerminal ? 'none' : 'sentences'}
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
  // Chat-keyboard mode: keyboard came up via the chat input (no pane focused).
  // Behavior depends on what the user has selected:
  //   - terminalKBMode  (a pane is the active selection): hide the chat
  //     history/chips so the terminals stay visible at full size on top.
  //   - chatFocusKBMode (chat itself was tapped, chatSelected): hide the
  //     terminals so the chat takes the screen.
  // Either way the input bar stays visible — it owns the keyboard.
  const chatKBMode = keyboardVisible && !inFocus;
  // Layout is driven by `inputMode` (the 💬 / > toggle in the input bar) so
  // that typing in chat mode keeps the chat visible (the user can see their
  // message land in history). Terminal mode hides the chat and reserves
  // dock space below the panes — same as before. `chatSelected` is now only
  // a visual border affordance (no longer drives layout).
  const terminalKBMode = chatKBMode && inputMode === 'terminal';
  const chatFocusKBMode = chatKBMode && inputMode === 'chat' && chatSelected;
  // OrbLayer targets the focused pane in fullscreen mode, the active pane in
  // terminal-keyboard mode (so Ctrl+C, Esc, mic etc. operate on whatever the
  // user just selected before opening the chat keyboard).
  const orbSessionId = focusedPaneIdx != null
    ? panes[focusedPaneIdx] ?? undefined
    : terminalKBMode
      ? panes[activePaneIdx] ?? undefined
      : undefined;
  // Bottom reserve below MultiSpotlight in terminalKBMode so the orb dock
  // (≤2 rows × ~48px = ~108px + 4px margin) sits in its own area instead of
  // overlapping the terminal content. The lag previously attributed to this
  // wrapper turned out to be the dock's pointerEvents capturing scroll
  // touches — once the dock's pointerEvents="box-none" landed, this layout
  // shift is back to being cheap.
  const ORB_DOCK_RESERVE = 120;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {!inFocus && !chatKBMode && (
        <View style={{ paddingTop: insets.top, backgroundColor: colors.surface }}>
          {renderHeader()}
        </View>
      )}

      {!inFocus && !chatKBMode && renderModelPicker()}
      {!inFocus && !chatKBMode && renderHeaderMenu()}
      {!inFocus && !chatKBMode && renderSearchBar()}

      {/* Group tabs are now inlined in renderMultiBar to keep top-of-screen
          chrome to a single toolbar row. */}

      {/* Stage body: Multi-Spotlight (full width). Only hidden when the user
          tapped the chat first (chatFocusKBMode) — when a terminal is the
          selection, the terminals stay visible at full size while the chat
          collapses below them. We keep it mounted (display: 'none' rather
          than unmount) so xterm WebView state and the soft keyboard don't
          reset when the user dismisses the kb. */}
      <View
        style={[
          s.stageBody,
          (inFocus || terminalKBMode) && { paddingTop: insets.top },
          chatFocusKBMode && { display: 'none' },
        ]}
        onLayout={handleStageLayout}
      >
        <View style={{ flex: 1, position: 'relative' }}>
          {!inFocus && renderMultiBar()}
          {/* Wrapper reserves vertical space for the orb dock in
              terminalKBMode. The dock floats inside the freed gap (its own
              absolute-positioned layer) instead of covering terminal content. */}
          <View style={[
            { flex: 1, minHeight: 0 },
            terminalKBMode && { paddingBottom: ORB_DOCK_RESERVE },
          ]}>
            <MultiSpotlight
              ref={spotlightRef}
              mode={mode}
              panes={panes}
              activePaneIndex={activePaneIdx}
              onActivePaneChange={handleActivePaneChange}
              onPromote={onPromote}
              onSelectEmptyPane={onSelectEmptyPane}
              wsService={wsService}
              labelFor={labelFor}
              statusFor={statusFor}
              focusedPaneIndex={expandedPaneIdx}
              onPaneDoubleTap={handlePaneDoubleTap}
              onPaneLongPress={handlePaneLongPress}
              thinkingFor={thinkingFor}
              onPaneThinkingChange={setPaneThinking}
            />
          </View>

          {/* OrbLayer mounted directly (no extra wrapper) so we don't stack
              two absoluteFillObject + box-none Views. Mounted in fullscreen
              focus mode AND terminal-keyboard mode. */}
          {(inFocus || terminalKBMode) && orbSessionId && (
            <OrbLayer
              sessionId={orbSessionId}
              wsService={wsService}
              onScrollToBottom={() => {
                const idx = focusedPaneIdx ?? activePaneIdx;
                spotlightRef.current?.scrollToBottom(idx);
              }}
              onOpenTools={handleOpenTools}
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
                } else if (terminalKBMode) {
                  spotlightRef.current?.injectIntoPane(activePaneIdx, text);
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

      {!inFocus && !terminalKBMode && renderChipBar()}
      {!inFocus && !terminalKBMode && renderChat()}
      {/* AI thinking / streaming strip — same component V1 uses, populated
          by the persistent manager:* handler. Shows immediately on send so
          the user sees feedback even before the model starts streaming. */}
      {!inFocus && !terminalKBMode && (loading || (thinking && thinking.phase !== '')) && (
        <ThinkingBubble
          phase={thinking?.phase || '__sending'}
          streamingText={streamingText}
          requestStartTime={requestStartTime}
          tokenStats={streamTokenStats}
          mdStyles={mdStyles}
          onCancel={() => {
            wsService.send({ type: 'manager:cancel' } as any);
            setLoading(false);
            setThinking('', undefined, undefined);
            addError('Anfrage abgebrochen', activeChat);
          }}
        />
      )}
      {!inFocus && !terminalKBMode && renderAttachments()}
      {/* Wizard card — multi-step picker for /ppt /cron /askill. Mirrors V1's
          ManagerChatScreen wizard. Lives between attachments and input bar. */}
      {!inFocus && wizard && (
        <View style={ws.wrap}>
          <View style={ws.bubble}>
            <View style={ws.labelRow}>
              <Text style={ws.labelBadge}>{wizard.flow.icon} {wizard.flow.title}</Text>
            </View>
            <View style={ws.progress}>
              {wizard.flow.steps.map((_, i) => (
                <View
                  key={i}
                  style={[
                    ws.pDot,
                    i < wizard.step && ws.pDotDone,
                    i === wizard.step && ws.pDotActive,
                  ]}
                />
              ))}
            </View>
            <Text style={ws.question}>{wizard.flow.steps[wizard.step].question}</Text>
            <View style={ws.options}>
              {wizard.flow.steps[wizard.step].options.map((opt, i) => (
                <TouchableOpacity
                  key={i}
                  style={ws.optBtn}
                  activeOpacity={0.7}
                  onPress={() => handleWizardSelect(opt.value)}
                >
                  <Text style={ws.optIcon}>{opt.icon}</Text>
                  <View style={ws.optText}>
                    <Text style={ws.optLabel}>{opt.label}</Text>
                    {opt.hint ? <Text style={ws.optHint}>{opt.hint}</Text> : null}
                  </View>
                  <Feather name="chevron-right" size={14} color="#334155" />
                </TouchableOpacity>
              ))}
              {wizard.flow.steps[wizard.step].allowCustom && (
                <TouchableOpacity
                  style={[ws.optBtn, { borderStyle: 'dashed' }]}
                  activeOpacity={0.7}
                  onPress={() => {
                    const cmd = wizard.flow.cmd;
                    setWizard(null);
                    setInput(cmd + ' ');
                  }}
                >
                  <Text style={ws.optIcon}>✏️</Text>
                  <View style={ws.optText}>
                    <Text style={ws.optLabel}>Eigene Eingabe...</Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity onPress={() => setWizard(null)}>
              <Text style={ws.cancel}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {/* Slash command picker — only in chat mode (terminal mode mirrors
          keystrokes char-by-char so a popup would be useless). */}
      {!inFocus && !wizard && inputMode === 'chat' && input.startsWith('/') && (() => {
        const filtered = SLASH_COMMANDS.filter((c) =>
          c.cmd.startsWith(input.toLowerCase().split(' ')[0]),
        );
        if (filtered.length === 0) return null;
        return (
          <View style={s.slashPicker}>
            {filtered.map((c) => (
              <TouchableOpacity
                key={c.cmd}
                style={s.slashPickerItem}
                onPress={() => setInput(c.cmd + ' ')}
                activeOpacity={0.7}
              >
                <Text style={s.slashPickerCmd}>{c.cmd}</Text>
                <Text style={s.slashPickerDesc}>{c.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      })()}
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

      {/* V1 Tool menu — opens from the focus-mode OrbLayer's Tools orb */}
      <ToolMenu
        visible={toolMenuVisible}
        anchorPosition={toolMenuAnchor}
        sections={toolSections}
        onSelectTool={handleSelectTool}
        onClose={handleCloseToolMenu}
        onSectionsChange={updateToolSections}
      />

      {/* Tool Panel Sheet — bottom sheet for panel tools (files, snippets,
          render, vercel, sql, ports, screenshots, autopilot, watchers,
          autoApprove). Mirrors TerminalScreen.tsx so all the tools that
          worked there now work in the manager chat too. */}
      <ToolPanelSheet
        visible={!!activePanelTool}
        toolId={activePanelTool}
        onClose={handleClosePanel}
      >
        {renderPanelContent()}
      </ToolPanelSheet>

      {/* Long-press message menu — themed action sheet anchored to the
          bottom of the screen with safe-area aware insets. Replaces V1's
          native Alert.alert flow so the dropdown matches the app aesthetic. */}
      <Modal
        visible={!!messageMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setMessageMenu(null)}
        statusBarTranslucent
      >
        <Pressable style={mm.backdrop} onPress={() => setMessageMenu(null)}>
          <Pressable
            style={[mm.sheet, { paddingBottom: insets.bottom + 8 }]}
            onPress={() => { /* swallow */ }}
          >
            <View style={mm.handle} />
            <Text style={mm.heading} numberOfLines={1}>
              {messageMenu?.role === 'user' ? 'Deine Nachricht' : messageMenu?.role === 'system' ? 'System-Nachricht' : 'Agent-Nachricht'}
            </Text>
            <Text style={mm.preview} numberOfLines={3}>
              {messageMenu?.text}
            </Text>
            <Pressable
              style={({ pressed }) => [mm.action, pressed && { backgroundColor: 'rgba(255,255,255,0.06)' }]}
              onPress={async () => {
                if (messageMenu) {
                  try { await Clipboard.setStringAsync(messageMenu.text); } catch {}
                }
                setMessageMenu(null);
              }}
            >
              <Feather name="copy" size={16} color={colors.text} />
              <Text style={mm.actionText}>Kopieren</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [mm.action, mm.actionDestructive, pressed && { backgroundColor: 'rgba(239,68,68,0.12)' }]}
              onPress={() => {
                if (messageMenu) deleteMessage(messageMenu.id);
                setMessageMenu(null);
              }}
            >
              <Feather name="trash-2" size={16} color={colors.destructive} />
              <Text style={[mm.actionText, mm.actionDestructiveText]}>Löschen</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [mm.cancel, pressed && { opacity: 0.7 }]}
              onPress={() => setMessageMenu(null)}
            >
              <Text style={mm.cancelText}>Abbrechen</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Rename-sheet — opens on long-press of a pane header. Themed bottom
          sheet with TextInput + Save/Cancel + (conditional) reset-to-auto. */}
      <Modal
        visible={!!renameSheet}
        transparent
        animationType="fade"
        onRequestClose={closeRenameSheet}
        statusBarTranslucent
      >
        <Pressable style={rs.backdrop} onPress={closeRenameSheet}>
          <Pressable
            style={[
              rs.sheet,
              {
                // Float the sheet above the keyboard. statusBarTranslucent
                // disables Android's automatic window-resize, so we add the
                // keyboard height as inner bottom padding — the sheet's own
                // bottom stays at the screen edge but its content (TextInput
                // + buttons) is pushed up out from under the keyboard.
                paddingBottom: insets.bottom + 8 + (keyboardVisible ? keyboardHeight : 0),
              },
            ]}
            onPress={() => { /* swallow */ }}
          >
            <View style={rs.handle} />
            <Text style={rs.heading}>Terminal umbenennen</Text>
            {(() => {
              const tab = renameSheet ? tabs.find((t) => t.id === renameSheet.tabId) : null;
              const currentName = tab ? tab.title : '';
              const hasCustom = tab?.customTitle === true;
              return (
                <>
                  <Text style={rs.preview} numberOfLines={1}>
                    {`Aktuell: ${currentName}`}
                  </Text>
                  <TextInput
                    accessibilityLabel="Terminal-Name"
                    style={rs.input}
                    value={renameValue}
                    onChangeText={setRenameValue}
                    placeholder="Neuer Name"
                    placeholderTextColor={colors.textDim}
                    autoFocus
                    selectTextOnFocus
                    returnKeyType="done"
                    blurOnSubmit
                    onSubmitEditing={commitRename}
                    maxLength={40}
                  />
                  <View style={rs.btnRow}>
                    <Pressable
                      style={({ pressed }) => [rs.btnSecondary, pressed && { opacity: 0.7 }]}
                      onPress={closeRenameSheet}
                    >
                      <Text style={rs.btnSecondaryText}>Abbrechen</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [rs.btnPrimary, pressed && { opacity: 0.85 }]}
                      onPress={commitRename}
                    >
                      <Text style={rs.btnPrimaryText}>Speichern</Text>
                    </Pressable>
                  </View>
                  {hasCustom && (
                    <Pressable
                      style={({ pressed }) => [rs.resetBtn, pressed && { backgroundColor: 'rgba(255,255,255,0.04)' }]}
                      onPress={resetToAutoName}
                    >
                      <Feather name="rotate-ccw" size={14} color={colors.textMuted} />
                      <Text style={rs.resetText}>Auf Auto-Namen zurücksetzen</Text>
                    </Pressable>
                  )}
                </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Floating task panel — opens from the header active-task badge.
          Anchored top-right under the badge; tap-outside dismiss. Mirrors
          V1's inline panel content, but as a popover for V2's denser UI. */}
      <Modal
        visible={taskPanelOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTaskPanelOpen(false)}
        statusBarTranslucent
      >
        <Pressable style={tp.backdrop} onPress={() => setTaskPanelOpen(false)}>
          <Pressable
            style={[tp.panel, { top: insets.top + 56 }]}
            onPress={() => { /* swallow */ }}
          >
            {(() => {
              const totalSteps = delegatedTasks.reduce((sum, t) => sum + (t.steps?.length ?? 1), 0);
              const doneSteps = delegatedTasks.reduce((sum, t) =>
                sum + (t.steps?.filter((s) => s.status === 'done').length ?? (t.status === 'done' ? 1 : 0)), 0);
              const pct = totalSteps > 0 ? (doneSteps / totalSteps) * 100 : 0;
              const activeCount = delegatedTasks.filter((t) => t.status !== 'done').length;
              return (
                <>
                  <View style={tp.headerRow}>
                    <Text style={tp.title}>To-Do</Text>
                    <View style={tp.headerStats}>
                      <Text style={tp.headerStat}>
                        <Text style={tp.headerStatVal}>{activeCount}</Text> aktiv
                      </Text>
                      <Text style={tp.headerStat}>
                        <Text style={tp.headerStatVal}>{Math.round(pct)}%</Text>
                      </Text>
                    </View>
                  </View>
                  <View style={tp.progressTrack}>
                    <View style={[tp.progressFill, { width: (pct + '%') as any }]} />
                  </View>
                </>
              );
            })()}
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingVertical: 4 }}>
              {delegatedTasks.length === 0 && (
                <Text style={tp.empty}>Keine offenen Aufgaben.</Text>
              )}
              {delegatedTasks.map((task) => {
                const steps = task.steps && task.steps.length > 0
                  ? task.steps
                  : [{ label: task.description, status: task.status }];
                const taskDone = task.status === 'done' || steps.every((s) => s.status === 'done');
                const taskRunning = steps.some((s) => s.status === 'running');
                const stepsDone = steps.filter((s) => s.status === 'done').length;
                const age = Math.round((Date.now() - task.createdAt) / 1000);
                const ageStr = age > 3600
                  ? `${Math.round(age / 3600)}h`
                  : age > 60
                    ? `${Math.round(age / 60)}min`
                    : `${age}s`;
                const runningIdx = steps.findIndex((s) => s.status === 'running');
                const nextIdx = runningIdx >= 0
                  ? runningIdx + 1
                  : steps.findIndex((s) => s.status === 'pending');
                return (
                  <View key={task.id} style={[tp.taskGroup, taskDone && { opacity: 0.5 }]}>
                    <View style={tp.groupHeader}>
                      <View style={[
                        tp.statusDot,
                        taskDone
                          ? { backgroundColor: '#10B981' }
                          : taskRunning
                            ? { backgroundColor: colors.primary }
                            : { backgroundColor: colors.textDim },
                      ]} />
                      <Text style={[tp.groupLabel, taskDone && { color: colors.textDim }]} numberOfLines={1}>
                        {task.sessionLabel}
                      </Text>
                      <Text style={tp.metaMono}>{stepsDone}/{steps.length}</Text>
                      <Text style={tp.metaMono}>{ageStr}</Text>
                    </View>
                    {steps.map((step, i) => {
                      const isDone = step.status === 'done';
                      const isFailed = step.status === 'failed';
                      const isRunning = step.status === 'running';
                      const isPending = step.status === 'pending';
                      const isNext = i === nextIdx && !isDone && !isRunning;
                      return (
                        <View key={i} style={[tp.stepRow, isPending && !isNext && { opacity: 0.35 }]}>
                          <View style={[
                            tp.checkbox,
                            {
                              borderColor: isDone
                                ? '#10B981'
                                : isFailed
                                  ? '#EF4444'
                                  : isRunning
                                    ? colors.primary
                                    : isNext
                                      ? '#F59E0B'
                                      : colors.textDim,
                            },
                            (isDone || isFailed) && { backgroundColor: isDone ? '#10B981' : '#EF4444' },
                          ]}>
                            {isDone && <Feather name="check" size={10} color="#fff" />}
                            {isFailed && <Feather name="x" size={10} color="#fff" />}
                            {isRunning && <View style={tp.checkboxDot} />}
                            {isNext && <Feather name="arrow-right" size={8} color="#F59E0B" />}
                          </View>
                          <Text
                            style={[
                              tp.stepText,
                              isDone && { textDecorationLine: 'line-through' as const, color: colors.textDim },
                              isRunning && { color: colors.text, fontWeight: '500' as const },
                              isNext && { color: '#F59E0B' },
                            ]}
                            numberOfLines={2}
                          >
                            {step.label}
                          </Text>
                          {isRunning && <Text style={tp.runningBadge}>LÄUFT</Text>}
                          {isNext && <Text style={tp.nextBadge}>NEXT</Text>}
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Themed confirm dialog — replaces native Alert.alert so the close
          flows for groups + terminals look like the rest of the app. */}
      <Modal
        visible={!!confirmDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmDialog(null)}
        statusBarTranslucent
      >
        <Pressable style={cdStyles.backdrop} onPress={() => setConfirmDialog(null)}>
          <Pressable style={cdStyles.card} onPress={() => { /* swallow */ }}>
            <View style={cdStyles.iconWrap}>
              <Feather
                name={confirmDialog?.icon ?? 'alert-triangle'}
                size={20}
                color={colors.destructive}
              />
            </View>
            <Text style={cdStyles.title}>{confirmDialog?.title ?? ''}</Text>
            <Text style={cdStyles.body}>{confirmDialog?.body ?? ''}</Text>
            <View style={cdStyles.actions}>
              <Pressable
                style={({ pressed }) => [cdStyles.btn, cdStyles.btnCancel, pressed && { opacity: 0.7 }]}
                onPress={() => setConfirmDialog(null)}
              >
                <Text style={cdStyles.btnCancelText}>Abbrechen</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [cdStyles.btn, cdStyles.btnConfirm, pressed && { opacity: 0.85 }]}
                onPress={() => {
                  const fn = confirmDialog?.onConfirm;
                  setConfirmDialog(null);
                  fn?.();
                }}
              >
                <Text style={cdStyles.btnConfirmText}>
                  {confirmDialog?.confirmLabel ?? 'OK'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

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
  // Two-line agent identity: bold name on top, muted model subtitle below.
  titleStack: {
    flex: 1,
    paddingLeft: 4,
    justifyContent: 'center',
  },
  titleNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  titleName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  titleSub: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.15,
    marginTop: 1,
  },

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

  // Single merged toolbar — segmented mode picker + group pills inline.
  // Replaces the old multiBar (1/2/4 + label + save) and the GroupTabsBar
  // (SETS label + group pills) so all top-of-screen chrome lives on one row.
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: 'rgba(0,0,0,0.10)',
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
    padding: 2,
    gap: 1,
  },
  viewMode: {
    width: 24,
    height: 22,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewModeActive: {
    backgroundColor: colors.primary + '36',
  },
  viewModeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textDim,
    fontFamily: fonts.mono,
  },
  viewModeTextActive: { color: '#fff' },
  tbGroupRow: {
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  tbPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    gap: 4,
    maxWidth: 130,
  },
  tbPillActive: {
    backgroundColor: colors.primary + '20',
    borderColor: colors.primary + '4D',
  },
  tbPillBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 1,
  },
  tbPillDots: {
    flexDirection: 'row',
    gap: 2,
  },
  tbPillDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  tbPillText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.mono,
    color: colors.textMuted,
    flexShrink: 1,
  },
  tbPillTextActive: {
    color: colors.primary,
  },
  tbPillClose: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tbPillInput: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
    minWidth: 70,
    padding: 0,
  },
  tbAdd: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },

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
  // Slash command picker — sits between attachments and input bar, mirrors
  // V1's ManagerChatScreen.styles.slashPicker visually so users see the
  // same affordance regardless of which screen they land on.
  slashPicker: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 4,
    maxHeight: 240,
  },
  slashPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  slashPickerCmd: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: fonts.mono,
    minWidth: 64,
  },
  slashPickerDesc: {
    color: colors.textMuted,
    fontSize: 13,
    flex: 1,
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
  // Subtle dashed "+" pill to spawn a new terminal — visually quieter than
  // the regular session chips so it doesn't compete for attention.
  chipAdd: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },

  // Chat
  chat: { flex: 1.05, minHeight: 0, backgroundColor: colors.bg },
  // Subtle 1.5px primary line at the top of the chat — same idea as the
  // pane-active border, but reduced to a single edge to stay minimalist.
  chatSelected: {
    borderTopWidth: 1.5,
    borderTopColor: colors.primary,
  },
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
  // Column layout so the prefix pill (terminal mode) sits ABOVE the text
  // instead of competing for horizontal width — that left a narrow column
  // on the right where typed text wrapped after 6-8 chars. Column lets the
  // text use full container width and wrap naturally.
  // minHeight: 38 keeps the field at button-height when empty; multiline
  // grows it organically with content up to maxHeight.
  ibInput: {
    flex: 1,
    minHeight: 38,
    maxHeight: 140,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 2,
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
    color: colors.text,
    fontSize: 13,
    // Strip the default vertical padding RN's TextInput adds on Android so
    // the field can sit at the same visual height as the round buttons next
    // to it when empty (single-line case).
    paddingTop: 0,
    paddingBottom: 0,
    // Reasonable lineHeight so wrapped lines aren't cramped.
    lineHeight: 18,
  },
  ibInputTextTerm: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 17,
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
  mpRowName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  mpRowMeta: { fontSize: 10, color: colors.textDim, fontStyle: 'italic' },
  mpEmpty: { paddingVertical: 14, paddingHorizontal: 12, color: colors.textDim, fontSize: 12, textAlign: 'center' },
  mpCapsRow: { flexDirection: 'row', gap: 6, marginTop: 3 },
  mpCapBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mpCapText: { fontSize: 9, fontWeight: '500' },

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
