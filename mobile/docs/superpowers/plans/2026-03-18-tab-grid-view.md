# Tab Grid View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Safari-style fullscreen tab grid overview to TMS Terminal, accessible via a ⊞ icon in the tab bar, showing live terminal output previews for all open tabs.

**Architecture:** A fullscreen `Modal` (`TabGridView`) slides up over the entire screen when the grid icon is tapped. It receives pre-computed output buffers (keyed by `tab.id`) and `lastActivity` timestamps from `TerminalScreen`, renders a 2-column `FlatList` of `TabGridCard` components, and dispatches tab-switch or tab-close events back up.

**Tech Stack:** React Native (Expo SDK 50), Animated API (spring + timing), Feather icons, Zustand (existing terminalStore), TypeScript

---

## File Map

| File | Role |
|------|------|
| `src/store/terminalStore.ts` | Fix `removeTab` mutation bug (existing) |
| `src/components/TerminalTabs.tsx` | Add `onOpenGrid` prop + `layout` icon button |
| `src/components/TabGridCard.tsx` | **New** — single card: header dot, title, ✕, body text |
| `src/components/TabGridView.tsx` | **New** — fullscreen modal, FlatList, slide animation |
| `src/screens/TerminalScreen.tsx` | Add `outputBuffers`, `lastActivity`, `gridVisible` state; update `terminal:output` handler; render `TabGridView` |

---

## Task 1: Fix `removeTab` Mutation Bug in terminalStore

**Files:**
- Modify: `src/store/terminalStore.ts:37-44`

This bug causes the tab list not to re-render reliably when the active tab is closed. It must be fixed before building the grid close-tab feature.

- [ ] **Step 1: Open `src/store/terminalStore.ts` and find `removeTab`**

The buggy code (lines ~37–44):
```ts
removeTab(serverId, tabId) {
  const current = get().tabs[serverId] || [];
  const filtered = current.filter((t) => t.id !== tabId);
  if (filtered.length > 0 && !filtered.some((t) => t.active)) {
    filtered[filtered.length - 1].active = true;  // ← direct mutation
  }
  set({ tabs: { ...get().tabs, [serverId]: filtered } });
},
```

- [ ] **Step 2: Replace with immutable version**

```ts
removeTab(serverId, tabId) {
  const current = get().tabs[serverId] || [];
  let filtered = current.filter((t) => t.id !== tabId);
  if (filtered.length > 0 && !filtered.some((t) => t.active)) {
    filtered = filtered.map((t, i) =>
      i === filtered.length - 1 ? { ...t, active: true } : t,
    );
  }
  set({ tabs: { ...get().tabs, [serverId]: filtered } });
},
```

- [ ] **Step 3: Verify app still builds and tab close works**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx expo run:android --device TMS_Phone 2>&1 | tail -5
```
Open multiple tabs in the app, close the active one — confirm the next tab becomes active.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
git add src/store/terminalStore.ts
git commit -m "fix: immutable removeTab in terminalStore to prevent stale re-renders"
```

---

## Task 2: Add Grid Icon to TerminalTabs

**Files:**
- Modify: `src/components/TerminalTabs.tsx`

- [ ] **Step 1: Add `onOpenGrid` to the Props interface**

In `TerminalTabs.tsx`, find:
```ts
interface Props {
  tabs: TerminalTab[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, newName: string) => void;
}
```
Replace with:
```ts
interface Props {
  tabs: TerminalTab[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, newName: string) => void;
  onOpenGrid?: () => void;
}
```

- [ ] **Step 2: Destructure `onOpenGrid` in the function signature**

Find:
```ts
export function TerminalTabs({ tabs, onSelect, onClose, onAdd, onRename }: Props) {
```
Replace with:
```ts
export function TerminalTabs({ tabs, onSelect, onClose, onAdd, onRename, onOpenGrid }: Props) {
```

- [ ] **Step 3: Ensure `Haptics` is imported in `TerminalTabs.tsx`**

Check the top of the file — `expo-haptics` is already imported:
```ts
import * as Haptics from 'expo-haptics';
```
If it is not present, add it after the `@expo/vector-icons` import.

- [ ] **Step 4: Add the grid icon button before the `+` button**

In the JSX, find the `addButton` TouchableOpacity:
```tsx
<TouchableOpacity style={styles.addButton} onPress={onAdd} accessibilityLabel="New tab" accessibilityRole="button">
  <Feather name="plus" size={18} color={colors.primary} />
</TouchableOpacity>
```
Add the grid button immediately before it:
```tsx
{onOpenGrid && (
  <TouchableOpacity
    style={styles.gridButton}
    onPress={() => { Haptics.selectionAsync(); onOpenGrid(); }}
    accessibilityLabel="Tab overview"
    accessibilityRole="button"
  >
    <Feather name="layout" size={16} color={colors.textDim} />
  </TouchableOpacity>
)}
<TouchableOpacity style={styles.addButton} onPress={onAdd} accessibilityLabel="New tab" accessibilityRole="button">
  <Feather name="plus" size={18} color={colors.primary} />
</TouchableOpacity>
```

- [ ] **Step 5: Add `gridButton` style in the StyleSheet**

In the `StyleSheet.create({...})` block, add after `addButton`:
```ts
gridButton: {
  paddingHorizontal: 10,
  paddingVertical: 8,
  borderRadius: 6,
  backgroundColor: 'transparent',
  alignItems: 'center',
  justifyContent: 'center',
},
```

- [ ] **Step 6: Verify it builds (TypeScript check)**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors related to TerminalTabs.

- [ ] **Step 7: Commit**

```bash
git add src/components/TerminalTabs.tsx
git commit -m "feat: add onOpenGrid prop and layout icon to TerminalTabs"
```

---

## Task 3: Create TabGridCard Component

**Files:**
- Create: `src/components/TabGridCard.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState, useEffect, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { TerminalTab } from '../types/terminal.types';
import { colors, fonts } from '../theme';

export interface TabGridCardProps {
  tab: TerminalTab;
  outputBuffer: string;
  isActive: boolean;
  lastActivityMs: number;
  onSelect: () => void;
  onClose: () => void;
}

const ACTIVITY_WINDOW_MS = 3000;

function dotColor(isActive: boolean, lastActivityMs: number): string {
  if (isActive) return colors.primary;
  if (lastActivityMs > 0 && Date.now() - lastActivityMs < ACTIVITY_WINDOW_MS) return colors.accent;
  return colors.border;
}

function lineColor(line: string): string {
  if (/error|Error|ERROR|✗|failed|FAILED/.test(line)) return colors.destructive;
  if (/warn|Warn|WARN/.test(line)) return colors.warning;
  return '#4ade80'; // terminal green
}

export const TabGridCard = memo(function TabGridCard({
  tab,
  outputBuffer,
  isActive,
  lastActivityMs,
  onSelect,
  onClose,
}: TabGridCardProps) {
  // Local tick to force re-render when the 3-second activity window expires
  const [, setTick] = useState(0);

  useEffect(() => {
    if (isActive || lastActivityMs === 0) return;
    const remaining = ACTIVITY_WINDOW_MS - (Date.now() - lastActivityMs);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(timer);
  }, [lastActivityMs, isActive]);

  const dot = dotColor(isActive, lastActivityMs);
  const lines = outputBuffer.split('\n').filter(Boolean);

  return (
    <TouchableOpacity
      style={[styles.card, isActive && styles.cardActive]}
      onPress={onSelect}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${tab.title}`}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={styles.title} numberOfLines={1}>{tab.title}</Text>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={`Close ${tab.title}`}
          accessibilityRole="button"
        >
          <Feather name="x" size={11} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Body — last lines of terminal output */}
      <View style={styles.body}>
        {lines.length === 0 ? (
          <Text style={[styles.line, { color: colors.textDim }]}>—</Text>
        ) : (
          lines.map((line, i) => (
            <Text key={i} style={[styles.line, { color: lineColor(line) }]} numberOfLines={1}>
              {line}
            </Text>
          ))
        )}
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  cardActive: {
    borderColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  header: {
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 4,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 7.5,
    color: colors.textMuted,
    fontFamily: fonts.mono,
  },
  body: {
    height: 80,
    padding: 5,
    backgroundColor: '#060709',
    overflow: 'hidden',
  },
  line: {
    fontSize: 7.5,
    lineHeight: 11.5,
    fontFamily: fonts.mono,
  },
});
```

- [ ] **Step 2: TypeScript check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit 2>&1 | grep TabGridCard
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/TabGridCard.tsx
git commit -m "feat: add TabGridCard component with live output preview and activity dot"
```

---

## Task 4: Create TabGridView Component

**Files:**
- Create: `src/components/TabGridView.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, Modal, Animated, Platform, Dimensions,
} from 'react-native';
import { TabGridCard } from './TabGridCard';
import { TerminalTab } from '../types/terminal.types';
import { colors, fonts } from '../theme';

const SCREEN_HEIGHT = Dimensions.get('screen').height;
const COLUMN_GAP = 7;
const PADDING = 10;

export interface TabGridViewProps {
  visible: boolean;
  tabs: TerminalTab[];
  outputBuffers: Record<string, string>;
  lastActivity: Record<string, number>;
  translateY: Animated.Value;
  serverId: string;
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
}

export function TabGridView({
  visible,
  tabs,
  outputBuffers,
  lastActivity,
  translateY,
  onClose,
  onSelectTab,
  onCloseTab,
  onAddTab,
}: TabGridViewProps) {

  const renderItem = useCallback(({ item }: { item: TerminalTab }) => {
    return (
      <TabGridCard
        tab={item}
        outputBuffer={outputBuffers[item.id] ?? ''}
        isActive={item.active}
        lastActivityMs={lastActivity[item.id] ?? 0}
        onSelect={() => onSelectTab(item.id)}
        onClose={() => onCloseTab(item.id)}
      />
    );
  }, [outputBuffers, lastActivity, onSelectTab, onCloseTab]);

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="none"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={onClose}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateY }], backgroundColor: '#08090c' }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Text style={styles.cancelText}>Abbrechen</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{tabs.length} Terminals</Text>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <View style={styles.doneBtn}>
              <Text style={styles.doneText}>Fertig</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Grid */}
        <FlatList
          data={tabs}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={2}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          columnWrapperStyle={styles.columnWrapper}
          showsVerticalScrollIndicator={false}
        />

        {/* Bottom bar */}
        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.newTabBarBtn} onPress={onAddTab}>
            <Text style={styles.newTabBarText}>+ Neuer Tab</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // ── Header
  header: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: '#08090c',
  },
  headerBtn: {
    minWidth: 80,
  },
  cancelText: {
    fontSize: 13,
    color: colors.primary,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    fontFamily: fonts.mono,
  },
  doneBtn: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(59,130,246,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.25)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  doneText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
  },
  // ── Grid
  list: {
    flex: 1,
  },
  listContent: {
    padding: PADDING,
    paddingBottom: 0,
  },
  columnWrapper: {
    gap: COLUMN_GAP,
    marginBottom: COLUMN_GAP,
  },
  // ── Bottom bar
  bottomBar: {
    height: 48,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#08090c',
  },
  newTabBarBtn: {
    backgroundColor: 'rgba(59,130,246,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.2)',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  newTabBarText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  },
});
```

- [ ] **Step 2: TypeScript check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit 2>&1 | grep -E "TabGrid|error"
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/TabGridView.tsx
git commit -m "feat: add TabGridView fullscreen modal grid component"
```

---

## Task 5: Wire Everything Into TerminalScreen

**Files:**
- Modify: `src/screens/TerminalScreen.tsx`

This is the largest change. It adds the output buffer state, updates the WS handler, adds animation logic, and renders `TabGridView`.

- [ ] **Step 1: Add imports at the top of `TerminalScreen.tsx`**

Find the existing imports block. Add these two lines after the existing component imports:
```ts
import { TabGridView } from '../components/TabGridView';
import { Easing, Dimensions } from 'react-native';
```

Note: `Animated` is already imported. Add `Easing` and `Dimensions` to the existing `react-native` import line if not present.

- [ ] **Step 2: Add the output buffer constant near the top of the file (after imports, before component)**

After the `CLIENT_PROMPT_PATTERNS` array, add:
```ts
const OUTPUT_BUFFER_MAX_CHARS = 600;
const SCREEN_HEIGHT = Dimensions.get('screen').height;
```

- [ ] **Step 3: Add new state variables inside `TerminalScreen` function**

After the existing state declarations (near line 77-80), add:
```ts
const [outputBuffers, setOutputBuffers] = useState<Record<string, string>>({});
const [lastActivity,  setLastActivity]  = useState<Record<string, number>>({});
const [gridVisible,   setGridVisible]   = useState(false);
const pendingTabIdRef = useRef<string | null>(null);
const gridTranslateY  = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
```

- [ ] **Step 4: Update the `terminal:output` handler to feed the buffer**

Find the `terminal:output` handler inside the `ws.addMessageListener` callback:
```ts
} else if (m.type === 'terminal:output' && m.sessionId && m.payload?.data) {
  // Client-side prompt detection — catches prompts regardless of server silence timer
  const autoApprove = useAutoApproveStore.getState();
  ...
}
```

After the existing auto-approve logic inside that block, add the buffer update:
```ts
// Output buffer for tab grid live preview
const outputTab = useTerminalStore.getState().getTabs(serverId).find(
  (t) => t.sessionId === m.sessionId,
);
if (outputTab) {
  const sessionData = m.payload.data as string;
  setOutputBuffers((prev) => {
    const raw = (prev[outputTab.id] ?? '') + sessionData;
    if (raw.length <= OUTPUT_BUFFER_MAX_CHARS) {
      return { ...prev, [outputTab.id]: raw };
    }
    const trimmed = raw.slice(raw.length - OUTPUT_BUFFER_MAX_CHARS);
    const nl = trimmed.indexOf('\n');
    return { ...prev, [outputTab.id]: nl >= 0 ? trimmed.slice(nl + 1) : trimmed };
  });
  setLastActivity((prev) => ({ ...prev, [outputTab.id]: Date.now() }));
}
```

- [ ] **Step 5: Add grid open/close animation helpers**

After the `handleRenameTab` callback (around line 343), add:
```ts
const openGrid = useCallback(() => {
  setGridVisible(true);
  gridTranslateY.setValue(SCREEN_HEIGHT);
  Animated.spring(gridTranslateY, {
    toValue: 0,
    useNativeDriver: true,
    tension: 80,
    friction: 12,
  }).start();
}, [gridTranslateY]);

const closeGrid = useCallback(() => {
  Animated.timing(gridTranslateY, {
    toValue: SCREEN_HEIGHT,
    duration: 200,
    useNativeDriver: true,
    easing: Easing.in(Easing.ease),
  }).start(() => {
    setGridVisible(false);
    if (pendingTabIdRef.current) {
      setActiveTab(serverId, pendingTabIdRef.current);
      pendingTabIdRef.current = null;
    }
  });
}, [gridTranslateY, serverId, setActiveTab]);

const handleGridSelectTab = useCallback((tabId: string) => {
  pendingTabIdRef.current = tabId;
  closeGrid();
}, [closeGrid]);

const handleGridAddTab = useCallback(() => {
  createNewTab();
  closeGrid();
}, [createNewTab, closeGrid]);
```

- [ ] **Step 6: Pass `onOpenGrid` to `TerminalTabs`**

Find:
```tsx
<TerminalTabs
  tabs={serverTabs}
  onSelect={(id) => setActiveTab(serverId, id)}
  onClose={handleCloseTab}
  onAdd={createNewTab}
  onRename={handleRenameTab}
/>
```
Replace with:
```tsx
<TerminalTabs
  tabs={serverTabs}
  onSelect={(id) => setActiveTab(serverId, id)}
  onClose={handleCloseTab}
  onAdd={createNewTab}
  onRename={handleRenameTab}
  onOpenGrid={openGrid}
/>
```

- [ ] **Step 7: Render `TabGridView` inside the return statement**

At the end of the `<SafeAreaView>` return block, just before the closing `</SafeAreaView>`, add:
```tsx
<TabGridView
  visible={gridVisible}
  tabs={serverTabs}
  outputBuffers={outputBuffers}
  lastActivity={lastActivity}
  translateY={gridTranslateY}
  serverId={serverId}
  onClose={closeGrid}
  onSelectTab={handleGridSelectTab}
  onCloseTab={handleCloseTab}
  onAddTab={handleGridAddTab}
/>
```

- [ ] **Step 8: TypeScript check**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/screens/TerminalScreen.tsx
git commit -m "feat: wire TabGridView into TerminalScreen with live output buffers and slide animation"
```

---

## Task 6: Build, Install & Manually Verify

- [ ] **Step 1: Build and install on emulator**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
npx expo run:android --device TMS_Phone 2>&1 | tail -5
```
Expected: `BUILD SUCCESSFUL` + app opens on device.

- [ ] **Step 2: Verify — open grid view**

1. Connect to a server
2. Open 2–3 tabs, run commands in each (e.g. `ls`, `pwd`, `echo hello`)
3. Tap the ⊞ (layout) icon in the tab bar
4. **Expected:** Fullscreen grid slides up, toolbar and tab bar are gone, cards show live output text

- [ ] **Step 3: Verify — switch tab from grid**

1. In grid view, tap a non-active card
2. **Expected:** Grid slides down, the tapped terminal is now the active tab

- [ ] **Step 4: Verify — close tab from grid**

1. In grid view, tap ✕ on a card
2. **Expected:** Card disappears from grid, grid stays open, remaining cards fill the 2-column layout

- [ ] **Step 5: Verify — live updates**

1. In grid view, run a command on a non-visible terminal from another device or keep grid open
2. Actually: open grid, leave it open, go back (Fertig), run a command, re-open grid
3. **Expected:** Card shows the new output lines

- [ ] **Step 6: Verify — new tab from grid**

1. In grid view, tap «+ Neuer Tab» (bottom bar or placeholder card)
2. **Expected:** Grid closes, new terminal tab is created and active

- [ ] **Step 7: Verify — activity dot**

1. Run a command in any non-active tab
2. Open grid within 3 seconds
3. **Expected:** That card's dot is green; after 3+ seconds it turns grey

- [ ] **Step 8: Final commit**

```bash
cd "/Users/ayysir/Desktop/TMS Terminal/mobile"
git add -A
git commit -m "feat: Tab Grid View — Safari-style fullscreen terminal overview complete"
```
