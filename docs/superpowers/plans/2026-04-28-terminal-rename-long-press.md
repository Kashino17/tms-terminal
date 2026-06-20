# Terminal-Rename via Long-Press im Manager-Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long-Press auf einen Pane-Header im Multi-Spotlight des Manager-Chats öffnet ein Bottom-Sheet zum Umbenennen des Terminals; Custom-Name ist persistent und überall sichtbar.

**Architecture:** Reuse der existierenden `TerminalTab.title`/`customTitle`-Felder + `useTerminalStore.updateTab(...)`-API. Neuer Long-Press-Prop in `MultiSpotlight` triggert ein neues Modal-Sheet, das im selben Pattern wie `messageMenu` in V2 lebt. Keine neuen Stores, keine neuen Persistenz-Pfade.

**Tech Stack:** React Native, TypeScript, Zustand-Store (terminalStore), expo-haptics, react-native `Modal`+`Pressable`+`TextInput`.

**Spec:** `docs/superpowers/specs/2026-04-28-terminal-rename-long-press-design.md`

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `mobile/src/components/manager/MultiSpotlight.tsx` | Modify | Add optional `onPaneLongPress` prop, hang it on the head-`Pressable` next to the existing `onPress` |
| `mobile/src/screens/ManagerChatScreenV2.tsx` | Modify | Add `Haptics` import, rename-sheet state, three handlers (`handlePaneLongPress`, `commitRename`, `resetToAutoName`, `closeRenameSheet`), pass `onPaneLongPress` to `<MultiSpotlight>`, render new `<Modal>` block, add `rs` StyleSheet |

No new files, no test files (RN-screens haben kein Unit-Test-Setup im Repo; manuelle Tests am Galaxy Fold 7 wie im Spec definiert).

---

## Task 1: MultiSpotlight — `onPaneLongPress`-Prop hinzufügen

**Files:**
- Modify: `mobile/src/components/manager/MultiSpotlight.tsx:39-62` (Props interface)
- Modify: `mobile/src/components/manager/MultiSpotlight.tsx:79-94` (component signature)
- Modify: `mobile/src/components/manager/MultiSpotlight.tsx:198` (head Pressable)

- [ ] **Step 1: Add the optional prop to the Props interface**

In `mobile/src/components/manager/MultiSpotlight.tsx`, locate the `onPaneDoubleTap` declaration (around line 51) and add the new prop right below it:

```ts
onPaneDoubleTap?: (index: number) => void;
/**
 * Fires when the user long-presses a pane header (~500 ms hold). Parent uses
 * this to open a per-pane settings sheet (e.g. rename). Empty pane slots
 * never fire this — the head only renders for occupied panes.
 */
onPaneLongPress?: (index: number) => void;
```

- [ ] **Step 2: Destructure the new prop in the component signature**

In the same file, find the `forwardRef` body (around line 79-94) and add `onPaneLongPress` to the destructured props list:

```tsx
export const MultiSpotlight = forwardRef<MultiSpotlightRef, Props>(function MultiSpotlight(
  {
    mode,
    panes,
    activePaneIndex,
    onActivePaneChange,
    onPromote,
    onSelectEmptyPane,
    wsService,
    labelFor,
    statusFor,
    onPaneDoubleTap,
    onPaneLongPress,
    focusedPaneIndex,
    activePaneKeyboardOffset = false,
  },
  ref,
) {
```

- [ ] **Step 3: Hang the long-press handler on the head Pressable**

Find line 198 (`<Pressable style={s.head} onPress={() => onActivePaneChange(i)}>`) and replace with:

```tsx
<Pressable
  style={s.head}
  onPress={() => onActivePaneChange(i)}
  onLongPress={() => onPaneLongPress?.(i)}
  delayLongPress={500}
>
```

`delayLongPress={500}` is the React Native default but we set it explicitly so the intent (and the contract with the parent) is visible at the call site — easier to tweak later if Android feels too slow/fast.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit code 0, no errors. The prop is optional so existing call sites keep working.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/manager/MultiSpotlight.tsx
git commit -m "$(cat <<'EOF'
feat(manager v2): add onPaneLongPress prop to MultiSpotlight

Optional callback fires when user long-presses a pane header (~500 ms).
Wired alongside existing onActivePaneChange/onPaneDoubleTap on the same
Pressable. Empty pane slots are unaffected — they have no head. Will be
consumed by ManagerChatScreenV2 for an inline rename sheet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: ManagerChatScreenV2 — Rename-Sheet State, Handlers, Modal, Styles

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreenV2.tsx` (multiple regions)

- [ ] **Step 1: Add `Haptics` import**

`Haptics` is not imported in V2 today (verified via grep). Find the existing imports block (line 1-65). Locate the existing `expo-av` / `expo-image-picker` imports near line 30-34 and add right above or below them:

```ts
import * as Haptics from 'expo-haptics';
```

- [ ] **Step 2: Add the rename-sheet state**

Find the existing state for `taskPanelOpen` and `messageMenu` (around lines 905-910). Add right below them:

```ts
// Rename-sheet state — set by long-press on a pane header in MultiSpotlight.
// `tabId` identifies the tab being renamed; `value` is the controlled
// TextInput state. `null` means the sheet is closed.
const [renameSheet, setRenameSheet] = useState<{ tabId: string } | null>(null);
const [renameValue, setRenameValue] = useState('');
```

- [ ] **Step 3: Add the four handlers — `handlePaneLongPress`, `commitRename`, `resetToAutoName`, `closeRenameSheet`**

Find `handlePaneDoubleTap` (around line 1184). Add the four new handlers right after `exitPaneFocus` (around line 1192-1196), before `handleOpenTools`:

```tsx
// ── Rename sheet (long-press a pane header to rename the terminal) ────────
const handlePaneLongPress = useCallback((idx: number) => {
  const sid = panes[idx];
  if (!sid) return;                                  // empty pane → no-op
  const tab = tabs.find((t) => t.sessionId === sid);
  if (!tab) return;                                  // session without tab record
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  setRenameValue(tab.title);
  setRenameSheet({ tabId: tab.id });
}, [panes, tabs]);

const commitRename = useCallback(() => {
  if (!renameSheet) return;
  const trimmed = renameValue.trim();
  if (trimmed.length > 0) {
    useTerminalStore.getState().updateTab(serverId, renameSheet.tabId, {
      title: trimmed,
      customTitle: true,
    });
  }
  setRenameSheet(null);
  setRenameValue('');
  refocusFocusedPane();
}, [renameSheet, renameValue, serverId, refocusFocusedPane]);

const resetToAutoName = useCallback(() => {
  if (!renameSheet) return;
  useTerminalStore.getState().updateTab(serverId, renameSheet.tabId, {
    customTitle: false,
  });
  setRenameSheet(null);
  setRenameValue('');
  refocusFocusedPane();
}, [renameSheet, serverId, refocusFocusedPane]);

const closeRenameSheet = useCallback(() => {
  setRenameSheet(null);
  setRenameValue('');
  refocusFocusedPane();
}, [refocusFocusedPane]);
```

`useTerminalStore.getState().updateTab(...)` matches the existing pattern in V2 (line 1601 already uses this form) — no need to add a hook subscription.

- [ ] **Step 4: Wire `onPaneLongPress` to `<MultiSpotlight>`**

Find the `<MultiSpotlight>` JSX in V2 (search for `onPaneDoubleTap={handlePaneDoubleTap}` — the prop is added next to the existing double-tap handler). Add the new prop:

```tsx
<MultiSpotlight
  {/* ... existing props ... */}
  onPaneDoubleTap={handlePaneDoubleTap}
  onPaneLongPress={handlePaneLongPress}
  {/* ... other props ... */}
/>
```

(If `<MultiSpotlight>` appears more than once in V2, add the prop to every occurrence.)

- [ ] **Step 5: Add the Rename-Sheet Modal in the JSX**

Find the existing `<Modal visible={!!messageMenu} ...>` block (around line 3014-3063). Add the new Modal right after it, before the `<Modal visible={taskPanelOpen} ...>`:

```tsx
{/* Rename-sheet — opens on long-press of a pane header. Themed bottom
    sheet with TextInput + Save/Cancel + (conditional) reset-to-auto. */}
<Modal
  visible={!!renameSheet}
  transparent
  animationType="fade"
  onRequestClose={closeRenameSheet}
  statusBarTranslucent
>
  <Pressable style={rs.backdrop} onPress={closeRenameSheet}>
    <Pressable
      style={[rs.sheet, { paddingBottom: insets.bottom + 8 }]}
      onPress={() => { /* swallow */ }}
    >
      <View style={rs.handle} />
      <Text style={rs.heading}>Terminal umbenennen</Text>
      {(() => {
        const tab = renameSheet ? tabs.find((t) => t.id === renameSheet.tabId) : null;
        const currentName = tab ? tab.title : '';
        const hasCustom = tab?.customTitle === true;
        return (
          <>
            <Text style={rs.preview} numberOfLines={1}>
              {`Aktuell: ${currentName}`}
            </Text>
            <TextInput
              style={rs.input}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Neuer Name"
              placeholderTextColor={colors.textDim}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={commitRename}
              maxLength={40}
            />
            <View style={rs.btnRow}>
              <Pressable
                style={({ pressed }) => [rs.btnSecondary, pressed && { opacity: 0.7 }]}
                onPress={closeRenameSheet}
              >
                <Text style={rs.btnSecondaryText}>Abbrechen</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [rs.btnPrimary, pressed && { opacity: 0.85 }]}
                onPress={commitRename}
              >
                <Text style={rs.btnPrimaryText}>Speichern</Text>
              </Pressable>
            </View>
            {hasCustom && (
              <Pressable
                style={({ pressed }) => [rs.resetBtn, pressed && { backgroundColor: 'rgba(255,255,255,0.04)' }]}
                onPress={resetToAutoName}
              >
                <Feather name="rotate-ccw" size={14} color={colors.textMuted} />
                <Text style={rs.resetText}>Auf Auto-Namen zurücksetzen</Text>
              </Pressable>
            )}
          </>
        );
      })()}
    </Pressable>
  </Pressable>
</Modal>
```

`TextInput` is already used elsewhere in V2 (the chat input bar), so the import is already present. `Feather` is imported. `colors` is imported. `insets` is in scope (`useSafeAreaInsets()` is already called).

- [ ] **Step 6: Add the `rs` StyleSheet**

Locate `const mm = StyleSheet.create({...})` at line 769 and the closing `});` of `mm` at line 839. Right after `mm`'s closing brace (before `const lbStyles = StyleSheet.create(...)` at line 841), add:

```ts
const rs = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1B2336',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 8,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: 12,
  },
  heading: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  preview: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  btnSecondary: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  btnSecondaryText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  btnPrimaryText: {
    color: '#0B1220',
    fontSize: 14,
    fontWeight: '700',
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  resetText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
});
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit code 0, no errors.

If you see "Cannot find name 'TextInput'" — add `TextInput` to the existing `react-native` named import block at line 2-22 in V2 (most likely already present, but worth checking).

- [ ] **Step 8: Manual smoke test (per spec testing checklist)**

The user will run this — list what they should verify:

1. Manager-Chat öffnen, einen Pane mit Terminal füllen (z. B. Shell 1).
2. Long-Press (~500 ms) auf den Header-Streifen (Punkt + Name + RUN-Badge) → Sheet öffnet, Eingabefeld hat aktuellen Titel als Vorbelegung und ist fokussiert.
3. Eingabe ändern auf „Build-Server", Speichern → Pane-Header und Chat-Tab-Chip zeigen sofort „Build-Server".
4. App-Restart → Name bleibt persistent.
5. Wechsel zum Terminal-Screen → Tab heißt dort auch „Build-Server".
6. Erneut Long-Press → „Auf Auto-Namen zurücksetzen" tippen → Pane zeigt wieder den CWD-Basename.
7. Long-Press auf eine leere Pane → kein Sheet (Handler returnt früh).
8. Long-Press, Sheet öffnet, „Abbrechen" → kein Update.
9. Long-Press, Sheet öffnet, leeren String, Speichern → kein Update.

- [ ] **Step 9: Commit**

```bash
git add mobile/src/screens/ManagerChatScreenV2.tsx
git commit -m "$(cat <<'EOF'
feat(manager v2): long-press pane header to rename terminal

Adds a bottom-sheet rename UX driven by the new MultiSpotlight
onPaneLongPress prop. State is local to ManagerChatScreenV2; persistence
reuses useTerminalStore.updateTab with title + customTitle:true so the
new name surfaces everywhere tabDisplayName is consumed (pane header,
chat tab chip, terminal screen tabs). Includes a "reset to auto-name"
escape hatch shown only when the tab already has customTitle === true.

Empty panes ignore the gesture. Save trims whitespace and ignores
empty input. Closing refocuses the focused pane's keyboard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage check** (against `2026-04-28-terminal-rename-long-press-design.md`):

- [x] Long-press trigger on pane header — Task 1 Step 3
- [x] Empty panes don't react — Task 2 Step 3 (`if (!sid) return`)
- [x] 500 ms hold — Task 1 Step 3 (`delayLongPress={500}`)
- [x] Bottom-sheet UI with handle, heading, preview, TextInput, Save/Cancel — Task 2 Step 5
- [x] Conditional reset-to-auto button — Task 2 Step 5 (`hasCustom && ...`)
- [x] Save: trim, ignore empty, `updateTab(... { title, customTitle: true })` — Task 2 Step 3 (`commitRename`)
- [x] Reset: `updateTab(... { customTitle: false })` (title not touched) — Task 2 Step 3 (`resetToAutoName`)
- [x] Refocus active pane after close — Task 2 Step 3 (`refocusFocusedPane()` in all close paths)
- [x] Persistence via existing terminalStore — implicit (uses existing `updateTab`)
- [x] Edge case: tab closed while sheet open — `commitRename` calls `updateTab` with stale ID; store ignores no-op without crash (matches spec edge-case table)
- [x] Manual testing checklist — Task 2 Step 8

**Placeholder scan:** No "TBD"/"TODO"/"add validation"/"handle edge cases". Every code step has full code.

**Type consistency:**
- `onPaneLongPress` typed `(index: number) => void` in both files ✓
- `renameSheet` shape `{ tabId: string }` consistent across handlers ✓
- `updateTab` signature matches existing usage at `ManagerChatScreenV2.tsx:1601` ✓
- StyleSheet name `rs` is unique (verified: existing names are `cdStyles, ws, tbStyles, tp, mm, lbStyles, s`) ✓

**Scope:** One feature, two files. Suitable for one inline execution session.
