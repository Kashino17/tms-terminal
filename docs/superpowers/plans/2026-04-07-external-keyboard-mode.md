# External Keyboard Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings toggle that suppresses the virtual keyboard in the terminal when using an external Bluetooth keyboard.

**Architecture:** New `externalKeyboardMode` boolean in the Zustand settings store. The TerminalView reads this setting and sends a `postMessage` to the WebView, which sets `inputmode="none"` on the shadow input to suppress the soft keyboard. A gear icon on the ServerListScreen header navigates to Settings.

**Tech Stack:** React Native, Zustand, WebView postMessage bridge, xterm.js shadow input

---

### Task 1: Add `externalKeyboardMode` to Settings Store

**Files:**
- Modify: `mobile/src/store/settingsStore.ts`

- [ ] **Step 1: Add field to interface and store**

In `mobile/src/store/settingsStore.ts`, add the new field to `SettingsState` interface (after line 14) and the store implementation (after line 39):

```typescript
// Add to SettingsState interface (after audioInputEnabled lines):
  /** Whether virtual keyboard is suppressed in terminal (for external keyboards). Default: false. */
  externalKeyboardMode: boolean;
  setExternalKeyboardMode: (enabled: boolean) => void;
```

```typescript
// Add to store implementation (after setAudioInputEnabled block):
      externalKeyboardMode: false,
      setExternalKeyboardMode(enabled: boolean) {
        set({ externalKeyboardMode: enabled });
      },
```

- [ ] **Step 2: Verify store compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to settingsStore.ts

- [ ] **Step 3: Commit**

```bash
git add mobile/src/store/settingsStore.ts
git commit -m "feat: add externalKeyboardMode to settings store"
```

---

### Task 2: Add Toggle to SettingsScreen

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Import the new setting**

In `SettingsScreen.tsx`, update the destructuring from `useSettingsStore` (line 25) to also pull `externalKeyboardMode` and `setExternalKeyboardMode`:

```typescript
const { idleThresholdSeconds, setIdleThreshold, terminalTheme, setTerminalTheme, externalKeyboardMode, setExternalKeyboardMode } = useSettingsStore();
```

- [ ] **Step 2: Add toggle row in the Terminal section**

In the Terminal section (line 201–226), add a separator and new toggle row after the Theme picker `TouchableOpacity` closing tag (after line 224, before `</View>` on line 225):

```tsx
            <View style={[styles.separator, { marginHorizontal: rs(16) }]} />
            <TouchableOpacity
              style={[styles.row, { paddingHorizontal: rs(16), paddingVertical: rs(14) }]}
              onPress={() => setExternalKeyboardMode(!externalKeyboardMode)}
              activeOpacity={0.7}
              accessibilityRole="switch"
              accessibilityState={{ checked: externalKeyboardMode }}
            >
              <View style={styles.rowLeft}>
                <Feather name="hard-drive" size={ri(18)} color={colors.textMuted} style={{ marginRight: rs(12) }} />
                <View>
                  <Text style={[styles.label, { fontSize: rf(16) }]}>Externe Tastatur</Text>
                  <Text style={[styles.rowSub, { fontSize: rf(11) }]}>Virtuelle Tastatur im Terminal deaktivieren</Text>
                </View>
              </View>
              <Switch
                value={externalKeyboardMode}
                onValueChange={setExternalKeyboardMode}
                trackColor={{ false: colors.border, true: colors.primary + '88' }}
                thumbColor={externalKeyboardMode ? colors.primary : colors.textDim}
              />
            </TouchableOpacity>
```

Note: Uses `Feather` icon `"hard-drive"` (closest to keyboard in the Feather set already imported). The pattern matches the existing App Lock toggle exactly.

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/SettingsScreen.tsx
git commit -m "feat: add external keyboard toggle to SettingsScreen"
```

---

### Task 3: Add Gear Icon to ServerListScreen

**Files:**
- Modify: `mobile/src/screens/ServerListScreen.tsx`

- [ ] **Step 1: Add gear icon button in the header area**

In `ServerListScreen.tsx`, add a gear icon positioned as an absolute element in the top-right corner. Insert it inside the main `<View style={styles.container}>` after `<UpdateBanner />` (after line 117):

```tsx
      <TouchableOpacity
        style={[styles.settingsBtn, { top: rs(12), right: rs(16) }]}
        onPress={() => navigation.navigate('Settings')}
        activeOpacity={0.7}
        accessibilityLabel="Einstellungen"
        accessibilityRole="button"
      >
        <Feather name="settings" size={ri(22)} color={colors.textMuted} />
      </TouchableOpacity>
```

- [ ] **Step 2: Add the style**

Add to the `styles` StyleSheet (after the `fab` style block, before the closing `});` on line 189):

```typescript
  settingsBtn: {
    position: 'absolute',
    zIndex: 10,
    padding: 8,
  },
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/ServerListScreen.tsx
git commit -m "feat: add gear icon to ServerListScreen for settings navigation"
```

---

### Task 4: Handle `setExternalKeyboardMode` Message in WebView

**Files:**
- Modify: `mobile/src/components/terminalHtml.ts`

- [ ] **Step 1: Add message handler in the WebView JavaScript**

In `terminalHtml.ts`, add a new `else if` branch in the `handleMsg` function. Insert it after the `inject_text` handler (after line 752, before `} catch(e) {}`):

```javascript
      else if (msg.type === 'setExternalKeyboardMode') {
        shadowInput.setAttribute('inputmode', msg.enabled ? 'none' : 'text');
        if (msg.enabled) {
          // Dismiss soft keyboard immediately when mode is enabled
          shadowInput.blur();
          setTimeout(function() { shadowInput.focus({ preventScroll: true }); }, 50);
        }
      }
```

The `blur()` → `focus()` sequence dismisses the current soft keyboard. The `inputmode="none"` attribute prevents it from re-appearing on future focus events. The short delay ensures Android processes the blur before re-focusing.

- [ ] **Step 2: Verify the HTML template is syntactically valid**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && node -e "require('./src/components/terminalHtml'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add mobile/src/components/terminalHtml.ts
git commit -m "feat: handle setExternalKeyboardMode message in terminal WebView"
```

---

### Task 5: Send External Keyboard Mode from TerminalView to WebView

**Files:**
- Modify: `mobile/src/components/TerminalView.tsx`

- [ ] **Step 1: Read the setting from the store**

In `TerminalView.tsx`, add a new store selector after the existing `terminalTheme` selector (after line 93):

```typescript
  const externalKeyboardMode = useSettingsStore((state) => state.externalKeyboardMode);
```

- [ ] **Step 2: Send mode to WebView on mount and when setting changes**

Add a new `useEffect` after the existing theme effect (after line 203). This sends the current mode to the WebView whenever it changes, and also on initial ready:

```typescript
  // Sync external keyboard mode into WebView
  useEffect(() => {
    if (!readyReceivedRef.current) return;
    const msg = JSON.stringify({ type: 'setExternalKeyboardMode', enabled: externalKeyboardMode });
    webViewRef.current?.injectJavaScript(
      `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
    );
  }, [externalKeyboardMode]);
```

- [ ] **Step 3: Also send mode on WebView ready**

In the `onMessage` callback, inside the `msg.type === 'ready'` block (around line 286–299), add the external keyboard mode sync after the theme application. Insert after the theme `injectJavaScript` call (after line 291):

```typescript
        // Apply external keyboard mode
        const ekMode = useSettingsStore.getState().externalKeyboardMode;
        if (ekMode) {
          webViewRef.current?.injectJavaScript(
            `window.postMessage(${JSON.stringify(JSON.stringify({ type: 'setExternalKeyboardMode', enabled: true }))}, '*'); true;`,
          );
        }
```

- [ ] **Step 4: Skip keyboard offset animation when external keyboard mode is active**

In the keyboard tracking `useEffect` (line 157–194), modify the Android `keyboardDidShow` handler to skip the focus message when external keyboard mode is active. The soft keyboard shouldn't appear in this mode, but as a safety measure:

Replace the Android section (lines 179–193) with:

```typescript
    // Android: adjustResize handles layout, but xterm.js needs an explicit
    // scroll-to-bottom after the resize so the cursor stays visible.
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      // Skip focus when external keyboard mode is active — soft keyboard shouldn't appear
      if (useSettingsStore.getState().externalKeyboardMode) return;
      // Short delay: let the WebView resize + xterm.js reflow finish first
      setTimeout(() => {
        if (webViewRef.current) {
          const msg = JSON.stringify({ type: 'focus' });
          webViewRef.current.injectJavaScript(
            `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
          );
        }
      }, 150);
    });
    return () => { showSub.remove(); };
```

- [ ] **Step 5: Verify it compiles**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add mobile/src/components/TerminalView.tsx
git commit -m "feat: sync external keyboard mode to terminal WebView"
```

---

### Task 6: Manual End-to-End Test

**Files:** None (testing only)

- [ ] **Step 1: Start the dev build**

Run: `cd /Users/ayysir/Desktop/TMS\ Terminal/mobile && npx expo start`

- [ ] **Step 2: Verify gear icon on ServerListScreen**

On the server list screen, confirm:
- Gear icon visible in top-right corner
- Tapping it navigates to SettingsScreen

- [ ] **Step 3: Verify toggle in SettingsScreen**

In SettingsScreen, under "Terminal" section, confirm:
- "Externe Tastatur" toggle visible below the Theme picker
- Toggle switches on/off and persists after app restart

- [ ] **Step 4: Verify keyboard suppression in terminal**

1. Open a terminal connection
2. Tap on the terminal → soft keyboard should appear (toggle OFF)
3. Go to Settings → enable "Externe Tastatur"
4. Go back to terminal → tap on terminal → soft keyboard should NOT appear
5. Type on physical/Bluetooth keyboard → characters should appear in terminal
6. Disable toggle → soft keyboard reappears on tap

- [ ] **Step 5: Commit any fixes if needed**
