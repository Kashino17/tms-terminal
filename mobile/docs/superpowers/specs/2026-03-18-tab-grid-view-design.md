# Tab Grid View — Design Spec

**Date:** 2026-03-18
**Status:** Approved

---

## Overview

A Safari-style fullscreen tab overview for TMS Terminal. The user can switch from the normal single-terminal view to a 2-column grid showing all open terminals simultaneously with live text previews, then tap any card to return to that terminal.

---

## Key Types

`TerminalTab` (existing, in `terminal.types.ts`):
- `id` — stable local tab ID, unique within a single `TerminalScreen` instance (per `serverId`)
- `sessionId` — WebSocket session ID from server (`terminal:created`); may be `undefined` before session established
- `title` — display name
- `active` — whether this is the currently shown tab

---

## Entry Point

- A `layout` Feather icon is added to `TerminalTabs.tsx`, placed in the non-scrollable right section between the scrollable tab list and the «+» button.
- Always visible regardless of tab count.
- Tapping calls `onOpenGrid?: () => void` prop.

---

## Grid View (TabGridView)

A fullscreen React Native `Modal` with `transparent={false}`, `animationType="none"`, and `statusBarTranslucent={true}` (Android). The slide animation is applied to an `Animated.View` that fills the entire Modal — not to the Modal itself:

```tsx
<Modal visible={gridVisible} transparent={false} animationType="none" statusBarTranslucent>
  <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateY }] }]}>
    {/* header, body, bottom bar */}
  </Animated.View>
</Modal>
```

### Header Bar (height: 50px)
- Left: «Abbrechen» text button
- Center: «N Terminals» bold title (N = `tabs.length`)
- Right: «Fertig» pill button
- Both buttons close the grid without changing the active tab. They are functionally identical; «Fertig» is the primary action.

### Scrollable Grid Body
- `FlatList` with `numColumns={2}`, padding 10px, gap 7px
- One `TabGridCard` per tab — no placeholder card in the grid body

### Bottom Action Bar (height: 48px, not scrollable)
- «+ Neuer Tab» pill button — calls `onAddTab()` then triggers close animation

---

## TabGridCard (`React.memo`)

**Props:**
```ts
interface TabGridCardProps {
  tab: TerminalTab;
  outputBuffer: string;   // pre-sliced for this card only
  isActive: boolean;
  lastActivityMs: number; // timestamp of last output, or 0
  onSelect: () => void;
  onClose: () => void;
}
```

`TabGridView` resolves buffer and activity per card before rendering:
```ts
outputBuffer = outputBuffers[tab.id] ?? ''
lastActivityMs = lastActivity[tab.id] ?? 0
```

### Dot color (5px circle in header)
- **Blue**: `isActive === true`
- **Green**: `Date.now() - lastActivityMs < 3000` (and not active)
- **Grey**: otherwise

**Green → Grey transition** is driven by a local state ticker inside `TabGridCard`:
```ts
const [tick, setTick] = useState(0);

useEffect(() => {
  if (isActive || lastActivityMs === 0) return;
  const remaining = 3000 - (Date.now() - lastActivityMs);
  if (remaining <= 0) return;
  const timer = setTimeout(() => setTick(t => t + 1), remaining);
  return () => clearTimeout(timer); // cleanup on unmount or prop change
}, [lastActivityMs, isActive]);
```
`tick` is not used in the render output — its only purpose is to trigger a re-render after the activity window expires.

### Card Header (height: 22px)
- Colored dot + tab title (monospace, truncated) + ✕ button (`hitSlop` padded)
- ✕ calls `onClose()`

### Card Body (height: 80px)
- Plain `<Text>` (not selectable), monospace 7.5px / 11.5px line-height ≈ 6–7 visible lines
- `outputBuffer` is split by `\n` and each line is rendered as a separate `<Text>` span:
  - Red: line contains `error`, `Error`, `ERROR`, `✗`, `failed`, `FAILED`
  - Amber: line contains `warn`, `Warn`, `WARN`
  - Dim green: all other lines
- Newest output is at the bottom

### Active tab indicator
- `1.5px` blue border on entire card + faint blue shadow

### Tap behavior
- Tap anywhere on card (excluding ✕) → `onSelect()`

---

## Live Output Buffer

### Constants
```ts
const OUTPUT_BUFFER_MAX_CHARS = 600;
```

### State in TerminalScreen
```ts
const [outputBuffers, setOutputBuffers] = useState<Record<string, string>>({});
const [lastActivity,  setLastActivity]  = useState<Record<string, number>>({});
```

Both keyed by **`tab.id`** (always defined, unique within this `TerminalScreen` instance).

### Update logic (added to existing `terminal:output` handler)
```ts
// `tabs` is available in TerminalScreen closure via getTabs(serverId)
const tab = tabs.find(t => t.sessionId === sessionId);
if (!tab) return;

setOutputBuffers(prev => {
  const raw = (prev[tab.id] ?? '') + data;
  if (raw.length <= OUTPUT_BUFFER_MAX_CHARS) {
    return { ...prev, [tab.id]: raw };
  }
  // Trim from front, keep last OUTPUT_BUFFER_MAX_CHARS chars
  const trimmed = raw.slice(raw.length - OUTPUT_BUFFER_MAX_CHARS);
  // Advance to first '\n' so the buffer starts at a clean line boundary
  const nl = trimmed.indexOf('\n');
  return { ...prev, [tab.id]: nl >= 0 ? trimmed.slice(nl + 1) : trimmed };
  // If no '\n' found (single very long line), hard-truncate — acceptable
});

setLastActivity(prev => ({ ...prev, [tab.id]: Date.now() }));
```

---

## Known Bug Fix (during implementation)

`terminalStore.ts` `removeTab` directly mutates a Zustand draft object:
```ts
filtered[filtered.length - 1].active = true; // ← mutation, not a new object
```
Fix during implementation: replace with a `.map()`:
```ts
const withActive = filtered.map((t, i) =>
  i === filtered.length - 1 ? { ...t, active: true } : t
);
set({ tabs: { ...get().tabs, [serverId]: withActive } });
```
This is required for the «close active tab from grid» flow to trigger reliable re-renders.

---

## Animation

`translateY` is an `Animated.Value` in `TerminalScreen`, passed to `TabGridView`.

### Opening
```ts
setGridVisible(true);
translateY.setValue(screenHeight);
Animated.spring(translateY, {
  toValue: 0,
  useNativeDriver: true,
  tension: 80,
  friction: 12,
}).start();
```

### Closing
```ts
Animated.timing(translateY, {
  toValue: screenHeight,
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
```

`pendingTabIdRef = useRef<string | null>(null)` in `TerminalScreen` — avoids triggering a re-render when written.

---

## State & Event Flow

| Action | Effect |
|--------|--------|
| Tap ⊞ icon | `setGridVisible(true)` + open animation |
| Tap «Fertig» / «Abbrechen» | Close animation → `setGridVisible(false)`, no tab change |
| Tap card body | `pendingTabIdRef.current = tab.id` → close animation → `setActiveTab` |
| Tap ✕ (non-active tab) | `handleCloseTab(tab.id)`; grid stays open, card disappears |
| Tap ✕ (active tab, others exist) | `handleCloseTab(tab.id)`; terminalStore activates next tab (fixed mutation bug); grid stays open, blue border moves |
| Tap ✕ (last tab) | `handleCloseTab(tab.id)`; existing logic creates new empty tab; grid stays open with new card |
| Tap «+ Neuer Tab» | `handleAddTab()` → close animation → `setGridVisible(false)` |

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `src/components/TabGridView.tsx` | New — fullscreen modal, FlatList, animation |
| `src/components/TabGridCard.tsx` | New — `React.memo`, dot timeout, line coloring |
| `src/components/TerminalTabs.tsx` | Add `onOpenGrid?: () => void` prop + `layout` icon |
| `src/screens/TerminalScreen.tsx` | Add `outputBuffers`, `lastActivity`, `pendingTabIdRef`, `gridVisible`; update `terminal:output` handler; render `TabGridView` |
| `src/store/terminalStore.ts` | Fix `removeTab` mutation bug |

---

## Out of Scope

- Drag-to-reorder cards
- Search/filter within grid
- Animated card removal (fade/scale out on close)
- ANSI escape code preservation (plain text with keyword-based color only)
- WebView thumbnail screenshots
