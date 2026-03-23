import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput,
  TouchableOpacity, FlatList, StyleSheet, Alert,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { usePortForwardingStore, PortForward } from '../store/portForwardingStore';

const ACCENT = '#10B981'; // Emerald-500 — matches ToolRail icon color

// ── Port Card ────────────────────────────────────────────────────────────────
interface CardProps {
  item: PortForward;
  onUpdate: (id: string, updates: Partial<Pick<PortForward, 'port' | 'label' | 'path'>>) => void;
  onDelete: (id: string) => void;
}

function PortCard({ item, onUpdate, onDelete }: CardProps) {
  const [editing, setEditing] = useState(false);
  const [draftPort, setDraftPort] = useState(item.port);
  const [draftLabel, setDraftLabel] = useState(item.label);
  const [draftPath, setDraftPath] = useState(item.path ?? '');

  const handleEdit = () => {
    Haptics.selectionAsync();
    setDraftPort(item.port);
    setDraftLabel(item.label);
    setDraftPath(item.path ?? '');
    setEditing(true);
  };

  const handleSave = () => {
    const port = draftPort.trim();
    const label = draftLabel.trim();
    if (!port || !label) return;
    onUpdate(item.id, {
      port,
      label,
      path: draftPath.trim() || undefined,
    });
    setEditing(false);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleDelete = () => {
    Alert.alert(
      'Port entfernen',
      `Port ${item.port} (${item.label}) wirklich entfernen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Entfernen',
          style: 'destructive',
          onPress: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            onDelete(item.id);
          },
        },
      ],
    );
  };

  if (editing) {
    return (
      <View style={cs.row}>
        <View style={cs.card}>
          <View style={cs.editFields}>
            <View style={cs.editFieldRow}>
              <Text style={cs.editLabel}>Port</Text>
              <TextInput
                style={[cs.editInput, cs.editInputPort]}
                value={draftPort}
                onChangeText={setDraftPort}
                keyboardType="number-pad"
                autoFocus
                placeholderTextColor={colors.textDim}
                placeholder="8080"
                maxLength={5}
              />
            </View>
            <View style={cs.editFieldRow}>
              <Text style={cs.editLabel}>Label</Text>
              <TextInput
                style={cs.editInput}
                value={draftLabel}
                onChangeText={setDraftLabel}
                placeholderTextColor={colors.textDim}
                placeholder="z.B. Dev Server"
              />
            </View>
            <View style={cs.editFieldRow}>
              <Text style={cs.editLabel}>Pfad</Text>
              <TextInput
                style={cs.editInput}
                value={draftPath}
                onChangeText={setDraftPath}
                placeholderTextColor={colors.textDim}
                placeholder="/api (optional)"
              />
            </View>
          </View>
          <View style={cs.editRow}>
            <TouchableOpacity style={cs.btnSave} onPress={handleSave}>
              <Feather name="check" size={14} color={colors.bg} />
              <Text style={cs.btnSaveText}>Speichern</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleCancel}>
              <Text style={cs.btnCancel}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={cs.row}>
      <View style={cs.card}>
        <View style={cs.cardContent}>
          <View style={cs.cardInfo}>
            <Text style={cs.portText}>{item.port}</Text>
            <Text style={cs.labelText} numberOfLines={1}>{item.label}</Text>
            {item.path ? (
              <Text style={cs.pathText} numberOfLines={1}>{item.path}</Text>
            ) : null}
          </View>
          <View style={cs.cardActions}>
            <TouchableOpacity
              style={cs.actionBtn}
              onPress={handleEdit}
              accessibilityLabel="Bearbeiten"
              accessibilityRole="button"
            >
              <Feather name="edit-2" size={14} color={colors.textDim} />
            </TouchableOpacity>
            <TouchableOpacity
              style={cs.actionBtn}
              onPress={handleDelete}
              accessibilityLabel="Entfernen"
              accessibilityRole="button"
            >
              <Feather name="trash-2" size={14} color={colors.destructive} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

// ── New Entry Form ───────────────────────────────────────────────────────────
interface NewEntryProps {
  onSave: (port: string, label: string, path?: string) => void;
  onCancel: () => void;
}

function NewEntryForm({ onSave, onCancel }: NewEntryProps) {
  const [port, setPort] = useState('');
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');

  const handleSave = () => {
    const p = port.trim();
    const l = label.trim();
    if (!p || !l) return;
    onSave(p, l, path.trim() || undefined);
  };

  return (
    <View style={ps.inputWrap}>
      <View style={cs.editFieldRow}>
        <Text style={cs.editLabel}>Port</Text>
        <TextInput
          style={[cs.editInput, cs.editInputPort]}
          value={port}
          onChangeText={setPort}
          keyboardType="number-pad"
          autoFocus
          placeholderTextColor={colors.textDim}
          placeholder="3000"
          maxLength={5}
        />
      </View>
      <View style={cs.editFieldRow}>
        <Text style={cs.editLabel}>Label</Text>
        <TextInput
          style={cs.editInput}
          value={label}
          onChangeText={setLabel}
          placeholderTextColor={colors.textDim}
          placeholder="z.B. Dev Server"
        />
      </View>
      <View style={cs.editFieldRow}>
        <Text style={cs.editLabel}>Pfad</Text>
        <TextInput
          style={cs.editInput}
          value={path}
          onChangeText={setPath}
          placeholderTextColor={colors.textDim}
          placeholder="/api (optional)"
        />
      </View>
      <View style={cs.editRow}>
        <TouchableOpacity style={cs.btnSave} onPress={handleSave}>
          <Feather name="check" size={14} color={colors.bg} />
          <Text style={cs.btnSaveText}>Hinzufügen</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel}>
          <Text style={cs.btnCancel}>Abbrechen</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
interface Props {
  serverId: string;
}

export function PortForwardingPanel({ serverId }: Props) {
  const { rf, rs, ri } = useResponsive();
  const { load, getEntries, addEntry, removeEntry, updateEntry } = usePortForwardingStore();
  const entries = usePortForwardingStore((s) => s.entries[serverId] ?? []);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    load(serverId);
  }, [serverId, load]);

  const handleAdd = useCallback((port: string, label: string, path?: string) => {
    addEntry(serverId);
    // addEntry creates a default entry — update it immediately with the real values
    const list = usePortForwardingStore.getState().entries[serverId] ?? [];
    const last = list[list.length - 1];
    if (last) {
      updateEntry(serverId, last.id, { port, label, path });
    }
    setAdding(false);
  }, [serverId, addEntry, updateEntry]);

  const handleUpdate = useCallback((id: string, updates: Partial<Pick<PortForward, 'port' | 'label' | 'path'>>) => {
    updateEntry(serverId, id, updates);
  }, [serverId, updateEntry]);

  const handleDelete = useCallback((id: string) => {
    removeEntry(serverId, id);
  }, [serverId, removeEntry]);

  return (
    <View style={ps.container}>
      {/* Header */}
      <View style={[ps.header, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}>
        <View style={ps.titleRow}>
          <Feather name="share-2" size={ri(14)} color={ACCENT} />
          <Text style={[ps.title, { fontSize: rf(13) }]}>Ports</Text>
        </View>
        <TouchableOpacity
          style={[ps.addBtn, adding && ps.addBtnActive]}
          onPress={() => { setAdding((v) => !v); }}
          accessibilityLabel={adding ? 'Abbrechen' : 'Neuer Port'}
          accessibilityRole="button"
        >
          <Feather name={adding ? 'x' : 'plus'} size={16} color={adding ? colors.destructive : colors.text} />
        </TouchableOpacity>
      </View>

      {/* Add form */}
      {adding && (
        <NewEntryForm
          onSave={handleAdd}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* Port list */}
      <FlatList
        data={entries}
        keyExtractor={(i) => i.id}
        style={ps.list}
        contentContainerStyle={ps.listContent}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <PortCard
            item={item}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        )}
        ListEmptyComponent={
          <View style={ps.empty}>
            <Feather name="share-2" size={32} color={colors.border} />
            <Text style={ps.emptyText}>Keine Ports konfiguriert</Text>
            <Text style={ps.emptyHint}>Tippe + um einen Port hinzuzufügen</Text>
          </View>
        }
      />

      {/* Hint */}
      {entries.length > 0 && (
        <View style={[ps.hints, { paddingHorizontal: rs(12), paddingVertical: rs(6) }]}>
          <Text style={[ps.hintText, { fontSize: rf(9) }]}>Port-Weiterleitungen für Browser-Tabs</Text>
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
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardInfo: {
    flex: 1,
    gap: 2,
  },
  portText: {
    color: ACCENT,
    fontSize: 14,
    fontFamily: fonts.mono,
    fontWeight: '700',
  },
  labelText: {
    color: colors.text,
    fontSize: 12,
  },
  pathText: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(51,65,85,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editFields: {
    gap: 8,
  },
  editFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  editLabel: {
    color: colors.textDim,
    fontSize: 11,
    width: 36,
    fontWeight: '600',
  },
  editInput: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    backgroundColor: colors.bg,
    borderRadius: 6,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  editInputPort: {
    maxWidth: 80,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 10,
  },
  btnSave: {
    backgroundColor: ACCENT,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
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
    color: ACCENT,
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
    gap: 8,
    backgroundColor: 'rgba(27, 35, 54, 0.94)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
  },
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
