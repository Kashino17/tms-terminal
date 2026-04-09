# Manager Agent v2 — Chat UX Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Manager Agent chat from a basic message list into a polished, feature-rich chat experience with markdown rendering, message actions, audio input, memory viewer, and server list integration.

**Architecture:** All changes are mobile-only except Task 5 (memory viewer needs new WS messages). The chat screen gets message interactions via ActionSheet (long-press) and swipe gestures. Markdown rendering via `react-native-markdown-display`. Audio recording reuses the existing pattern from TerminalToolbar. Memory viewer reads/writes via new WS protocol messages.

**Tech Stack:** React Native, Expo, Zustand, react-native-markdown-display, expo-av, react-native-gesture-handler

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `mobile/src/store/managerStore.ts` | Modify | Add deleteMessage, search filter |
| `mobile/src/screens/ManagerChatScreen.tsx` | Modify | Message actions, markdown, audio, scroll-to-bottom, date separators, search, retry, settings, connection status |
| `mobile/src/components/ServerCard.tsx` | Modify | Add manager button |
| `mobile/src/screens/ServerListScreen.tsx` | Modify | Wire manager navigation from server card |
| `mobile/src/screens/ManagerMemoryScreen.tsx` | Create | Memory viewer/editor screen |
| `mobile/src/navigation/AppNavigator.tsx` | Modify | Add ManagerMemory route |
| `mobile/src/types/navigation.types.ts` | Modify | Add ManagerMemory params |
| `server/src/websocket/ws.handler.ts` | Modify | Add manager:memory_read/write handlers |
| `server/src/manager/manager.memory.ts` | Modify | Export memory read/partial-update functions |
| `shared/protocol.ts` | Modify | Add manager:memory_* message types |

---

### Task 1: Store Updates — deleteMessage + search

**Files:**
- Modify: `mobile/src/store/managerStore.ts`

- [ ] **Step 1: Add deleteMessage and searchMessages to store**

In the `ManagerState` interface, add:
```typescript
  deleteMessage: (id: string) => void;
```

In the store implementation, add:
```typescript
      deleteMessage: (id) => set((s) => ({
        messages: s.messages.filter(m => m.id !== id),
      })),
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add mobile/src/store/managerStore.ts
git commit -m "feat(manager): add deleteMessage to store"
```

---

### Task 2: Long-Press Message Actions (Copy + Delete)

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add imports**

Add to imports:
```typescript
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';
```

Note: `Clipboard` and `Haptics` are already imported elsewhere in the project (TerminalView.tsx uses them). Check if already imported in ManagerChatScreen — if not, add them.

- [ ] **Step 2: Add long-press handler**

Add before `renderMessage`:
```typescript
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
```

Make sure `deleteMessage` is destructured from `useManagerStore()`.

- [ ] **Step 3: Wrap message bubble in Pressable with onLongPress**

In `renderMessage`, replace the outer `<View style={[styles.messageRow, ...]}>`  with:
```typescript
      <Pressable
        style={[styles.messageRow, isUser && styles.messageRowUser]}
        onLongPress={() => handleMessageLongPress(item)}
        delayLongPress={400}
      >
        {/* ... existing bubble content ... */}
      </Pressable>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): long-press message actions (copy, delete)"
```

---

### Task 3: Markdown Rendering for AI Responses

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Install react-native-markdown-display**

```bash
cd mobile && npm install react-native-markdown-display
```

- [ ] **Step 2: Add markdown import and styles**

Add import:
```typescript
import Markdown from 'react-native-markdown-display';
```

Add markdown style object (inside the component or as a constant):
```typescript
const mdStyles = {
  body: { color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
  heading1: { color: colors.text, fontSize: fontSizes.lg, fontWeight: '700' as const, marginBottom: 4 },
  heading2: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700' as const, marginBottom: 4 },
  heading3: { color: colors.text, fontSize: fontSizes.sm, fontWeight: '700' as const, marginBottom: 2 },
  strong: { color: colors.text, fontWeight: '700' as const },
  em: { color: colors.textMuted, fontStyle: 'italic' as const },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 1 },
  code_inline: { backgroundColor: colors.surfaceAlt, color: colors.info, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: fontSizes.xs, paddingHorizontal: 4, borderRadius: 3 },
  fence: { backgroundColor: colors.surfaceAlt, padding: 8, borderRadius: 8, marginVertical: 4 },
  code_block: { color: colors.text, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: fontSizes.xs },
  link: { color: colors.primary },
  table: { borderColor: colors.border },
  tr: { borderBottomColor: colors.border },
  td: { padding: 4 },
  th: { padding: 4, fontWeight: '700' as const },
  blockquote: { borderLeftColor: colors.primary, borderLeftWidth: 3, paddingLeft: 8, marginVertical: 4 },
  hr: { backgroundColor: colors.border },
  paragraph: { marginVertical: 2 },
};
```

- [ ] **Step 3: Replace Text with Markdown for assistant messages**

In `renderMessage`, replace:
```typescript
          <Text style={[styles.messageText, isSystem && styles.messageTextSystem]}>
            {item.text}
          </Text>
```

With:
```typescript
          {isUser || isSystem ? (
            <Text style={[styles.messageText, isSystem && styles.messageTextSystem]}>
              {item.text}
            </Text>
          ) : (
            <Markdown style={mdStyles}>{item.text}</Markdown>
          )}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx mobile/package.json mobile/package-lock.json
git commit -m "feat(manager): markdown rendering for AI responses"
```

---

### Task 4: Audio Transcription in Chat

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add audio imports**

```typescript
import { Audio } from 'expo-av';
import { useSettingsStore } from '../store/settingsStore';
```

`FileSystem` is already imported (for image upload).

- [ ] **Step 2: Add audio recording state**

Add to the component state section:
```typescript
  const [micState, setMicState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

- [ ] **Step 3: Add WS listener for transcription results**

Inside the existing WS message listener `useEffect`, add cases:
```typescript
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
```

- [ ] **Step 4: Add handleMicPress function**

Add after the existing handler functions:
```typescript
  const handleMicPress = useCallback(async () => {
    if (micState === 'recording') {
      // Stop recording
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
        // Use first active session for transcription routing
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
      // Start recording
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
```

- [ ] **Step 5: Add mic button to input bar**

In the input bar, add the mic button between the image button and the text input:
```typescript
        <TouchableOpacity
          style={styles.attachButton}
          onPress={handleMicPress}
          disabled={!enabled}
          hitSlop={8}
        >
          <Feather
            name={micState === 'recording' ? 'square' : 'mic'}
            size={20}
            color={micState === 'recording' ? colors.destructive : enabled ? colors.textMuted : colors.textDim}
          />
        </TouchableOpacity>
        {micState === 'recording' && (
          <Text style={{ color: colors.destructive, fontSize: fontSizes.xs, fontWeight: '600', minWidth: 35 }}>
            {Math.floor(recordingDuration / 60)}:{String(recordingDuration % 60).padStart(2, '0')}
          </Text>
        )}
        {micState === 'processing' && (
          <Text style={{ color: colors.textMuted, fontSize: fontSizes.xs, fontStyle: 'italic' }}>
            Transkribiert...
          </Text>
        )}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): audio transcription in chat input"
```

---

### Task 5: Scroll-to-Bottom, Retry, Date Separators

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add scroll-to-bottom button state and handler**

Add state:
```typescript
  const [showScrollBtn, setShowScrollBtn] = useState(false);
```

Add scroll handler on the FlatList:
```typescript
  const handleScroll = useCallback((e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    setShowScrollBtn(distFromBottom > 200);
  }, []);
```

Add to FlatList props:
```typescript
        onScroll={handleScroll}
        scrollEventThrottle={100}
```

Add the floating button (after FlatList, before typing indicator):
```typescript
      {showScrollBtn && (
        <TouchableOpacity
          style={styles.scrollToBottomBtn}
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
        >
          <Feather name="chevron-down" size={18} color={colors.text} />
        </TouchableOpacity>
      )}
```

Add style:
```typescript
  scrollToBottomBtn: {
    position: 'absolute',
    right: spacing.md,
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
```

- [ ] **Step 2: Add retry last message**

Add handler:
```typescript
  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;
    setLoading(true);
    wsService.send({
      type: 'manager:chat',
      payload: { text: lastUserMsg.text, targetSessionId: lastUserMsg.targetSessionId, onboarding: !onboarded },
    });
  }, [messages, wsService, onboarded, setLoading]);
```

Add retry button — show it after the last message if it's a system error:
```typescript
      {messages.length > 0 && messages[messages.length - 1].role === 'system' && !loading && (
        <TouchableOpacity style={styles.retryBtn} onPress={handleRetry}>
          <Feather name="refresh-cw" size={14} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: fontSizes.xs, marginLeft: 4 }}>Erneut versuchen</Text>
        </TouchableOpacity>
      )}
```

Add style:
```typescript
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginLeft: spacing.md,
    marginBottom: spacing.xs,
  },
```

- [ ] **Step 3: Add date separators**

Create a helper function before the component:
```typescript
function formatDateSeparator(ts: number): string | null {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today.getTime() - msgDay.getTime()) / 86400000;
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}
```

In `renderMessage`, add at the top of the function before the return:
```typescript
    // Date separator — compare with previous message
    const msgIndex = messages.indexOf(item);
    const prevMsg = msgIndex > 0 ? messages[msgIndex - 1] : null;
    const showDateSep = !prevMsg || formatDateSeparator(item.timestamp) !== formatDateSeparator(prevMsg.timestamp);
    const dateSep = showDateSep ? formatDateSeparator(item.timestamp) : null;
```

Wrap the return in a fragment and add the separator:
```typescript
    return (
      <>
        {dateSep && (
          <View style={styles.dateSeparator}>
            <View style={styles.dateSepLine} />
            <Text style={styles.dateSepText}>{dateSep}</Text>
            <View style={styles.dateSepLine} />
          </View>
        )}
        <Pressable ...>
          {/* existing bubble */}
        </Pressable>
      </>
    );
```

Add styles:
```typescript
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.md,
    gap: spacing.sm,
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
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): scroll-to-bottom, retry, date separators"
```

---

### Task 6: Memory Viewer — Protocol + Server Handler

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `server/src/manager/manager.memory.ts`
- Modify: `server/src/websocket/ws.handler.ts`

- [ ] **Step 1: Add memory protocol messages**

In `shared/protocol.ts`, add to client messages (before the `ClientMessage` union):
```typescript
export interface ManagerMemoryReadMessage {
  type: 'manager:memory_read';
}
export interface ManagerMemoryWriteMessage {
  type: 'manager:memory_write';
  payload: { section: string; data: unknown };
}
```

Add both to the `ClientMessage` union.

Add to server messages (before the `ServerMessage` union):
```typescript
export interface ManagerMemoryDataMessage {
  type: 'manager:memory_data';
  payload: { memory: unknown };
}
```

Add to the `ServerMessage` union.

- [ ] **Step 2: Add partial update function to manager.memory.ts**

Add to `manager.memory.ts`:
```typescript
export function updateMemorySection(section: string, data: unknown): void {
  const memory = loadMemory();
  if (section === 'user' && typeof data === 'object' && data) {
    memory.user = { ...memory.user, ...(data as Partial<MemoryUser>) };
  } else if (section === 'personality' && typeof data === 'object' && data) {
    memory.personality = { ...memory.personality, ...(data as Partial<MemoryPersonality>) };
  } else if (section === 'projects' && Array.isArray(data)) {
    memory.projects = data as MemoryProject[];
  } else if (section === 'insights' && Array.isArray(data)) {
    memory.insights = data as MemoryInsight[];
  }
  enforceLimits(memory);
  saveMemory(memory);
}
```

- [ ] **Step 3: Add WS handlers**

In `ws.handler.ts`, add after the existing manager handlers:
```typescript
    if (msgType === 'manager:memory_read') {
      const { loadMemory } = require('../manager/manager.memory');
      const memory = loadMemory();
      send(ws, { type: 'manager:memory_data', payload: { memory } } as any);
      return;
    }

    if (msgType === 'manager:memory_write') {
      const { section, data } = (msg as any).payload ?? {};
      if (typeof section === 'string' && data !== undefined) {
        const { updateMemorySection } = require('../manager/manager.memory');
        updateMemorySection(section, data);
        // Send back updated memory
        const { loadMemory } = require('../manager/manager.memory');
        send(ws, { type: 'manager:memory_data', payload: { memory: loadMemory() } } as any);
      }
      return;
    }
```

- [ ] **Step 4: Verify TypeScript compiles (both server and mobile)**

Run: `cd server && npx tsc --noEmit && cd ../mobile && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add shared/protocol.ts server/src/manager/manager.memory.ts server/src/websocket/ws.handler.ts
git commit -m "feat(manager): memory read/write protocol + server handlers"
```

---

### Task 7: Memory Viewer Screen (Mobile)

**Files:**
- Create: `mobile/src/screens/ManagerMemoryScreen.tsx`
- Modify: `mobile/src/navigation/AppNavigator.tsx`
- Modify: `mobile/src/types/navigation.types.ts`

- [ ] **Step 1: Add route type**

In `navigation.types.ts`, add:
```typescript
  ManagerMemory: { wsService: WebSocketService; serverId: string };
```

- [ ] **Step 2: Create ManagerMemoryScreen**

Create `mobile/src/screens/ManagerMemoryScreen.tsx`:

```typescript
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import type { WebSocketService } from '../services/websocket.service';
import { colors, spacing, fontSizes } from '../theme';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerMemory'>;
  route: RouteProp<RootStackParamList, 'ManagerMemory'>;
};

type Section = 'user' | 'personality' | 'projects' | 'insights' | 'stats';

const SECTION_LABELS: Record<Section, string> = {
  user: 'User-Profil',
  personality: 'Persönlichkeit',
  projects: 'Projekte',
  insights: 'Erkenntnisse',
  stats: 'Statistik',
};

const SECTION_ICONS: Record<Section, string> = {
  user: 'user',
  personality: 'heart',
  projects: 'folder',
  insights: 'zap',
  stats: 'bar-chart-2',
};

export function ManagerMemoryScreen({ navigation, route }: Props) {
  const { wsService } = route.params;
  const insets = useSafeAreaInsets();
  const [memory, setMemory] = useState<any>(null);
  const [activeSection, setActiveSection] = useState<Section>('user');
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    const unsub = wsService.addMessageListener((data: unknown) => {
      const msg = data as { type: string; payload?: any };
      if (msg.type === 'manager:memory_data' && msg.payload?.memory) {
        setMemory(msg.payload.memory);
      }
    });
    wsService.send({ type: 'manager:memory_read' } as any);
    return unsub;
  }, [wsService]);

  const startEdit = useCallback(() => {
    if (!memory) return;
    setEditText(JSON.stringify(memory[activeSection], null, 2));
    setEditing(true);
  }, [memory, activeSection]);

  const saveEdit = useCallback(() => {
    try {
      const parsed = JSON.parse(editText);
      wsService.send({ type: 'manager:memory_write', payload: { section: activeSection, data: parsed } } as any);
      setEditing(false);
    } catch {
      Alert.alert('Fehler', 'Ungültiges JSON');
    }
  }, [editText, activeSection, wsService]);

  const handleReset = useCallback(() => {
    Alert.alert(
      'Memory zurücksetzen',
      'Alle gespeicherten Daten (Persönlichkeit, Erkenntnisse, User-Profil) werden gelöscht. Der Agent startet komplett neu.',
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Zurücksetzen',
          style: 'destructive',
          onPress: () => {
            const sections: Section[] = ['user', 'personality', 'projects', 'insights'];
            for (const s of sections) {
              const empty = s === 'user'
                ? { name: '', role: '', techStack: [], preferences: [], learnedFacts: [] }
                : s === 'personality'
                ? { agentName: 'Manager', tone: 'chill', detail: 'balanced', emojis: true, proactive: true, traits: [], sharedHistory: [] }
                : [];
              wsService.send({ type: 'manager:memory_write', payload: { section: s, data: empty } } as any);
            }
          },
        },
      ],
    );
  }, [wsService]);

  const renderValue = (val: unknown, depth = 0): React.ReactNode => {
    if (val === null || val === undefined) return <Text style={styles.valNull}>—</Text>;
    if (typeof val === 'boolean') return <Text style={[styles.val, { color: val ? colors.accent : colors.destructive }]}>{val ? 'Ja' : 'Nein'}</Text>;
    if (typeof val === 'number') return <Text style={[styles.val, { color: colors.info }]}>{val}</Text>;
    if (typeof val === 'string') return <Text style={styles.val}>{val || '—'}</Text>;
    if (Array.isArray(val)) {
      if (val.length === 0) return <Text style={styles.valNull}>Leer</Text>;
      return (
        <View style={{ gap: 4, marginTop: 2 }}>
          {val.map((item, i) => (
            <View key={i} style={styles.listItem}>
              <Text style={styles.listBullet}>•</Text>
              {typeof item === 'object' ? (
                <View style={{ flex: 1 }}>{renderValue(item, depth + 1)}</View>
              ) : (
                <Text style={[styles.val, { flex: 1 }]}>{String(item)}</Text>
              )}
            </View>
          ))}
        </View>
      );
    }
    if (typeof val === 'object') {
      return (
        <View style={{ gap: 4, marginTop: depth > 0 ? 2 : 0 }}>
          {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
            <View key={k} style={styles.field}>
              <Text style={styles.fieldKey}>{k}</Text>
              {renderValue(v, depth + 1)}
            </View>
          ))}
        </View>
      );
    }
    return <Text style={styles.val}>{String(val)}</Text>;
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8}>
          <Feather name="arrow-left" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Agent Memory</Text>
        <View style={styles.headerRight}>
          {!editing && (
            <TouchableOpacity onPress={startEdit} hitSlop={8}>
              <Feather name="edit-2" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleReset} hitSlop={8}>
            <Feather name="rotate-ccw" size={16} color={colors.destructive} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Section Tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabBarContent}>
        {(Object.keys(SECTION_LABELS) as Section[]).map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.tab, activeSection === s && styles.tabActive]}
            onPress={() => { setActiveSection(s); setEditing(false); }}
          >
            <Feather name={SECTION_ICONS[s] as any} size={14} color={activeSection === s ? colors.primary : colors.textDim} />
            <Text style={[styles.tabText, activeSection === s && styles.tabTextActive]}>{SECTION_LABELS[s]}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Content */}
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {!memory ? (
          <Text style={styles.valNull}>Lade Memory...</Text>
        ) : editing ? (
          <>
            <TextInput
              style={styles.editInput}
              value={editText}
              onChangeText={setEditText}
              multiline
              autoFocus
            />
            <View style={styles.editActions}>
              <TouchableOpacity style={styles.editBtn} onPress={() => setEditing(false)}>
                <Text style={{ color: colors.textMuted }}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.editBtn, styles.editBtnSave]} onPress={saveEdit}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          renderValue(memory[activeSection])
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  headerTitle: { flex: 1, color: colors.text, fontSize: fontSizes.lg, fontWeight: '700', marginLeft: spacing.md },
  headerRight: { flexDirection: 'row', gap: spacing.md },
  tabBar: { maxHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tabBarContent: { paddingHorizontal: spacing.md, gap: spacing.xs },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 8 },
  tabActive: { backgroundColor: colors.primary + '18' },
  tabText: { color: colors.textDim, fontSize: fontSizes.xs, fontWeight: '500' },
  tabTextActive: { color: colors.primary },
  content: { flex: 1 },
  contentInner: { padding: spacing.lg },
  field: { marginBottom: spacing.sm },
  fieldKey: { color: colors.textMuted, fontSize: fontSizes.xs, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  val: { color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
  valNull: { color: colors.textDim, fontSize: fontSizes.sm, fontStyle: 'italic' },
  listItem: { flexDirection: 'row', gap: spacing.sm },
  listBullet: { color: colors.textDim, fontSize: fontSizes.sm },
  editInput: { backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, color: colors.text, fontSize: fontSizes.xs, fontFamily: 'monospace', minHeight: 200, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.border },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  editBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 8 },
  editBtnSave: { backgroundColor: colors.primary + '18' },
});
```

- [ ] **Step 3: Add to navigator**

In `AppNavigator.tsx`, import the screen and add a `Stack.Screen`:
```typescript
import { ManagerMemoryScreen } from '../screens/ManagerMemoryScreen';

// In the navigator:
      <Stack.Screen
        name="ManagerMemory"
        component={ManagerMemoryScreen}
        options={{ headerShown: false, animation: 'slide_from_right', animationDuration: 280 }}
      />
```

- [ ] **Step 4: Add memory button to ManagerChatScreen header**

In ManagerChatScreen header, add a button (in headerRight, before the trash icon):
```typescript
          <TouchableOpacity
            onPress={() => navigation.navigate('ManagerMemory', { wsService, serverId })}
            hitSlop={8}
          >
            <Feather name="database" size={16} color={colors.textMuted} />
          </TouchableOpacity>
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit && cd ../mobile && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add mobile/src/screens/ManagerMemoryScreen.tsx mobile/src/screens/ManagerChatScreen.tsx mobile/src/navigation/AppNavigator.tsx mobile/src/types/navigation.types.ts shared/protocol.ts server/src/manager/manager.memory.ts server/src/websocket/ws.handler.ts
git commit -m "feat(manager): memory viewer/editor screen with section tabs"
```

---

### Task 8: In-Chat Settings (Personality Quick-Edit)

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add settings modal state**

```typescript
  const [showSettings, setShowSettings] = useState(false);
  const [editName, setEditName] = useState(personality.agentName);
```

- [ ] **Step 2: Replace provider picker with settings dropdown**

Replace the `showProviderPicker` section with a combined settings/provider panel. When tapping the subtitle (provider name), show a panel with:

```typescript
      {showSettings && (
        <View style={styles.settingsPanel}>
          {/* Agent Name */}
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

          {/* Provider */}
          <Text style={[styles.settingsLabel, { marginTop: spacing.sm }]}>AI Provider</Text>
          {providers.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.providerOption, p.id === activeProvider && styles.providerOptionActive]}
              onPress={() => { handleProviderSwitch(p.id); }}
              disabled={!p.configured}
            >
              <Text style={[styles.providerText, !p.configured && styles.providerTextDisabled]}>{p.name}</Text>
              {p.id === activeProvider && <Feather name="check" size={14} color={colors.primary} />}
            </TouchableOpacity>
          ))}
        </View>
      )}
```

Update the header subtitle to toggle `showSettings` instead of `showProviderPicker`:
```typescript
          <Pressable onPress={() => setShowSettings((v) => !v)}>
```

Remove the old `showProviderPicker` state and related code.

Add styles:
```typescript
  settingsPanel: {
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsLabel: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  settingsInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    color: colors.text,
    fontSize: fontSizes.sm,
    flex: 1,
    marginLeft: spacing.md,
  },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): in-chat settings panel (name + provider)"
```

---

### Task 9: ServerList Integration — Manager Button on Card

**Files:**
- Modify: `mobile/src/components/ServerCard.tsx`
- Modify: `mobile/src/screens/ServerListScreen.tsx`

- [ ] **Step 1: Add onManagerPress prop to ServerCard**

In `ServerCard.tsx`, add to Props interface:
```typescript
  onManagerPress?: () => void;
```

Destructure it in the component:
```typescript
export function ServerCard({ server, status, onPress, onLongPress, onAvatarPress, onManagerPress }: Props) {
```

Add a small CPU icon button at the bottom-right of the card. After the existing card content (inside the main TouchableOpacity, at the end):
```typescript
        {onManagerPress && (
          <TouchableOpacity
            style={[styles.managerBtn, { width: rs(28), height: rs(28), borderRadius: rs(14) }]}
            onPress={(e) => { e.stopPropagation?.(); onManagerPress(); }}
            hitSlop={6}
            accessibilityLabel="Manager Agent"
          >
            <Feather name="cpu" size={ri(13)} color={colors.textMuted} />
          </TouchableOpacity>
        )}
```

Add style:
```typescript
  managerBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
```

- [ ] **Step 2: Wire navigation in ServerListScreen**

In `ServerListScreen.tsx`, add a handler:
```typescript
  const handleManagerPress = useCallback((server: ServerProfile) => {
    // Need to connect first, then navigate — but we can just pass params
    // The manager screen will use the wsService from the terminal connection
    navigation.navigate('Terminal', {
      serverId: server.id,
      serverName: server.name,
      serverHost: server.host,
      serverPort: server.port,
      token: server.token,
    });
    // Navigation to manager will happen from within Terminal screen
  }, [navigation]);
```

In `renderItem`, add:
```typescript
      onManagerPress={() => handleManagerPress(item)}
```

Note: Direct navigation to ManagerChat from ServerList requires an active WS connection. The simplest approach is navigating to Terminal first (which establishes the connection), then the user can tap the CPU icon there. The ServerCard button serves as a visual indicator that the Manager exists.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add mobile/src/components/ServerCard.tsx mobile/src/screens/ServerListScreen.tsx
git commit -m "feat(manager): manager button on server cards"
```

---

### Task 10: Connection Status in Chat Header

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add connection quality indicator**

The ManagerChatScreen receives `wsService` which has `getQuality()` and `state` methods. Add a periodic poll for connection quality:

```typescript
  const [connQuality, setConnQuality] = useState<string>('good');

  useEffect(() => {
    const timer = setInterval(() => {
      setConnQuality(wsService.getQuality?.() ?? 'good');
    }, 3000);
    return () => clearInterval(timer);
  }, [wsService]);
```

In the header, update the toggle dot to also reflect connection state:
```typescript
          <TouchableOpacity onPress={handleToggle} hitSlop={8}>
            <View style={[
              styles.toggleDot,
              enabled && connQuality === 'good' && styles.toggleDotActive,
              enabled && connQuality === 'fair' && { backgroundColor: colors.warning },
              enabled && connQuality === 'poor' && { backgroundColor: colors.destructive },
            ]} />
          </TouchableOpacity>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): connection quality indicator in header"
```

---

### Task 11: Message Search

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Add search state and UI**

```typescript
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredMessages = searchQuery
    ? messages.filter(m => m.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : messages;
```

Add a search icon in the header (in headerRight):
```typescript
          <TouchableOpacity onPress={() => setSearchMode(v => !v)} hitSlop={8}>
            <Feather name="search" size={16} color={searchMode ? colors.primary : colors.textDim} />
          </TouchableOpacity>
```

Add search bar (show below header when searchMode is true):
```typescript
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
```

Replace the FlatList `data` prop:
```typescript
        data={filteredMessages}
```

Add styles:
```typescript
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: fontSizes.sm,
  },
  searchCount: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontWeight: '600',
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(manager): message search with inline filter"
```

---

### Task 12: Final Build + Release

- [ ] **Step 1: Full TypeScript check**

```bash
cd server && npx tsc --noEmit && cd ../mobile && npx tsc --noEmit
```

- [ ] **Step 2: Version bump**

Bump to v1.13.0 (minor — feature release):
```bash
cd mobile
node -e "const fs=require('fs');const f='./app.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));j.expo.version='1.13.0';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"
sed -i '' 's/versionCode [0-9]*/versionCode 11300/' android/app/build.gradle
sed -i '' 's/versionName "[^"]*"/versionName "1.13.0"/' android/app/build.gradle
```

- [ ] **Step 3: Build APK**

```bash
cd mobile/android && ./gradlew clean -q && ./gradlew assembleRelease -q
```

- [ ] **Step 4: Copy APK + commit release + tag + push**

```bash
cp mobile/android/app/build/outputs/apk/release/app-release.apk ~/Desktop/TMS-Terminal-v1.13.0.apk
cp mobile/android/app/build/outputs/apk/release/app-release.apk ~/Desktop/TMS-Terminal.apk
git add mobile/app.json mobile/android/app/build.gradle
git commit -m "release: v1.13.0 — Manager Agent v2"
git tag v1.13.0
GIT_TERMINAL_PROMPT=0 git push origin master --tags
```

- [ ] **Step 5: Create GitHub release**

```bash
gh release create v1.13.0 ~/Desktop/TMS-Terminal-v1.13.0.apk --title "TMS Terminal v1.13.0" --notes "Manager Agent v2 — Markdown, Audio, Memory Viewer, Message Actions, Search" --latest
```
