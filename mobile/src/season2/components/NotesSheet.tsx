/**
 * Season 2 per-terminal Notizen & Todos sheet — glass panel above the dock,
 * scoped to ONE terminal (user requirement: "Notizen, Todos etc. sollten für
 * jeden Chat existieren"). Backdrop tap closes.
 */
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { GlassSurface } from './GlassSurface';
import { useS2Theme } from '../theme/tokens';
import { useNotesStore } from '../store/notesStore';
import { IconDot, IconPlus, IconTrash, IconClose } from '../icons';

interface NotesSheetProps {
  tabId: string;
  title: string;
  color: string;
  onClose: () => void;
}

type Tab = 'notes' | 'todos';

export function NotesSheet({ tabId, title, color, onClose }: NotesSheetProps) {
  const { theme } = useS2Theme();
  const { c, m } = theme;
  const data = useNotesStore((s) => s.byTab[tabId]) ?? { notes: [], todos: [] };
  const [tab, setTab] = useState<Tab>('notes');
  const [draft, setDraft] = useState('');

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    if (tab === 'notes') useNotesStore.getState().addNote(tabId, text);
    else useNotesStore.getState().addTodo(tabId, text);
    setDraft('');
  };

  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={[StyleSheet.absoluteFill, styles.zone, { backgroundColor: c.scrim }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Schließen" />
      <Animated.View entering={SlideInDown.springify().damping(16)} exiting={SlideOutDown.duration(180)} style={{ width: '100%', alignItems: 'center' }}>
      <GlassSurface strong radius={m.radius.lg} style={styles.panel}>
        <View style={styles.head}>
          <IconDot size={10} color={color} />
          <Text numberOfLines={1} style={{ color: c.text, fontSize: m.font.section, fontWeight: '700', flex: 1 }}>
            {title} — Notizen & Todos
          </Text>
          <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
            <IconClose size={m.icon.sm} color={c.textDim} />
          </Pressable>
        </View>

        <View style={styles.tabs}>
          {(['notes', 'todos'] as Tab[]).map((t) => (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              style={[styles.tabBtn, { borderColor: c.glassBorder }, tab === t && { backgroundColor: `rgba(${c.accentRgb},0.16)` }]}
            >
              <Text style={{ color: tab === t ? c.text : c.textDim, fontSize: m.font.caption, fontWeight: '700' }}>
                {t === 'notes' ? `Notizen (${data.notes.length})` : `Todos (${data.todos.filter((x) => !x.done).length} offen)`}
              </Text>
            </Pressable>
          ))}
        </View>

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {tab === 'notes' && data.notes.map((n) => (
            <View key={n.id} style={[styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: c.text, fontSize: m.font.body }}>{n.text}</Text>
                <Text style={{ color: c.textDim, fontSize: m.font.micro, marginTop: 2 }}>{n.time}</Text>
              </View>
              <Pressable onPress={() => useNotesStore.getState().deleteNote(tabId, n.id)} hitSlop={8}>
                <IconTrash size={m.icon.sm} color={c.textDim} />
              </Pressable>
            </View>
          ))}
          {tab === 'todos' && data.todos.map((t) => (
            <View key={t.id} style={[styles.row, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
              <Pressable
                onPress={() => useNotesStore.getState().toggleTodo(tabId, t.id)}
                style={[styles.checkbox, { borderColor: t.done ? c.ok : c.glassBorder, backgroundColor: t.done ? `rgba(${c.accentRgb},0.14)` : 'transparent' }]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: t.done }}
              >
                {t.done && <Text style={{ color: c.ok, fontSize: 13, fontWeight: '800' }}>✓</Text>}
              </Pressable>
              <Text style={{ flex: 1, color: t.done ? c.textDim : c.text, fontSize: m.font.body, textDecorationLine: t.done ? 'line-through' : 'none' }}>
                {t.text}
              </Text>
              <Pressable onPress={() => useNotesStore.getState().deleteTodo(tabId, t.id)} hitSlop={8}>
                <IconTrash size={m.icon.sm} color={c.textDim} />
              </Pressable>
            </View>
          ))}
          {((tab === 'notes' && data.notes.length === 0) || (tab === 'todos' && data.todos.length === 0)) && (
            <Text style={{ color: c.textDim, fontSize: m.font.caption, textAlign: 'center', paddingVertical: 18 }}>
              Noch nichts hier — unten hinzufügen.
            </Text>
          )}
        </ScrollView>

        <View style={[styles.addRow, { borderTopColor: `rgba(${c.overlayRgb},0.08)` }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={add}
            placeholder={tab === 'notes' ? 'Notiz hinzufügen…' : 'Todo hinzufügen…'}
            placeholderTextColor={c.textDim}
            style={[styles.input, { color: c.text, fontSize: m.font.body }]}
          />
          <Pressable
            onPress={add}
            accessibilityLabel="Hinzufügen"
            style={({ pressed }) => [styles.addBtn, { backgroundColor: `rgba(${c.accentRgb},0.18)` }, pressed && { opacity: 0.7 }]}
          >
            <IconPlus size={m.icon.sm} color={c.accent} />
          </Pressable>
        </View>
      </GlassSurface>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  zone: { zIndex: 35, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 110 },
  panel: { width: '92%', maxWidth: 480, maxHeight: '70%', padding: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  tabBtn: { paddingHorizontal: 14, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  list: { maxHeight: 320 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  checkbox: { width: 24, height: 24, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth * 2, alignItems: 'center', justifyContent: 'center' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, paddingVertical: 8 },
  addBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
