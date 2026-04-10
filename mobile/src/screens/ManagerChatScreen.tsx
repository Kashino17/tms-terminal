import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
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
import { Audio } from 'expo-av';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import type { WebSocketService } from '../services/websocket.service';
import { useManagerStore, ManagerMessage, PhaseInfo } from '../store/managerStore';
import { useTerminalStore } from '../store/terminalStore';
import { tabDisplayName } from '../utils/tabDisplayName';
import { colors, spacing, fontSizes } from '../theme';
import Markdown from 'react-native-markdown-display';

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

// ── Phase Labels ───────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  analyzing_terminals: 'Analysiere Terminals...',
  building_context: 'Bereite Kontext vor...',
  calling_ai: 'Sende an AI...',
  streaming: 'Schreibt...',
  executing_actions: 'Führe Befehle aus...',
};

// ── Thinking Bubble ────────────────────────────────────────────────────────

function ThinkingBubble({ phase, streamingText }: { phase: string; streamingText: string }) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.ease, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 600, easing: Easing.ease, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  const isStreaming = phase === 'streaming' && streamingText.length > 0;
  const label = PHASE_LABELS[phase] ?? phase;

  return (
    <View style={styles.thinkingRow}>
      <View style={styles.thinkingBubble}>
        {!isStreaming && (
          <View style={styles.thinkingHeader}>
            <Animated.View style={[styles.thinkingDot, { opacity: pulse }]} />
            <Text style={styles.thinkingPhase}>{label}</Text>
            <Text style={styles.thinkingTimer}>{elapsed.toFixed(1)}s</Text>
          </View>
        )}
        {isStreaming && (
          <>
            <View style={styles.thinkingHeader}>
              <Animated.View style={[styles.thinkingDot, { opacity: pulse }]} />
              <Text style={styles.thinkingTimer}>{elapsed.toFixed(1)}s</Text>
            </View>
            <Markdown style={mdStyles}>{streamingText}</Markdown>
          </>
        )}
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
    setEnabled, addMessage, addSummary, addResponse, addError,
    setProviders, setLoading, clearMessages, deleteMessage,
    personality, onboarded, setPersonality, setOnboarded,
    thinking, streamingText, lastPhases,
    setThinking, appendStreamChunk, finishStream,
  } = useManagerStore();

  const tabs = useTerminalStore((s) => s.tabs[serverId] ?? []);
  const [input, setInput] = useState('');
  const [targetSession, setTargetSession] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editName, setEditName] = useState(personality.agentName);
  const [attachments, setAttachments] = useState<Array<{ uri: string; path?: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<ManagerMessage>>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [connQuality, setConnQuality] = useState<string>('good');
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [phasePopupVisible, setPhasePopupVisible] = useState(false);

  // ── WS Message Listener ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (data: unknown) => {
      const msg = data as { type: string; payload?: any };
      if (!msg.type?.startsWith('manager:') && !msg.type?.startsWith('audio:')) return;

      switch (msg.type) {
        case 'manager:summary':
          addSummary(msg.payload.text, msg.payload.sessions, msg.payload.timestamp);
          break;
        case 'manager:response':
          addResponse(msg.payload.text, msg.payload.actions);
          break;
        case 'manager:error':
          addError(msg.payload.message);
          break;
        case 'manager:providers':
          setProviders(msg.payload.providers, msg.payload.active);
          break;
        case 'manager:status':
          setEnabled(msg.payload.enabled);
          break;
        case 'manager:personality_configured':
          if (msg.payload) {
            setPersonality(msg.payload);
            setOnboarded(true);
          }
          break;
        case 'manager:thinking':
          setThinking(msg.payload.phase, msg.payload.detail, msg.payload.elapsed);
          break;
        case 'manager:stream_chunk':
          appendStreamChunk(msg.payload.token);
          break;
        case 'manager:stream_end':
          finishStream(msg.payload.text, msg.payload.actions, msg.payload.phases);
          break;
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
  }, [wsService, addSummary, addResponse, addError, setProviders, setEnabled,
      setThinking, appendStreamChunk, finishStream]);

  // ── Connection Quality ────────────────────────────────────────────────────

  useEffect(() => {
    const timer = setInterval(() => {
      setConnQuality((wsService as any).getQuality?.() ?? 'good');
    }, 3000);
    return () => clearInterval(timer);
  }, [wsService]);

  // ── Filtered Messages ─────────────────────────────────────────────────────

  const filteredMessages = searchQuery
    ? messages.filter(m => m.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : messages;

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
                clearMessages();
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
        addMessage({ role: 'system', text: 'Verfügbare Befehle:\n/reset — Agent-Memory komplett löschen und Onboarding neu starten\n/help — Diese Hilfe anzeigen\n/clear — Chat-Verlauf leeren\n/memory — Memory-Viewer öffnen' });
        setInput('');
        return;
      }
      if (cmd === '/clear') {
        clearMessages();
        setInput('');
        return;
      }
      if (cmd === '/memory') {
        navigation.navigate('ManagerMemory', { wsService, serverId });
        setInput('');
        return;
      }
    }

    // Build message text including attachment references
    const attachmentPaths = attachments.filter(a => a.path).map(a => a.path!);
    const fullText = attachmentPaths.length > 0
      ? `${text}\n\n[Angehängte Bilder: ${attachmentPaths.join(', ')}]`
      : text;

    addMessage({ role: 'user', text: text || '(Bild)', targetSessionId: targetSession ?? undefined });
    setLoading(true);
    wsService.send({
      type: 'manager:chat',
      payload: { text: fullText, targetSessionId: targetSession ?? undefined, onboarding: !onboarded },
    });
    setInput('');
    setAttachments([]);
    Keyboard.dismiss();
  }, [input, attachments, targetSession, wsService, addMessage, setLoading, clearMessages, setPersonality, setOnboarded, navigation, serverId]);

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
          body: JSON.stringify({ image: base64, filename }),
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
        setMicState('idle');
      }
    }
  }, [micState, wsService, tabs]);

  // ── Provider Switch ───────────────────────────────────────────────────────

  const handleProviderSwitch = useCallback((id: string) => {
    wsService.send({ type: 'manager:set_provider', payload: { providerId: id } });
    setShowSettings(false);
  }, [wsService]);

  // ── Scroll to Bottom ──────────────────────────────────────────────────────

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const handleScroll = useCallback((e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    setShowScrollBtn(distFromBottom > 200);
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

  // ── Render Message ────────────────────────────────────────────────────────

  const renderMessage = useCallback(({ item, index }: { item: ManagerMessage; index: number }) => {
    const isUser = item.role === 'user';
    const isSystem = item.role === 'system';

    const prevMsg = index > 0 ? filteredMessages[index - 1] : null;
    const showDateSep = !prevMsg || formatDateSeparator(item.timestamp) !== formatDateSeparator(prevMsg.timestamp);
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

            {/* Timestamp */}
            <Text style={styles.timestamp}>
              {new Date(item.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </Pressable>
      </>
    );
  }, [handleMessageLongPress, filteredMessages]);

  // ── Active Provider Label ─────────────────────────────────────────────────

  const activeProviderName = providers.find((p) => p.id === activeProvider)?.name ?? activeProvider;

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

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{personality.agentName}</Text>
          <Pressable onPress={() => setShowSettings((v) => !v)}>
            <Text style={styles.headerSubtitle}>
              {activeProviderName} <Feather name="chevron-down" size={12} color={colors.textMuted} />
            </Text>
          </Pressable>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity onPress={() => setSearchMode(v => !v)} hitSlop={8}>
            <Feather name="search" size={16} color={searchMode ? colors.primary : colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('ManagerMemory', { wsService, serverId })}
            hitSlop={8}
          >
            <Feather name="database" size={16} color={colors.textMuted} />
          </TouchableOpacity>
          {messages.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                clearMessages();
                setLoading(false);
              }}
              hitSlop={8}
            >
              <Feather name="trash-2" size={16} color={colors.textDim} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handlePoll} disabled={!enabled || loading} hitSlop={8}>
            <Feather name="refresh-cw" size={18} color={enabled ? colors.textMuted : colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleToggle} hitSlop={8}>
            <View style={[
              styles.toggleDot,
              enabled && connQuality === 'good' && styles.toggleDotActive,
              enabled && connQuality === 'fair' && { backgroundColor: '#F59E0B' },
              enabled && (connQuality === 'poor' || connQuality === 'bad') && { backgroundColor: '#EF4444' },
            ]} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Panel */}
      {showSettings && (
        <View style={styles.settingsPanel}>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsLabel}>Name</Text>
            <TextInput
              style={styles.settingsInput}
              value={editName}
              onChangeText={setEditName}
              onEndEditing={() => {
                if (editName.trim() && editName !== personality.agentName) {
                  setPersonality({ agentName: editName.trim() });
                  wsService.send({ type: 'manager:set_personality' as any, payload: { agentName: editName.trim() } });
                }
              }}
              maxLength={20}
            />
          </View>
          <Text style={[styles.settingsLabel, { marginTop: 8 }]}>AI Provider</Text>
          {providers.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.providerOption, p.id === activeProvider && styles.providerOptionActive]}
              onPress={() => handleProviderSwitch(p.id)}
              disabled={!p.configured}
            >
              <Text style={[styles.providerText, !p.configured && styles.providerTextDisabled]}>{p.name}</Text>
              {p.id === activeProvider && <Feather name="check" size={14} color={colors.primary} />}
            </TouchableOpacity>
          ))}
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

      {/* Message List */}
      <FlatList
        ref={listRef}
        data={filteredMessages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        style={styles.messageList}
        contentContainerStyle={[
          styles.messageListContent,
          filteredMessages.length === 0 && styles.messageListEmpty,
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        ListEmptyComponent={
          <View style={styles.emptyState}>
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

      {showScrollBtn && (
        <TouchableOpacity
          style={styles.scrollToBottomBtn}
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
        >
          <Feather name="chevron-down" size={18} color={colors.text} />
        </TouchableOpacity>
      )}

      {/* Thinking / Streaming indicator */}
      {thinking && <ThinkingBubble phase={thinking.phase} streamingText={streamingText} />}

      {messages.length > 0 && messages[messages.length - 1].role === 'system' && !loading && (
        <TouchableOpacity style={styles.retryBtn} onPress={handleRetry}>
          <Feather name="refresh-cw" size={14} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 11, marginLeft: 4 }}>Erneut versuchen</Text>
        </TouchableOpacity>
      )}

      {/* Terminal Selector */}
      {tabs.length > 0 && (
        <View style={styles.terminalSelector}>
          <TouchableOpacity
            style={[styles.terminalChip, !targetSession && styles.terminalChipActive]}
            onPress={() => setTargetSession(null)}
          >
            <Text style={[styles.terminalChipText, !targetSession && styles.terminalChipTextActive]}>Alle</Text>
          </TouchableOpacity>
          {tabs.map((tab, idx) => (
            <TouchableOpacity
              key={tab.id}
              style={[styles.terminalChip, targetSession === tab.sessionId && styles.terminalChipActive]}
              onPress={() => setTargetSession(tab.sessionId ?? null)}
            >
              <Text
                style={[
                  styles.terminalChipText,
                  targetSession === tab.sessionId && styles.terminalChipTextActive,
                ]}
                numberOfLines={1}
              >
                {`S${idx + 1} · ${tabDisplayName(tab)}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

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
  settingsPanel: {
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  settingsInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    color: colors.text,
    fontSize: 13,
    flex: 1,
    marginLeft: 12,
  },

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
  providerOption: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
  },
  providerOptionActive: {
    backgroundColor: colors.surfaceAlt,
  },
  providerText: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontWeight: '500',
  },
  providerTextDisabled: {
    color: colors.textDim,
  },
  providerHint: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    marginTop: 2,
  },

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

  // Thinking Bubble
  thinkingRow: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  thinkingBubble: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    alignSelf: 'flex-start',
    maxWidth: '85%',
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  thinkingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  thinkingPhase: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    flex: 1,
  },
  thinkingTimer: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    fontFamily: 'monospace',
  },

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
  messageRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleAssistant: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 4,
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
  timestamp: {
    color: colors.textDim,
    fontSize: 10,
    marginTop: spacing.xs,
    alignSelf: 'flex-end',
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

  // Terminal Selector
  terminalSelector: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
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

});
