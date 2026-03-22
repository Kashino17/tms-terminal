# Autopilot Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Autopilot feature with optional optimization, queue numbering, extended reordering, and a global prompt library.

**Architecture:** All changes are client-side (React Native store + UI) except one 2-line server tweak. The store gains new reorder methods and a `savedPrompts` collection. The UI gains position numbers, an extended ActionSheet with status-aware options, a position picker modal, and a collapsible prompt library section.

**Tech Stack:** React Native, Zustand (with AsyncStorage persist), TypeScript, Expo Haptics, WebSocket

**Spec:** `docs/superpowers/specs/2026-03-21-autopilot-improvements-design.md`

---

### Task 1: Server — accept optional status/optimizedPrompt in add_item handler

**Files:**
- Modify: `server/src/websocket/ws.handler.ts:284-290`

- [ ] **Step 1: Update the `autopilot:add_item` handler**

In `ws.handler.ts`, the handler at line 284-290 currently hardcodes `status: 'draft'`. Change it to accept optional `status` and `optimizedPrompt` from the payload, defaulting to `'draft'`:

```typescript
if (msgType === 'autopilot:add_item') {
  const sessionId = (msg as any).sessionId;
  const item = (msg as any).payload;
  if (sessionId && item?.id && item?.text) {
    autopilotService.addItem(sessionId, {
      id: item.id,
      text: item.text,
      status: item.status ?? 'draft',
      optimizedPrompt: item.optimizedPrompt,
    });
  }
  return;
}
```

- [ ] **Step 2: Verify server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(autopilot): accept optional status/optimizedPrompt in add_item handler"
```

---

### Task 2: Store — reorder methods, queueDirectly, and WebSocket sync fix

**Files:**
- Modify: `mobile/src/store/autopilotStore.ts`

This task adds `queueDirectly`, `moveToTop`, `moveToBottom`, `moveToPosition` to the store. It does NOT touch the UI yet.

- [ ] **Step 1: Add new method signatures to the `AutopilotState` interface**

In `autopilotStore.ts`, add these methods to the `AutopilotState` interface (after `reorderItems` at line 23):

```typescript
queueDirectly: (sessionId: string, itemId: string) => void;
moveToTop: (sessionId: string, itemId: string) => void;
moveToBottom: (sessionId: string, itemId: string) => void;
moveToPosition: (sessionId: string, itemId: string, targetPosition: number) => void;
```

- [ ] **Step 2: Implement `queueDirectly`**

Add after the `reorderItems` implementation (after line 88):

```typescript
queueDirectly: (sessionId, itemId) => {
  const items = get().items[sessionId] ?? [];
  const item = items.find(i => i.id === itemId);
  if (!item) return;
  set((s) => ({
    items: {
      ...s.items,
      [sessionId]: (s.items[sessionId] ?? []).map(i =>
        i.id === itemId ? { ...i, status: 'queued' as const, optimizedPrompt: i.text } : i
      ),
    },
  }));
},
```

- [ ] **Step 3: Implement `moveToTop`, `moveToBottom`, `moveToPosition`**

These methods reorder only active (non-done) items. Add after `queueDirectly`:

```typescript
moveToTop: (sessionId, itemId) => {
  const all = get().items[sessionId] ?? [];
  const active = all.filter(i => i.status !== 'done');
  const done = all.filter(i => i.status === 'done');
  const idx = active.findIndex(i => i.id === itemId);
  if (idx <= 0) return;
  const [item] = active.splice(idx, 1);
  active.unshift(item);
  set((s) => ({ items: { ...s.items, [sessionId]: [...active, ...done] } }));
},

moveToBottom: (sessionId, itemId) => {
  const all = get().items[sessionId] ?? [];
  const active = all.filter(i => i.status !== 'done');
  const done = all.filter(i => i.status === 'done');
  const idx = active.findIndex(i => i.id === itemId);
  if (idx < 0 || idx === active.length - 1) return;
  const [item] = active.splice(idx, 1);
  active.push(item);
  set((s) => ({ items: { ...s.items, [sessionId]: [...active, ...done] } }));
},

moveToPosition: (sessionId, itemId, targetPosition) => {
  const all = get().items[sessionId] ?? [];
  const active = all.filter(i => i.status !== 'done');
  const done = all.filter(i => i.status === 'done');
  const idx = active.findIndex(i => i.id === itemId);
  if (idx < 0) return;
  const targetIdx = Math.max(0, Math.min(targetPosition - 1, active.length - 1));
  if (idx === targetIdx) return;
  const [item] = active.splice(idx, 1);
  active.splice(targetIdx, 0, item);
  set((s) => ({ items: { ...s.items, [sessionId]: [...active, ...done] } }));
},
```

- [ ] **Step 4: Verify the store compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/store/autopilotStore.ts
git commit -m "feat(autopilot): add queueDirectly, moveToTop/Bottom/Position store methods"
```

---

### Task 3: Store — prompt library (savedPrompts)

**Files:**
- Modify: `mobile/src/store/autopilotStore.ts`

- [ ] **Step 1: Add `SavedPrompt` interface and extend store state**

Add the `SavedPrompt` interface after `AutopilotItem` (after line 13):

```typescript
export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  createdAt: number;
}
```

Add to `AutopilotState` interface:

```typescript
savedPrompts: SavedPrompt[];
addSavedPrompt: (title: string, text: string) => void;
updateSavedPrompt: (id: string, updates: Partial<Pick<SavedPrompt, 'title' | 'text'>>) => void;
removeSavedPrompt: (id: string) => void;
addSavedToQueue: (sessionId: string, savedPromptId: string) => string | null;
```

- [ ] **Step 2: Add default state and implementations**

Add `savedPrompts: []` to the initial state (after `queueEnabled: {}` at line 43).

Add implementations after the cleanup method (before the closing `}`):

```typescript
savedPrompts: [],

addSavedPrompt: (title, text) => {
  const prompt: SavedPrompt = { id: makeId(), title, text, createdAt: Date.now() };
  set((s) => ({ savedPrompts: [...s.savedPrompts, prompt] }));
},

updateSavedPrompt: (id, updates) => {
  set((s) => ({
    savedPrompts: s.savedPrompts.map(p => p.id === id ? { ...p, ...updates } : p),
  }));
},

removeSavedPrompt: (id) => {
  set((s) => ({ savedPrompts: s.savedPrompts.filter(p => p.id !== id) }));
},

addSavedToQueue: (sessionId, savedPromptId) => {
  const saved = get().savedPrompts.find(p => p.id === savedPromptId);
  if (!saved) return null;
  const id = makeId();
  const item: AutopilotItem = {
    id,
    text: saved.text,
    optimizedPrompt: saved.text,
    status: 'queued',
    createdAt: Date.now(),
  };
  set((s) => ({
    items: { ...s.items, [sessionId]: [...(s.items[sessionId] ?? []), item] },
  }));
  return id;
},
```

- [ ] **Step 3: Verify the store compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/store/autopilotStore.ts
git commit -m "feat(autopilot): add savedPrompts library to store"
```

---

### Task 4: UI — queue numbering in AutopilotRow

**Files:**
- Modify: `mobile/src/components/AutopilotPanel.tsx`

- [ ] **Step 1: Add `position` prop to AutopilotRow**

Update the `RowProps` interface (line 35-41) to include `position`:

```typescript
interface RowProps {
  item: AutopilotItem;
  position: number | null;  // null for done items
  optimizeMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onLongPress: (item: AutopilotItem) => void;
}
```

Update the function signature to destructure `position`:

```typescript
function AutopilotRow({ item, position, optimizeMode, selected, onToggleSelect, onLongPress }: RowProps) {
```

- [ ] **Step 2: Render the position number in the row**

Add the position number before the status icon (after the checkbox block, around line 74, before `{/* Status icon */}`):

```tsx
{/* Position number */}
{position !== null && !optimizeMode && (
  <Text style={rowStyles.positionLabel}>{position}</Text>
)}
```

- [ ] **Step 3: Add the `positionLabel` style**

Add to `rowStyles` StyleSheet (after `iconWrap` at line 444):

```typescript
positionLabel: {
  width: 18,
  textAlign: 'center',
  color: colors.textDim,
  fontSize: 10,
  fontFamily: fonts.mono,
  marginTop: 3,
},
```

- [ ] **Step 4: Pass `position` from the FlatList renderItem**

In the FlatList `renderItem` (around line 371), compute the position. Active items get 1-based index, done items get `null`:

First, add a `positionMap` memoization before the FlatList (e.g. near the other `useMemo` calls):

```typescript
const positionMap = useMemo(() => {
  const map = new Map<string, number>();
  let pos = 1;
  for (const item of items) {
    if (item.status !== 'done') map.set(item.id, pos++);
  }
  return map;
}, [items]);
```

Then update the `renderItem`:

```tsx
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
```

- [ ] **Step 5: Verify it compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/components/AutopilotPanel.tsx
git commit -m "feat(autopilot): show position numbers on active queue items"
```

---

### Task 5: UI — extended ActionSheet with status-aware options + fix WS sync

**Files:**
- Modify: `mobile/src/components/AutopilotPanel.tsx`

This task replaces the existing ActionSheet options with status-aware options, adds the "Direkt in Queue" and "Prompt speichern" options, fixes the reorder WebSocket sync bug, and adds the position picker modal.

- [ ] **Step 1: Add state for position picker modal and save-prompt form**

Add these state variables after `actionSheetItem` (line 126):

```typescript
const [positionPickerItem, setPositionPickerItem] = useState<AutopilotItem | null>(null);
const [savePromptItem, setSavePromptItem] = useState<AutopilotItem | null>(null);
const [savePromptTitle, setSavePromptTitle] = useState('');
```

- [ ] **Step 2: Refactor handleMoveUp and handleMoveDown — fix active-only filtering + add WS sync**

Replace lines 223-241. Key fixes: (1) filter to active items only so swaps can't cross the active/done boundary, (2) send `autopilot:reorder` via WebSocket (was missing — pre-existing bug):

```typescript
const handleMoveUp = useCallback((itemId: string) => {
  if (!sessionId) return;
  const allItems = useAutopilotStore.getState().getItems(sessionId);
  const active = allItems.filter(i => i.status !== 'done');
  const idx = active.findIndex(i => i.id === itemId);
  if (idx <= 0) return;
  [active[idx - 1], active[idx]] = [active[idx], active[idx - 1]];
  const done = allItems.filter(i => i.status === 'done');
  const newIds = [...active, ...done].map(i => i.id);
  store.reorderItems(sessionId, newIds);
  wsService.send({ type: 'autopilot:reorder', sessionId, payload: { itemIds: newIds } });
}, [sessionId, store, wsService]);

const handleMoveDown = useCallback((itemId: string) => {
  if (!sessionId) return;
  const allItems = useAutopilotStore.getState().getItems(sessionId);
  const active = allItems.filter(i => i.status !== 'done');
  const idx = active.findIndex(i => i.id === itemId);
  if (idx < 0 || idx >= active.length - 1) return;
  [active[idx], active[idx + 1]] = [active[idx + 1], active[idx]];
  const done = allItems.filter(i => i.status === 'done');
  const newIds = [...active, ...done].map(i => i.id);
  store.reorderItems(sessionId, newIds);
  wsService.send({ type: 'autopilot:reorder', sessionId, payload: { itemIds: newIds } });
}, [sessionId, store, wsService]);
```

- [ ] **Step 3: Add handlers for new reorder actions**

Add after handleMoveDown. All follow the same pattern: mutate store, then sync full ID list via WebSocket:

```typescript
const handleMoveToTop = useCallback((itemId: string) => {
  if (!sessionId) return;
  store.moveToTop(sessionId, itemId);
  const newIds = useAutopilotStore.getState().getItems(sessionId).map(i => i.id);
  wsService.send({ type: 'autopilot:reorder', sessionId, payload: { itemIds: newIds } });
}, [sessionId, store, wsService]);

const handleMoveToBottom = useCallback((itemId: string) => {
  if (!sessionId) return;
  store.moveToBottom(sessionId, itemId);
  const newIds = useAutopilotStore.getState().getItems(sessionId).map(i => i.id);
  wsService.send({ type: 'autopilot:reorder', sessionId, payload: { itemIds: newIds } });
}, [sessionId, store, wsService]);

const handleMoveToPosition = useCallback((itemId: string, position: number) => {
  if (!sessionId) return;
  store.moveToPosition(sessionId, itemId, position);
  const newIds = useAutopilotStore.getState().getItems(sessionId).map(i => i.id);
  wsService.send({ type: 'autopilot:reorder', sessionId, payload: { itemIds: newIds } });
}, [sessionId, store, wsService]);

const handleQueueDirectly = useCallback((itemId: string) => {
  if (!sessionId) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  store.queueDirectly(sessionId, itemId);
  const item = useAutopilotStore.getState().getItems(sessionId).find(i => i.id === itemId);
  if (item) {
    wsService.send({
      type: 'autopilot:update_item',
      sessionId,
      payload: { id: itemId, status: 'queued', optimizedPrompt: item.text },
    });
  }
}, [sessionId, store, wsService]);

const handleSavePrompt = useCallback((item: AutopilotItem) => {
  setSavePromptItem(item);
  setSavePromptTitle('');
}, []);

const handleConfirmSavePrompt = useCallback(() => {
  if (!savePromptItem || !savePromptTitle.trim()) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const text = savePromptItem.optimizedPrompt || savePromptItem.text;
  store.addSavedPrompt(savePromptTitle.trim(), text);
  setSavePromptItem(null);
  setSavePromptTitle('');
}, [savePromptItem, savePromptTitle, store]);
```

- [ ] **Step 4: Replace ActionSheet options with status-aware logic**

Replace the existing `actionSheetOptions` useMemo (lines 244-264):

```typescript
const activeItemCount = useMemo(() => items.filter(i => i.status !== 'done').length, [items]);

const actionSheetOptions: ActionSheetOption[] = useMemo(() => {
  if (!actionSheetItem) return [];
  const s = actionSheetItem.status;
  const canReorder = s !== 'running' && s !== 'done';
  const canQueueDirectly = s === 'draft' || s === 'error';
  const canDelete = s !== 'running';

  const opts: ActionSheetOption[] = [];

  if (canReorder) {
    opts.push(
      { label: 'Ganz nach oben', icon: 'chevrons-up', onPress: () => handleMoveToTop(actionSheetItem.id) },
      { label: 'Nach oben', icon: 'arrow-up', onPress: () => handleMoveUp(actionSheetItem.id) },
      { label: 'Nach unten', icon: 'arrow-down', onPress: () => handleMoveDown(actionSheetItem.id) },
      { label: 'Ganz nach unten', icon: 'chevrons-down', onPress: () => handleMoveToBottom(actionSheetItem.id) },
    );
    if (activeItemCount > 2) {
      opts.push({
        label: 'Position waehlen...',
        icon: 'hash',
        onPress: () => setPositionPickerItem(actionSheetItem),
      });
    }
  }

  if (canQueueDirectly) {
    opts.push({
      label: 'Direkt in Queue',
      icon: 'fast-forward',
      onPress: () => handleQueueDirectly(actionSheetItem.id),
    });
  }

  opts.push({
    label: 'Prompt speichern',
    icon: 'bookmark',
    onPress: () => handleSavePrompt(actionSheetItem),
  });

  if (canDelete) {
    opts.push({
      label: 'Loeschen',
      icon: 'trash-2',
      destructive: true,
      onPress: () => handleRemove(actionSheetItem.id),
    });
  }

  return opts;
}, [actionSheetItem, activeItemCount, handleMoveToTop, handleMoveUp, handleMoveDown, handleMoveToBottom, handleQueueDirectly, handleSavePrompt, handleRemove]);
```

- [ ] **Step 5: Add the Position Picker Modal and Save Prompt Modal**

Import `Modal` and `ScrollView` at the top of the file (add to the `react-native` import on line 3):

```typescript
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Switch, ActivityIndicator, Modal, ScrollView,
} from 'react-native';
```

Add the Position Picker Modal JSX right before the closing `</View>` of the panel (before line 406), after the ActionSheet:

```tsx
{/* Position Picker Modal */}
<Modal
  visible={!!positionPickerItem}
  transparent
  animationType="fade"
  onRequestClose={() => setPositionPickerItem(null)}
>
  <TouchableOpacity
    style={modalStyles.overlay}
    activeOpacity={1}
    onPress={() => setPositionPickerItem(null)}
  >
    <View style={modalStyles.container} onStartShouldSetResponder={() => true}>
      <Text style={modalStyles.title}>Position waehlen</Text>
      <ScrollView style={modalStyles.scrollArea} contentContainerStyle={modalStyles.scrollContent}>
        {Array.from({ length: activeItemCount }, (_, i) => {
          const pos = i + 1;
          const currentPos = positionPickerItem
            ? items.filter(it => it.status !== 'done').findIndex(it => it.id === positionPickerItem.id) + 1
            : -1;
          const isCurrent = pos === currentPos;
          return (
            <TouchableOpacity
              key={pos}
              style={[modalStyles.positionBtn, isCurrent && modalStyles.positionBtnCurrent]}
              onPress={() => {
                if (positionPickerItem && !isCurrent) {
                  handleMoveToPosition(positionPickerItem.id, pos);
                }
                setPositionPickerItem(null);
              }}
              activeOpacity={0.7}
            >
              <Text style={[modalStyles.positionText, isCurrent && modalStyles.positionTextCurrent]}>
                {pos}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <TouchableOpacity
        style={modalStyles.cancelBtn}
        onPress={() => setPositionPickerItem(null)}
        activeOpacity={0.7}
      >
        <Text style={modalStyles.cancelText}>Abbrechen</Text>
      </TouchableOpacity>
    </View>
  </TouchableOpacity>
</Modal>

{/* Save Prompt Modal */}
<Modal
  visible={!!savePromptItem}
  transparent
  animationType="fade"
  onRequestClose={() => setSavePromptItem(null)}
>
  <TouchableOpacity
    style={modalStyles.overlay}
    activeOpacity={1}
    onPress={() => setSavePromptItem(null)}
  >
    <View style={modalStyles.container} onStartShouldSetResponder={() => true}>
      <Text style={modalStyles.title}>Prompt speichern</Text>
      <TextInput
        style={modalStyles.input}
        value={savePromptTitle}
        onChangeText={setSavePromptTitle}
        placeholder="Titel eingeben..."
        placeholderTextColor={colors.textDim}
        autoFocus
      />
      <Text style={modalStyles.previewLabel}>Prompt:</Text>
      <Text style={modalStyles.previewText} numberOfLines={4}>
        {savePromptItem?.optimizedPrompt || savePromptItem?.text}
      </Text>
      <View style={modalStyles.btnRow}>
        <TouchableOpacity
          style={modalStyles.cancelBtn}
          onPress={() => setSavePromptItem(null)}
          activeOpacity={0.7}
        >
          <Text style={modalStyles.cancelText}>Abbrechen</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[modalStyles.confirmBtn, !savePromptTitle.trim() && { opacity: 0.4 }]}
          onPress={handleConfirmSavePrompt}
          activeOpacity={0.7}
          disabled={!savePromptTitle.trim()}
        >
          <Text style={modalStyles.confirmText}>Speichern</Text>
        </TouchableOpacity>
      </View>
    </View>
  </TouchableOpacity>
</Modal>
```

- [ ] **Step 6: Add modal styles**

Add a new `modalStyles` StyleSheet at the bottom of the file (after `panelStyles`):

```typescript
const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    width: '80%',
    maxHeight: '60%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  scrollArea: {
    maxHeight: 250,
  },
  scrollContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  },
  positionBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  positionBtnCurrent: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '20',
  },
  positionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: fonts.mono,
  },
  positionTextCurrent: {
    color: colors.primary,
  },
  cancelBtn: {
    marginTop: 12,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: colors.border,
    borderRadius: 8,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
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
    marginBottom: 10,
  },
  previewLabel: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 4,
  },
  previewText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: fonts.mono,
    lineHeight: 16,
    marginBottom: 12,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: '#A78BFA',
    borderRadius: 8,
  },
  confirmText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '700',
  },
});
```

- [ ] **Step 7: Verify it compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/components/AutopilotPanel.tsx
git commit -m "feat(autopilot): extended ActionSheet, position picker, save prompt, fix WS reorder sync"
```

---

### Task 6: UI — prompt library collapsible section

**Files:**
- Modify: `mobile/src/components/AutopilotPanel.tsx`

- [ ] **Step 1: Add state for the library section**

Add these state variables (near the other state declarations):

```typescript
const [libraryExpanded, setLibraryExpanded] = useState(false);
const [newPromptMode, setNewPromptMode] = useState(false);
const [newPromptTitle, setNewPromptTitle] = useState('');
const [newPromptText, setNewPromptText] = useState('');
const [editingPrompt, setEditingPrompt] = useState<string | null>(null); // savedPrompt id
const [editTitle, setEditTitle] = useState('');
const [editText, setEditText] = useState('');
const [libraryActionSheetItem, setLibraryActionSheetItem] = useState<SavedPrompt | null>(null);

const savedPrompts = useAutopilotStore((s) => s.savedPrompts);
```

Import `SavedPrompt` from the store (update line 9):

```typescript
import { useAutopilotStore, AutopilotItem, SavedPrompt } from '../store/autopilotStore';
```

- [ ] **Step 2: Add handlers for the library**

Add after the existing handlers:

```typescript
const handleAddSavedToQueue = useCallback((savedPromptId: string) => {
  if (!sessionId) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const id = store.addSavedToQueue(sessionId, savedPromptId);
  if (id) {
    const saved = useAutopilotStore.getState().savedPrompts.find(p => p.id === savedPromptId);
    if (saved) {
      wsService.send({
        type: 'autopilot:add_item',
        sessionId,
        payload: { id, text: saved.text, status: 'queued', optimizedPrompt: saved.text },
      });
    }
  }
}, [sessionId, store, wsService]);

const handleAddNewSavedPrompt = useCallback(() => {
  if (!newPromptTitle.trim() || !newPromptText.trim()) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  store.addSavedPrompt(newPromptTitle.trim(), newPromptText.trim());
  setNewPromptTitle('');
  setNewPromptText('');
  setNewPromptMode(false);
}, [newPromptTitle, newPromptText, store]);

const handleEditSavedPrompt = useCallback((prompt: SavedPrompt) => {
  setEditingPrompt(prompt.id);
  setEditTitle(prompt.title);
  setEditText(prompt.text);
  setLibraryActionSheetItem(null);
}, []);

const handleConfirmEditSavedPrompt = useCallback(() => {
  if (!editingPrompt || !editTitle.trim() || !editText.trim()) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  store.updateSavedPrompt(editingPrompt, { title: editTitle.trim(), text: editText.trim() });
  setEditingPrompt(null);
  setEditTitle('');
  setEditText('');
}, [editingPrompt, editTitle, editText, store]);

const handleDeleteSavedPrompt = useCallback((id: string) => {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  store.removeSavedPrompt(id);
  setLibraryActionSheetItem(null);
}, [store]);
```

- [ ] **Step 3: Add the library section JSX**

Insert this between the Footer stats section and the ActionSheet (after the footer `</View>}` around line 397, before `{/* ActionSheet for long-press */}`):

```tsx
{/* Prompt Library */}
<View style={panelStyles.divider} />
<TouchableOpacity
  style={libraryStyles.header}
  onPress={() => setLibraryExpanded(v => !v)}
  activeOpacity={0.7}
>
  <Feather name="bookmark" size={13} color={colors.textDim} />
  <Text style={libraryStyles.headerText}>Gespeicherte Prompts</Text>
  {savedPrompts.length > 0 && (
    <View style={[panelStyles.badge, { minWidth: 16, height: 16, borderRadius: 8 }]}>
      <Text style={[panelStyles.badgeText, { fontSize: 9 }]}>{savedPrompts.length}</Text>
    </View>
  )}
  <View style={{ flex: 1 }} />
  <Feather name={libraryExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
</TouchableOpacity>

{libraryExpanded && (
  <View style={libraryStyles.content}>
    {savedPrompts.map((sp) => (
      <TouchableOpacity
        key={sp.id}
        style={libraryStyles.row}
        onLongPress={() => setLibraryActionSheetItem(sp)}
        activeOpacity={0.7}
        delayLongPress={400}
      >
        {editingPrompt === sp.id ? (
          <View style={libraryStyles.editForm}>
            <TextInput
              style={modalStyles.input}
              value={editTitle}
              onChangeText={setEditTitle}
              placeholder="Titel..."
              placeholderTextColor={colors.textDim}
              autoFocus
            />
            <TextInput
              style={[modalStyles.input, { maxHeight: 80 }]}
              value={editText}
              onChangeText={setEditText}
              placeholder="Prompt..."
              placeholderTextColor={colors.textDim}
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <TouchableOpacity
                style={[modalStyles.cancelBtn, { flex: 1, marginTop: 0 }]}
                onPress={() => setEditingPrompt(null)}
                activeOpacity={0.7}
              >
                <Text style={modalStyles.cancelText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.confirmBtn, (!editTitle.trim() || !editText.trim()) && { opacity: 0.4 }]}
                onPress={handleConfirmEditSavedPrompt}
                activeOpacity={0.7}
                disabled={!editTitle.trim() || !editText.trim()}
              >
                <Text style={modalStyles.confirmText}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={libraryStyles.rowContent}>
            <View style={{ flex: 1 }}>
              <Text style={libraryStyles.rowTitle}>{sp.title}</Text>
              <Text style={libraryStyles.rowPreview} numberOfLines={1}>{sp.text}</Text>
            </View>
            <TouchableOpacity
              style={libraryStyles.queueBtn}
              onPress={() => handleAddSavedToQueue(sp.id)}
              activeOpacity={0.7}
              disabled={!sessionId}
            >
              <Text style={[libraryStyles.queueBtnText, !sessionId && { opacity: 0.4 }]}>In Queue</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    ))}

    {savedPrompts.length === 0 && !newPromptMode && (
      <Text style={libraryStyles.emptyText}>Keine gespeicherten Prompts</Text>
    )}

    {newPromptMode ? (
      <View style={libraryStyles.newForm}>
        <TextInput
          style={modalStyles.input}
          value={newPromptTitle}
          onChangeText={setNewPromptTitle}
          placeholder="Titel..."
          placeholderTextColor={colors.textDim}
          autoFocus
        />
        <TextInput
          style={[modalStyles.input, { maxHeight: 80 }]}
          value={newPromptText}
          onChangeText={setNewPromptText}
          placeholder="Prompt-Text..."
          placeholderTextColor={colors.textDim}
          multiline
        />
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <TouchableOpacity
            style={[modalStyles.cancelBtn, { flex: 1, marginTop: 0 }]}
            onPress={() => { setNewPromptMode(false); setNewPromptTitle(''); setNewPromptText(''); }}
            activeOpacity={0.7}
          >
            <Text style={modalStyles.cancelText}>Abbrechen</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[modalStyles.confirmBtn, (!newPromptTitle.trim() || !newPromptText.trim()) && { opacity: 0.4 }]}
            onPress={handleAddNewSavedPrompt}
            activeOpacity={0.7}
            disabled={!newPromptTitle.trim() || !newPromptText.trim()}
          >
            <Text style={modalStyles.confirmText}>Speichern</Text>
          </TouchableOpacity>
        </View>
      </View>
    ) : (
      <TouchableOpacity
        style={libraryStyles.addBtn}
        onPress={() => setNewPromptMode(true)}
        activeOpacity={0.7}
      >
        <Feather name="plus" size={12} color={colors.primary} />
        <Text style={libraryStyles.addBtnText}>Neuen Prompt speichern</Text>
      </TouchableOpacity>
    )}
  </View>
)}

{/* Library ActionSheet */}
<ActionSheet
  visible={!!libraryActionSheetItem}
  title={libraryActionSheetItem?.title}
  options={libraryActionSheetItem ? [
    { label: 'Bearbeiten', icon: 'edit-2', onPress: () => handleEditSavedPrompt(libraryActionSheetItem!) },
    { label: 'Loeschen', icon: 'trash-2', destructive: true, onPress: () => handleDeleteSavedPrompt(libraryActionSheetItem!.id) },
  ] : []}
  onClose={() => setLibraryActionSheetItem(null)}
/>
```

- [ ] **Step 4: Add library styles**

Add a new `libraryStyles` StyleSheet at the bottom of the file:

```typescript
const libraryStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  headerText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  content: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(51,65,85,0.3)',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  rowPreview: {
    color: colors.textDim,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  queueBtn: {
    backgroundColor: colors.primary + '20',
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.primary + '40',
  },
  queueBtnText: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
  },
  emptyText: {
    color: colors.textDim,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 12,
  },
  newForm: {
    marginTop: 8,
    gap: 6,
  },
  editForm: {
    gap: 6,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  addBtnText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '600',
  },
});
```

- [ ] **Step 5: Verify it compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/components/AutopilotPanel.tsx
git commit -m "feat(autopilot): add collapsible prompt library section"
```

---

### Task 7: Final verification and release commit

- [ ] **Step 1: Verify server compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Verify mobile compiles**

Run: `cd mobile && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Manual test checklist (for the developer)**

Verify on device or emulator:
- [ ] Add a draft → long-press → "Direkt in Queue" → item becomes queued with position number
- [ ] Queue items show position numbers (1, 2, 3...), done items do not
- [ ] Long-press → "Ganz nach oben" moves item to position 1
- [ ] Long-press → "Ganz nach unten" moves item to last position
- [ ] Long-press → "Position waehlen..." → picker opens → select a number → item moves, picker closes
- [ ] Long-press → "Prompt speichern" → modal opens → enter title → save → appears in library
- [ ] Expand "Gespeicherte Prompts" section → saved prompt shows
- [ ] Tap "In Queue" on a saved prompt → item added to queue as queued
- [ ] Long-press saved prompt → "Bearbeiten" → edit inline → save
- [ ] Long-press saved prompt → "Loeschen" → prompt removed
- [ ] "+ Neuen Prompt speichern" → inline form → enter title + text → save
- [ ] Running items have no reorder/delete options in ActionSheet
- [ ] Done items only show "Prompt speichern" and "Loeschen"
