import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  FlatList, StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { colors, fonts } from '../theme';
import { useNotesStore, NoteItem } from '../store/notesStore';
import { useResponsive } from '../hooks/useResponsive';

// ── Note Row ─────────────────────────────────────────────────────────────────
interface RowProps {
  item: NoteItem;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, text: string) => void;
}

function NoteRow({ item, onToggle, onDelete, onEdit }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(item.text);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.text) {
      onEdit(item.id, trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <View style={rs.editRow}>
        <TextInput
          style={rs.editInput}
          value={draft}
          onChangeText={setDraft}
          autoFocus
          multiline
          onSubmitEditing={handleSave}
          blurOnSubmit
          onBlur={handleSave}
          placeholderTextColor={colors.textDim}
        />
        <View style={rs.editActions}>
          <TouchableOpacity style={rs.editSave} onPress={handleSave} activeOpacity={0.7}>
            <Feather name="check" size={14} color={colors.bg} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setDraft(item.text); setEditing(false); }} activeOpacity={0.7}>
            <Text style={rs.editCancel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[rs.row, item.done && rs.rowDone]}>
      {/* Checkbox */}
      <TouchableOpacity
        style={[rs.checkbox, item.done && rs.checkboxDone]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onToggle(item.id);
        }}
        activeOpacity={0.7}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={item.text}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        {item.done && <Feather name="check" size={12} color={colors.bg} />}
      </TouchableOpacity>

      {/* Text */}
      <Text
        style={[rs.text, item.done && rs.textDone]}
        numberOfLines={3}
        onPress={() => { setDraft(item.text); setEditing(true); }}
      >
        {item.text}
      </Text>

      {/* Copy + Delete */}
      <TouchableOpacity
        style={rs.actionBtn}
        onPress={async () => {
          await Clipboard.setStringAsync(item.text);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
        activeOpacity={0.7}
        accessibilityLabel="Copy note"
        accessibilityRole="button"
        hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      >
        <Feather name="copy" size={12} color={colors.textDim} />
      </TouchableOpacity>
      <TouchableOpacity
        style={rs.actionBtn}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onDelete(item.id);
        }}
        activeOpacity={0.7}
        accessibilityLabel="Delete note"
        accessibilityRole="button"
        hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      >
        <Feather name="x" size={14} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────
interface Props {
  serverId: string;
}

export function NotesPanel({ serverId }: Props) {
  const { rf, rs, ri } = useResponsive();
  const { load, addItem, updateItem, toggleItem, removeItem, clearDone } = useNotesStore();
  const items = useNotesStore((s) => s.getItems(serverId));
  const [draft, setDraft]   = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { load(); }, []);

  const handleAdd = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    addItem(serverId, text);
    setDraft('');
    setAdding(false);
  }, [draft, serverId, addItem]);

  const doneCount = items.filter((i) => i.done).length;
  const totalCount = items.length;
  const progressFillStyle = useMemo(
    () => [ps.progressFill, { width: totalCount > 0 ? `${(doneCount / totalCount) * 100}%` as any : '0%' }],
    [doneCount, totalCount],
  );

  return (
    <View style={ps.container}>
      {/* Header */}
      <View style={[ps.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="check-square" size={ri(14)} color="#A78BFA" />
        <Text style={[ps.title, { fontSize: rf(13) }]}>Notes</Text>
        {totalCount > 0 && (
          <Text style={[ps.counter, { fontSize: rf(11) }]}>{doneCount}/{totalCount}</Text>
        )}
        <View style={{ flex: 1 }} />
        {doneCount > 0 && (
          <TouchableOpacity
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              clearDone(serverId);
            }}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Clear completed"
            accessibilityRole="button"
          >
            <Text style={ps.clearText}>Clear done</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[ps.addBtn, adding && ps.addBtnActive]}
          onPress={() => { setAdding((v) => !v); setDraft(''); }}
          activeOpacity={0.7}
          accessibilityLabel={adding ? 'Cancel' : 'Add note'}
          accessibilityRole="button"
        >
          <Feather name={adding ? 'x' : 'plus'} size={16} color={adding ? colors.destructive : colors.text} />
        </TouchableOpacity>
      </View>

      <View style={ps.divider} />

      {/* Add input */}
      {adding && (
        <View style={ps.inputWrap}>
          <TextInput
            style={ps.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="What needs to be done?"
            placeholderTextColor={colors.textDim}
            multiline
            autoFocus
            onSubmitEditing={handleAdd}
            blurOnSubmit
          />
          <TouchableOpacity style={ps.confirmBtn} onPress={handleAdd} activeOpacity={0.7}>
            <Text style={ps.confirmText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        style={ps.list}
        contentContainerStyle={ps.listContent}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <NoteRow
            item={item}
            onToggle={(id) => toggleItem(serverId, id)}
            onDelete={(id) => removeItem(serverId, id)}
            onEdit={(id, text) => updateItem(serverId, id, text)}
          />
        )}
        ListEmptyComponent={
          <View style={ps.empty}>
            <Feather name="check-square" size={32} color={colors.border} />
            <Text style={ps.emptyText}>No notes yet</Text>
            <Text style={ps.emptyHint}>Tap + to add a task</Text>
          </View>
        }
      />

      {/* Progress bar */}
      {totalCount > 0 && (
        <View style={[ps.footer, { paddingHorizontal: rs(12), paddingVertical: rs(8) }]}>
          <View style={[ps.progressTrack, { height: rs(3) }]}>
            <View style={progressFillStyle} />
          </View>
          <Text style={[ps.footerText, { fontSize: rf(9) }]}>
            {doneCount === totalCount ? 'All done!' : `${totalCount - doneCount} remaining`}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Row styles ───────────────────────────────────────────────────────────────
const rs = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(51,65,85,0.3)',
  },
  rowDone: {
    opacity: 0.55,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxDone: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  text: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 18,
  },
  textDone: {
    textDecorationLine: 'line-through',
    color: colors.textDim,
  },
  actionBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  // ── Edit mode ──
  editRow: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(51,65,85,0.3)',
  },
  editInput: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 18,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 6,
    padding: 8,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  editSave: {
    backgroundColor: colors.accent,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  editCancel: {
    color: colors.textDim,
    fontSize: 12,
  },
});

// ── Panel styles ─────────────────────────────────────────────────────────────
const ps = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 7,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  counter: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  clearText: {
    color: colors.textDim,
    fontSize: 11,
    marginRight: 6,
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
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },
  inputWrap: {
    margin: 8,
    gap: 6,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
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
    backgroundColor: '#A78BFA',
    borderRadius: 7,
    paddingVertical: 7,
    alignItems: 'center',
  },
  confirmText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 13,
  },
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  empty: {
    alignItems: 'center',
    paddingTop: 40,
    gap: 6,
  },
  emptyText: {
    color: colors.textDim,
    fontSize: 13,
  },
  emptyHint: {
    color: colors.textDim,
    fontSize: 11,
  },
  // ── Footer progress ──
  footer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(51,65,85,0.5)',
    gap: 4,
  },
  progressTrack: {
    height: 3,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 3,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  footerText: {
    color: colors.textDim,
    fontSize: 9,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
