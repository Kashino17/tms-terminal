import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Switch, ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { useAutopilotStore, AutopilotItem } from '../store/autopilotStore';
import { useTerminalStore } from '../store/terminalStore';
import { useResponsive } from '../hooks/useResponsive';
import { ActionSheet, ActionSheetOption } from './ActionSheet';
import { WebSocketService } from '../services/websocket.service';

// ── Status helpers ────────────────────────────────────────────────────────────
const STATUS_ICON: Record<AutopilotItem['status'], string> = {
  draft: 'edit-3',
  optimizing: 'loader',
  queued: 'check-circle',
  running: 'play',
  done: 'check',
  error: 'alert-circle',
};

const STATUS_COLOR: Record<AutopilotItem['status'], string> = {
  draft: colors.textDim,
  optimizing: colors.warning,
  queued: colors.primary,
  running: colors.accent,
  done: colors.textDim,
  error: colors.destructive,
};

// ── Item Row ──────────────────────────────────────────────────────────────────
interface RowProps {
  item: AutopilotItem;
  position: number | null;  // null for done items
  optimizeMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onLongPress: (item: AutopilotItem) => void;
}

function AutopilotRow({ item, position, optimizeMode, selected, onToggleSelect, onLongPress }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const iconColor = STATUS_COLOR[item.status];
  const iconName = STATUS_ICON[item.status] as keyof typeof Feather.glyphMap;
  const isDone = item.status === 'done';
  const isOptimizing = item.status === 'optimizing';

  return (
    <TouchableOpacity
      style={[rowStyles.row, isDone && rowStyles.rowDone]}
      onLongPress={() => onLongPress(item)}
      onPress={() => {
        if (optimizeMode && item.status === 'draft') {
          onToggleSelect(item.id);
        } else if (item.optimizedPrompt) {
          setExpanded(v => !v);
        }
      }}
      activeOpacity={0.7}
      delayLongPress={400}
    >
      {/* Checkbox in optimize mode */}
      {optimizeMode && item.status === 'draft' && (
        <TouchableOpacity
          style={[rowStyles.checkbox, selected && rowStyles.checkboxSelected]}
          onPress={() => onToggleSelect(item.id)}
          activeOpacity={0.7}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          {selected && <Feather name="check" size={12} color={colors.bg} />}
        </TouchableOpacity>
      )}

      {/* Position number */}
      {position !== null && !optimizeMode && (
        <Text style={rowStyles.positionLabel}>{position}</Text>
      )}

      {/* Status icon */}
      {!optimizeMode || item.status !== 'draft' ? (
        <View style={rowStyles.iconWrap}>
          {isOptimizing ? (
            <ActivityIndicator size="small" color={colors.warning} />
          ) : (
            <Feather name={iconName} size={14} color={iconColor} />
          )}
        </View>
      ) : null}

      {/* Content */}
      <View style={rowStyles.content}>
        <Text style={[rowStyles.text, isDone && rowStyles.textDone]} numberOfLines={expanded ? undefined : 2}>
          {item.text}
        </Text>
        {item.optimizedPrompt && expanded && (
          <View style={rowStyles.promptBox}>
            <Text style={rowStyles.promptLabel}>Optimierter Prompt:</Text>
            <Text style={rowStyles.promptText}>{item.optimizedPrompt}</Text>
          </View>
        )}
        {item.error && (
          <Text style={rowStyles.errorText} numberOfLines={2}>{item.error}</Text>
        )}
        {item.optimizedPrompt && !expanded && (
          <Text style={rowStyles.expandHint}>Tippen zum Anzeigen</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  serverId: string;
}

export function AutopilotPanel({ sessionId, wsService, serverId }: Props) {
  const { rf, rs, ri } = useResponsive();
  const store = useAutopilotStore();
  const items = useAutopilotStore((s) => sessionId ? s.getItems(sessionId) : []);
  const queueEnabled = useAutopilotStore((s) => sessionId ? s.isQueueEnabled(sessionId) : false);
  const pendingCount = useAutopilotStore((s) => sessionId ? s.getPendingCount(sessionId) : 0);

  const [draft, setDraft] = useState('');
  const [optimizeMode, setOptimizeMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionSheetItem, setActionSheetItem] = useState<AutopilotItem | null>(null);

  const draftItems = useMemo(() => items.filter(i => i.status === 'draft'), [items]);
  const hasDrafts = draftItems.length > 0;

  const positionMap = useMemo(() => {
    const map = new Map<string, number>();
    let pos = 1;
    for (const item of items) {
      if (item.status !== 'done') map.set(item.id, pos++);
    }
    return map;
  }, [items]);

  // Reset optimize mode when no drafts remain
  useEffect(() => {
    if (!hasDrafts && optimizeMode) {
      setOptimizeMode(false);
      setSelectedIds(new Set());
    }
  }, [hasDrafts, optimizeMode]);

  // WebSocket listeners for autopilot events
  useEffect(() => {
    const unsub = wsService.addMessageListener((msg: unknown) => {
      const m = msg as { type: string; sessionId?: string; payload?: any };
      if (!sessionId || m.sessionId !== sessionId) return;

      if (m.type === 'autopilot:optimized') {
        const { id, optimizedPrompt } = m.payload;
        useAutopilotStore.getState().updateItem(sessionId, id, { optimizedPrompt, status: 'queued' });
      } else if (m.type === 'autopilot:optimize_error') {
        const { id, error } = m.payload;
        useAutopilotStore.getState().updateItem(sessionId, id, { status: 'error', error });
      } else if (m.type === 'autopilot:prompt_sent') {
        const { id } = m.payload;
        useAutopilotStore.getState().updateItem(sessionId, id, { status: 'running' });
      } else if (m.type === 'autopilot:prompt_done') {
        const { id } = m.payload;
        useAutopilotStore.getState().updateItem(sessionId, id, { status: 'done', completedAt: Date.now() });
      }
    });
    return unsub;
  }, [sessionId, wsService]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleAdd = useCallback(() => {
    const text = draft.trim();
    if (!text || !sessionId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const id = store.addItem(sessionId, text);
    wsService.send({ type: 'autopilot:add_item', sessionId, payload: { id, text } });
    setDraft('');
  }, [draft, sessionId, store, wsService]);

  const handleRemove = useCallback((itemId: string) => {
    if (!sessionId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    store.removeItem(sessionId, itemId);
    wsService.send({ type: 'autopilot:remove_item', sessionId, payload: { id: itemId } });
  }, [sessionId, store, wsService]);

  const handleToggleQueue = useCallback((enabled: boolean) => {
    if (!sessionId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    store.setQueueEnabled(sessionId, enabled);
    wsService.send({ type: 'autopilot:queue_toggle', sessionId, payload: { enabled } });
  }, [sessionId, store, wsService]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleOptimizeConfirm = useCallback(() => {
    if (!sessionId || selectedIds.size === 0) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Mark selected items as optimizing
    for (const id of selectedIds) {
      store.updateItem(sessionId, id, { status: 'optimizing' });
    }

    // Get lastCwd from the terminal tab
    const tabs = useTerminalStore.getState().getTabs(serverId);
    const activeTab = tabs.find(t => t.sessionId === sessionId);
    const lastCwd = activeTab?.lastCwd;

    // Send optimize request
    const itemsToOptimize = items
      .filter(i => selectedIds.has(i.id))
      .map(i => ({ id: i.id, text: i.text }));

    wsService.send({
      type: 'autopilot:optimize',
      sessionId,
      payload: { items: itemsToOptimize, cwd: lastCwd },
    });

    setOptimizeMode(false);
    setSelectedIds(new Set());
  }, [sessionId, selectedIds, items, store, wsService, serverId]);

  const handleMoveUp = useCallback((itemId: string) => {
    if (!sessionId) return;
    const currentItems = useAutopilotStore.getState().getItems(sessionId);
    const idx = currentItems.findIndex(i => i.id === itemId);
    if (idx <= 0) return;
    const ids = currentItems.map(i => i.id);
    [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
    store.reorderItems(sessionId, ids);
  }, [sessionId, store]);

  const handleMoveDown = useCallback((itemId: string) => {
    if (!sessionId) return;
    const currentItems = useAutopilotStore.getState().getItems(sessionId);
    const idx = currentItems.findIndex(i => i.id === itemId);
    if (idx < 0 || idx >= currentItems.length - 1) return;
    const ids = currentItems.map(i => i.id);
    [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
    store.reorderItems(sessionId, ids);
  }, [sessionId, store]);

  // ── ActionSheet options ─────────────────────────────────────────────────────
  const actionSheetOptions: ActionSheetOption[] = useMemo(() => {
    if (!actionSheetItem) return [];
    return [
      {
        label: 'Nach oben',
        icon: 'arrow-up',
        onPress: () => handleMoveUp(actionSheetItem.id),
      },
      {
        label: 'Nach unten',
        icon: 'arrow-down',
        onPress: () => handleMoveDown(actionSheetItem.id),
      },
      {
        label: 'Loeschen',
        icon: 'trash-2',
        destructive: true,
        onPress: () => handleRemove(actionSheetItem.id),
      },
    ];
  }, [actionSheetItem, handleMoveUp, handleMoveDown, handleRemove]);

  if (!sessionId) {
    return (
      <View style={panelStyles.container}>
        <View style={panelStyles.empty}>
          <Feather name="play-circle" size={32} color={colors.border} />
          <Text style={panelStyles.emptyText}>Keine Session aktiv</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={panelStyles.container}>
      {/* Header */}
      <View style={[panelStyles.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="play-circle" size={ri(14)} color="#A78BFA" />
        <Text style={[panelStyles.title, { fontSize: rf(13) }]}>Autopilot</Text>
        {pendingCount > 0 && (
          <View style={[panelStyles.badge, { minWidth: rs(18), height: rs(18), borderRadius: rs(9) }]}>
            <Text style={[panelStyles.badgeText, { fontSize: rf(10) }]}>{pendingCount}</Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        <Switch
          value={queueEnabled}
          onValueChange={handleToggleQueue}
          trackColor={{ false: colors.border, true: colors.accent + '60' }}
          thumbColor={queueEnabled ? colors.accent : colors.textDim}
          ios_backgroundColor={colors.border}
          style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
        />
      </View>

      <View style={panelStyles.divider} />

      {/* Add input */}
      <View style={panelStyles.inputWrap}>
        <TextInput
          style={panelStyles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Neuer To-Do..."
          placeholderTextColor={colors.textDim}
          multiline
          onSubmitEditing={handleAdd}
          blurOnSubmit
        />
        <TouchableOpacity
          style={[panelStyles.confirmBtn, !draft.trim() && panelStyles.confirmBtnDisabled]}
          onPress={handleAdd}
          activeOpacity={0.7}
          disabled={!draft.trim()}
        >
          <Text style={panelStyles.confirmText}>Hinzufuegen</Text>
        </TouchableOpacity>
      </View>

      {/* Optimize bar */}
      {hasDrafts && (
        <View style={panelStyles.optimizeBar}>
          {!optimizeMode ? (
            <TouchableOpacity
              style={panelStyles.optimizeBtn}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setOptimizeMode(true);
                setSelectedIds(new Set());
              }}
              activeOpacity={0.7}
            >
              <Feather name="zap" size={14} color={colors.warning} />
              <Text style={panelStyles.optimizeBtnText}>Optimieren</Text>
            </TouchableOpacity>
          ) : (
            <View style={panelStyles.optimizeActions}>
              <Text style={panelStyles.selectedCount}>
                {selectedIds.size} ausgewaehlt
              </Text>
              <TouchableOpacity
                style={[panelStyles.readyBtn, selectedIds.size === 0 && panelStyles.readyBtnDisabled]}
                onPress={handleOptimizeConfirm}
                activeOpacity={0.7}
                disabled={selectedIds.size === 0}
              >
                <Text style={panelStyles.readyBtnText}>Ready?</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={panelStyles.cancelBtn}
                onPress={() => { setOptimizeMode(false); setSelectedIds(new Set()); }}
                activeOpacity={0.7}
              >
                <Text style={panelStyles.cancelBtnText}>Abbrechen</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Queue list */}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        style={panelStyles.list}
        contentContainerStyle={panelStyles.listContent}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <AutopilotRow
            item={item}
            position={positionMap.get(item.id) ?? null}
            optimizeMode={optimizeMode}
            selected={selectedIds.has(item.id)}
            onToggleSelect={handleToggleSelect}
            onLongPress={setActionSheetItem}
          />
        )}
        ListEmptyComponent={
          <View style={panelStyles.empty}>
            <Feather name="play-circle" size={32} color={colors.border} />
            <Text style={panelStyles.emptyText}>Keine Aufgaben</Text>
            <Text style={panelStyles.emptyHint}>Fuege einen To-Do hinzu</Text>
          </View>
        }
      />

      {/* Footer stats */}
      {items.length > 0 && (
        <View style={[panelStyles.footer, { paddingHorizontal: rs(12), paddingVertical: rs(8) }]}>
          <Text style={[panelStyles.footerText, { fontSize: rf(9) }]}>
            {items.filter(i => i.status === 'done').length}/{items.length} erledigt
            {pendingCount > 0 ? ` \u00B7 ${pendingCount} in Warteschlange` : ''}
          </Text>
        </View>
      )}

      {/* ActionSheet for long-press */}
      <ActionSheet
        visible={!!actionSheetItem}
        title={actionSheetItem?.text}
        options={actionSheetOptions}
        onClose={() => setActionSheetItem(null)}
      />
    </View>
  );
}

// ── Row styles ────────────────────────────────────────────────────────────────
const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(51,65,85,0.3)',
  },
  rowDone: {
    opacity: 0.5,
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
  checkboxSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  iconWrap: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  positionLabel: {
    width: 18,
    textAlign: 'center',
    color: colors.textDim,
    fontSize: 10,
    fontFamily: fonts.mono,
    marginTop: 3,
  },
  content: {
    flex: 1,
  },
  text: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 18,
  },
  textDone: {
    textDecorationLine: 'line-through',
    color: colors.textDim,
  },
  promptBox: {
    marginTop: 6,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 6,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  promptLabel: {
    color: colors.textDim,
    fontSize: 10,
    marginBottom: 4,
    fontWeight: '600',
  },
  promptText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: fonts.mono,
    lineHeight: 16,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 10,
    fontFamily: fonts.mono,
    marginTop: 4,
  },
  expandHint: {
    color: colors.textDim,
    fontSize: 9,
    marginTop: 2,
  },
});

// ── Panel styles ──────────────────────────────────────────────────────────────
const panelStyles = StyleSheet.create({
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
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 14,
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
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 13,
  },
  // ── Optimize bar ──
  optimizeBar: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51,65,85,0.5)',
  },
  optimizeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 7,
    paddingVertical: 7,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.warning + '40',
  },
  optimizeBtnText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: '600',
  },
  optimizeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  selectedCount: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: fonts.mono,
    flex: 1,
  },
  readyBtn: {
    backgroundColor: colors.accent,
    borderRadius: 7,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  readyBtnDisabled: {
    opacity: 0.4,
  },
  readyBtnText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '700',
  },
  cancelBtn: {
    backgroundColor: colors.border,
    borderRadius: 7,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  cancelBtnText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  // ── List ──
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
  // ── Footer ──
  footer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(51,65,85,0.5)',
  },
  footerText: {
    color: colors.textDim,
    fontSize: 9,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
