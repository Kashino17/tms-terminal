/**
 * Season 2 Manager — native glass chat over the existing manager agent:
 * real messages/streaming/thinking from useManagerStore (fed by the
 * persistent handler in useManagerWire), markdown answers, dictation into
 * the input, poll refresh, bridges to Memory/Artifacts (classic screens).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types/navigation.types';
import type { WebSocketService } from '../../services/websocket.service';
import { useManagerStore, ManagerMessage } from '../../store/managerStore';
import { useTerminalStore } from '../../store/terminalStore';
import { GlassSurface } from '../components/GlassSurface';
import { useDictation } from '../hooks/useDictation';
import { useS2Theme } from '../theme/tokens';
import { IconSend, IconMic, IconManager } from '../icons';

interface ManagerScreenProps {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonTwo'>;
  wsService: WebSocketService;
  serverId: string;
  serverHost: string;
  serverPort: number;
  serverToken: string;
  toast: (msg: string) => void;
}

export function ManagerScreen({ navigation, wsService, serverId, serverHost, serverPort, serverToken, toast }: ManagerScreenProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const messages = useManagerStore((s) => s.messages);
  const streamingText = useManagerStore((s) => s.streamingText);
  const thinking = useManagerStore((s) => s.thinking);
  const loading = useManagerStore((s) => s.loading);
  const agentName = useManagerStore((s) => s.personality.agentName) || 'Manager';
  const [input, setInput] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // TTS — same server contract as classic: tts:generate → tts:result (base64
  // wav) → temp file → expo-av playback. One sound at a time.
  const [ttsLoading, setTtsLoading] = useState<Set<string>>(new Set());
  const soundRef = useRef<Audio.Sound | null>(null);
  useEffect(() => {
    return wsService.addMessageListener(async (data: unknown) => {
      const msg = data as { type: string; payload?: any };
      if (msg.type === 'tts:result' && msg.payload?.messageId && msg.payload?.audio) {
        setTtsLoading((prev) => { const n = new Set(prev); n.delete(msg.payload.messageId); return n; });
        try {
          if (soundRef.current) { await soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; }
          const filePath = `${FileSystem.cacheDirectory}s2_tts_${Date.now()}.wav`;
          await FileSystem.writeAsStringAsync(filePath, msg.payload.audio, { encoding: FileSystem.EncodingType.Base64 });
          const { sound } = await Audio.Sound.createAsync({ uri: filePath }, { shouldPlay: true });
          soundRef.current = sound;
        } catch {
          toast('Wiedergabe fehlgeschlagen');
        }
      } else if (msg.type === 'tts:error' && msg.payload?.messageId) {
        setTtsLoading((prev) => { const n = new Set(prev); n.delete(msg.payload.messageId); return n; });
        toast('Vorlesen fehlgeschlagen');
      }
    });
  }, [wsService, toast]);
  useEffect(() => () => { soundRef.current?.unloadAsync().catch(() => {}); }, []);

  const speak = useCallback((msg: ManagerMessage) => {
    setTtsLoading((prev) => new Set(prev).add(msg.id));
    wsService.send({ type: 'tts:generate', payload: { text: msg.text, messageId: msg.id } });
  }, [wsService]);

  // Dictation borrows the first live terminal session for the Whisper route.
  const dictationSessionId = useTerminalStore((s) => (s.tabs[serverId] ?? []).find((t) => t.sessionId)?.sessionId);
  const { micState, toggle: toggleMic } = useDictation({
    wsService,
    sessionId: dictationSessionId,
    onText: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)),
    onError: (msg) => toast(msg),
  });

  // Follow new content.
  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [messages.length, streamingText, thinking]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    const store = useManagerStore.getState();
    store.addMessage({ role: 'user', text }, 'alle');
    store.setLoading(true);
    wsService.send({ type: 'manager:chat', payload: { text, onboarding: false } });
    setInput('');
  }, [input, wsService]);

  const poll = useCallback(() => {
    useManagerStore.getState().setLoading(true);
    wsService.send({ type: 'manager:poll' });
  }, [wsService]);

  const mdStyle = {
    body: { color: c.text, fontSize: m.font.body, lineHeight: 21 },
    code_inline: { backgroundColor: c.well, color: c.accentInk, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), borderRadius: 4 },
    code_block: { backgroundColor: c.well, color: c.text, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), borderRadius: 8, padding: 8, fontSize: m.font.caption },
    fence: { backgroundColor: c.well, color: c.text, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), borderRadius: 8, padding: 8, fontSize: m.font.caption },
    link: { color: c.accent },
    bullet_list_icon: { color: c.textDim },
    heading1: { color: c.text }, heading2: { color: c.text }, heading3: { color: c.text },
  } as const;

  const renderMessage = (msg: ManagerMessage) => {
    if (msg.role === 'system') {
      return (
        <Text key={msg.id} style={{ color: c.textDim, fontSize: m.font.micro, textAlign: 'center', paddingVertical: 8 }}>
          {msg.text}
        </Text>
      );
    }
    const isUser = msg.role === 'user';
    return (
      <View key={msg.id} style={[styles.bubbleRow, isUser ? { justifyContent: 'flex-end' } : undefined]}>
        <GlassSurface
          strong={!isUser}
          radius={m.radius.md}
          style={[
            styles.bubble,
            isUser && { backgroundColor: `rgba(${c.accentRgb},0.10)` },
            msg.isError && { borderColor: c.err },
          ]}
        >
          <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            {isUser ? (
              <Text style={{ color: c.text, fontSize: m.font.body }}>{msg.text}</Text>
            ) : (
              <Markdown style={mdStyle as any}>{msg.text}</Markdown>
            )}
            {msg.actions && msg.actions.length > 0 && (
              <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 4 }}>
                {msg.actions.map((a) => `⚙ ${a.detail}`).join('\n')}
              </Text>
            )}
            {!isUser && !msg.isError && (
              <Pressable
                onPress={() => speak(msg)}
                hitSlop={8}
                accessibilityLabel="Vorlesen"
                style={{ alignSelf: 'flex-start', marginTop: 6, opacity: ttsLoading.has(msg.id) ? 0.5 : 1 }}
              >
                <Text style={{ color: ttsLoading.has(msg.id) ? c.textDim : c.accent, fontSize: m.font.micro, fontWeight: '700' }}>
                  {ttsLoading.has(msg.id) ? 'Lädt…' : 'Vorlesen'}
                </Text>
              </Pressable>
            )}
          </View>
        </GlassSurface>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.headRow}>
        <Text style={[styles.pageTitle, { color: c.text, fontSize: m.font.title }]}>{agentName}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => navigation.navigate('ManagerMemory', { wsService, serverId })}
            style={({ pressed }) => [styles.headChip, { borderColor: c.glassBorder }, pressed && styles.pressed]}
          >
            <Text style={{ color: c.textDim, fontSize: m.font.caption, fontWeight: '700' }}>Memory</Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('ManagerArtifacts', { serverId, serverHost, serverPort, serverToken })}
            style={({ pressed }) => [styles.headChip, { borderColor: c.glassBorder }, pressed && styles.pressed]}
          >
            <Text style={{ color: c.textDim, fontSize: m.font.caption, fontWeight: '700' }}>Artifacts</Text>
          </Pressable>
          <Pressable
            onPress={poll}
            accessibilityLabel="Aktualisieren"
            style={({ pressed }) => [styles.headChip, { borderColor: c.glassBorder }, pressed && styles.pressed]}
          >
            <Text style={{ color: c.text, fontSize: m.font.caption, fontWeight: '700' }}>↻</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 12 }}
      >
        {messages.length === 0 && !streamingText && (
          <View style={{ alignItems: 'center', paddingVertical: 40, gap: 10 }}>
            <IconManager size={34} color={c.textDim} />
            <Text style={{ color: c.textDim, fontSize: m.font.body, textAlign: 'center' }}>
              Frag den {agentName} nach deinen Sessions,{'\n'}Deployments oder was gerade läuft.
            </Text>
          </View>
        )}
        {messages.map(renderMessage)}

        {streamingText !== '' && (
          <View style={styles.bubbleRow}>
            <GlassSurface strong radius={m.radius.md} style={styles.bubble}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                <Markdown style={mdStyle as any}>{streamingText}</Markdown>
              </View>
            </GlassSurface>
          </View>
        )}

        {(thinking || (loading && !streamingText)) && (
          <View style={[styles.bubbleRow, { alignItems: 'center', gap: 8 }]}>
            <ActivityIndicator color={c.accent} size="small" />
            <Text style={{ color: c.textDim, fontSize: m.font.caption }}>
              {thinking ? `${thinking.phase}${thinking.detail ? ` — ${thinking.detail}` : ''}` : 'Denkt nach…'}
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={[styles.inputZone, { paddingBottom: m.dockHeight + 30 }]}>
        <GlassSurface strong radius={m.radius.pill}>
          <View style={styles.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              onSubmitEditing={send}
              placeholder={`${agentName} fragen…`}
              placeholderTextColor={c.textDim}
              multiline
              style={{ flex: 1, color: c.text, fontSize: m.font.body, maxHeight: 110, paddingVertical: 8 }}
            />
            {dictationSessionId && (
              <Pressable
                onPress={toggleMic}
                hitSlop={6}
                accessibilityLabel={micState === 'recording' ? 'Aufnahme stoppen' : 'Diktieren'}
                style={[
                  styles.roundBtn,
                  micState === 'recording' && { backgroundColor: 'rgba(239,68,68,0.16)' },
                  micState === 'processing' && { backgroundColor: `rgba(${c.accentRgb},0.16)` },
                ]}
              >
                <IconMic size={m.icon.md} color={micState === 'recording' ? c.err : micState === 'processing' ? c.accent : c.textDim} />
              </Pressable>
            )}
            <Pressable
              onPress={send}
              hitSlop={6}
              accessibilityLabel="Senden"
              style={({ pressed }) => [styles.roundBtn, { backgroundColor: `rgba(${c.accentRgb},0.18)` }, pressed && styles.pressed]}
            >
              <IconSend size={m.icon.sm} color={c.accent} />
            </Pressable>
          </View>
        </GlassSurface>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  pageTitle: { fontWeight: '800', letterSpacing: 0.2 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  headChip: { paddingHorizontal: 12, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  bubbleRow: { flexDirection: 'row', marginBottom: 10 },
  bubble: { maxWidth: '86%' },
  inputZone: { paddingHorizontal: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  roundBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
});
