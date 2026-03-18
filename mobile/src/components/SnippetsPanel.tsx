import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput,
  TouchableOpacity, FlatList, StyleSheet,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { WebSocketService } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

const STORAGE_KEY = 'tms:snippets';
const DEFAULTS_SET_KEY = 'tms:snippets:defaults_v1';
// Long-press handles edit/delete — no swipe action zone needed

// Default snippets — injected on first launch only
const DEFAULT_SNIPPETS: string[] = [
  'claude',
  'claude --dangerously-skip-permissions',
  'gemini',
  'codex',
  'npm run dev',
  'npm run build',
  'git status',
  'git add -A && git commit -m ""',
  'git pull',
  'git push',
  'ls -la',
  'htop',
  'docker ps',
  'docker compose up -d',
  'pm2 list',
  'tail -f',
  'npx expo start',
  'npx expo run:android',
  'ssh ',
  'cat ~/.ssh/config',
  'curl -s http://localhost:3000',
];

export interface Snippet { id: string; text: string; }

// ── Swipeable card ────────────────────────────────────────────────────────────
interface CardProps {
  item: Snippet;
  onSend(text: string): void;
  onDelete(id: string): void;
  onUpdate(id: string, text: string): void;
}

function SnippetCard({ item, onSend, onDelete, onUpdate }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing]   = useState(false);
  const [draft, setDraft]       = useState(item.text);

  const handlePress = () => {
    if (expanded) { setExpanded(false); return; }
    Haptics.selectionAsync();
    onSend(item.text);
  };

  const handleLongPress = () => {
    Haptics.selectionAsync();
    setExpanded((v) => !v);
  };

  const handleSave = () => {
    if (draft.trim()) onUpdate(item.id, draft.trim());
    setEditing(false);
    setExpanded(false);
  };

  const handleDelete = (id: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onDelete(id);
  };

  return (
    <View style={cs.row}>
      <TouchableOpacity
        style={cs.card}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={380}
        activeOpacity={0.78}
        accessibilityLabel={item.text}
        accessibilityRole="button"
        accessibilityHint="Tap to send, long press for options"
      >
        {editing ? (
          <>
            <TextInput
              style={cs.editInput}
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              placeholderTextColor={colors.textDim}
            />
            <View style={cs.editRow}>
              <TouchableOpacity style={cs.btnSave} onPress={handleSave}>
                <Text style={cs.btnSaveText}><Feather name="check" size={14} color={colors.bg} />  Save</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setEditing(false); setExpanded(false); }}>
                <Text style={cs.btnCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Text style={cs.cardText} numberOfLines={expanded ? undefined : 2}>
              {item.text}
            </Text>
            {/* Long-press actions */}
            {expanded && (
              <View style={cs.inlineActions}>
                <TouchableOpacity style={cs.inlineBtn} onPress={() => { Haptics.selectionAsync(); onSend(item.text); setExpanded(false); }}>
                  <Text style={cs.inlineBtnText}><Feather name="send" size={12} color={colors.text} />  Send</Text>
                </TouchableOpacity>
                <TouchableOpacity style={cs.inlineBtn} onPress={() => { setDraft(item.text); setEditing(true); }}>
                  <Text style={cs.inlineBtnText}><Feather name="edit-2" size={12} color={colors.text} />  Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[cs.inlineBtn, cs.inlineDel]} onPress={() => handleDelete(item.id)}>
                  <Text style={cs.inlineBtnText}><Feather name="trash-2" size={12} color={colors.destructive} />  Delete</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
}

export function SnippetsPanel({ sessionId, wsService }: Props) {
  const { rf, rs, ri } = useResponsive();
  const [items, setItems]   = useState<Snippet[]>([]);
  const [draft, setDraft]   = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        setItems(JSON.parse(raw));
      }
      // Inject defaults once (first install or after clearing data)
      const defaultsSet = await AsyncStorage.getItem(DEFAULTS_SET_KEY);
      if (!defaultsSet) {
        const existing: Snippet[] = raw ? JSON.parse(raw) : [];
        const existingTexts = new Set(existing.map((s) => s.text));
        const toAdd = DEFAULT_SNIPPETS
          .filter((t) => !existingTexts.has(t))
          .map((text, i) => ({ id: `def_${Date.now().toString(36)}_${i}`, text }));
        if (toAdd.length > 0) {
          const merged = [...existing, ...toAdd];
          setItems(merged);
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        }
        await AsyncStorage.setItem(DEFAULTS_SET_KEY, '1');
      }
    })();
  }, []);

  const persist = useCallback(async (next: Snippet[]) => {
    setItems(next);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const addSnippet = () => {
    const text = draft.trim();
    if (!text) return;
    setItems((prev) => {
      const next = [{ id: Date.now().toString(36), text }, ...prev];
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setDraft('');
    setAdding(false);
  };

  const sendSnippet = useCallback((text: string) => {
    if (!sessionId) return;
    wsService.send({ type: 'terminal:input', sessionId, payload: { data: text } });
  }, [sessionId, wsService]);

  const deleteSnippet = useCallback((id: string) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.id !== id);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateSnippet = useCallback((id: string, text: string) => {
    setItems((prev) => {
      const next = prev.map((i) => (i.id === id ? { ...i, text } : i));
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <View style={ps.container}>
      {/* Header */}
      <View style={[ps.header, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}>
        <View style={ps.titleRow}>
          <Feather name="zap" size={ri(14)} color={colors.warning} />
          <Text style={[ps.title, { fontSize: rf(13) }]}>Snippets</Text>
        </View>
        <TouchableOpacity
          style={[ps.addBtn, adding && ps.addBtnActive]}
          onPress={() => { setAdding((v) => !v); setDraft(''); }}
          accessibilityLabel={adding ? 'Cancel' : 'Add snippet'}
          accessibilityRole="button"
        >
          <Feather name={adding ? 'x' : 'plus'} size={16} color={adding ? colors.destructive : colors.text} />
        </TouchableOpacity>
      </View>

      {/* Add input */}
      {adding && (
        <View style={ps.inputWrap}>
          <TextInput
            style={ps.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Enter command or text…"
            placeholderTextColor={colors.textDim}
            multiline
            autoFocus
          />
          <TouchableOpacity style={ps.confirmBtn} onPress={addSnippet}>
            <Text style={ps.confirmText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Snippet list */}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        style={ps.list}
        contentContainerStyle={ps.listContent}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <SnippetCard
            item={item}
            onSend={sendSnippet}
            onDelete={deleteSnippet}
            onUpdate={updateSnippet}
          />
        )}
        ListEmptyComponent={
          <View style={ps.empty}>
            <Feather name="zap" size={32} color={colors.border} />
            <Text style={ps.emptyText}>No snippets yet</Text>
            <Text style={ps.emptyHint}>Tap + to save a command</Text>
          </View>
        }
      />

      {/* Gesture hints */}
      {items.length > 0 && (
        <View style={[ps.hints, { paddingHorizontal: rs(12), paddingVertical: rs(6) }]}>
          <Text style={[ps.hintText, { fontSize: rf(9) }]}>tap to send  ·  hold for options</Text>
        </View>
      )}
    </View>
  );
}

// ── Card styles ───────────────────────────────────────────────────────────────
const cs = StyleSheet.create({
  row: {
    marginHorizontal: 8,
    marginVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
  },
  card: {
    backgroundColor: 'rgba(27, 35, 54, 0.94)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
  },
  cardText: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 18,
  },
  inlineActions: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    flexDirection: 'row',
    gap: 6,
  },
  inlineBtn: {
    flex: 1,
    backgroundColor: colors.border,
    borderRadius: 6,
    paddingVertical: 5,
    alignItems: 'center',
  },
  inlineDel: { backgroundColor: 'rgba(239,68,68,0.12)' },
  inlineBtnText: { color: colors.text, fontSize: 11, fontWeight: '500' },
  editInput: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 18,
    backgroundColor: colors.bg,
    borderRadius: 6,
    padding: 8,
    minHeight: 60,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 10,
  },
  btnSave: {
    backgroundColor: colors.accent,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  btnSaveText: { color: colors.bg, fontSize: 12, fontWeight: '700' },
  btnCancel: { color: colors.textDim, fontSize: 12 },
});

// ── Panel styles ──────────────────────────────────────────────────────────────
const ps = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51,65,85,0.7)',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(51,65,85,0.8)',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnActive: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderColor: colors.destructive,
  },
  inputWrap: {
    margin: 8,
    gap: 6,
  },
  input: {
    backgroundColor: 'rgba(27,35,54,0.9)',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 90,
  },
  confirmBtn: {
    backgroundColor: colors.warning,
    borderRadius: 7,
    paddingVertical: 7,
    alignItems: 'center',
  },
  confirmText: { color: colors.bg, fontWeight: '700', fontSize: 13 },
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  empty: {
    alignItems: 'center',
    paddingTop: 40,
    gap: 6,
  },
  emptyText: { color: colors.textDim, fontSize: 13 },
  emptyHint: { color: colors.textDim, fontSize: 11 },
  hints: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(51,65,85,0.5)',
  },
  hintText: {
    color: colors.textDim,
    fontSize: 9,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
