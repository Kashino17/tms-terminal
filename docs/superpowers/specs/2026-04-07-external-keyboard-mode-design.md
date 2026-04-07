# External Keyboard Mode — Design Spec

**Date:** 2026-04-07
**Status:** Approved

## Overview

Add a toggle in SettingsScreen that suppresses the virtual (soft) keyboard in the terminal when the user has an external Bluetooth keyboard connected. The ServerListScreen gets a gear icon for quick access to settings.

## Scope

- Virtual keyboard suppression applies **only in the terminal** (WebView/xterm.js)
- Formulare (Server hinzufügen/bearbeiten etc.) keep normal soft keyboard behavior
- No Bluetooth scanning or hardware detection — manual toggle only

## Changes

### 1. Settings Store (`settingsStore.ts`)

New field:

```typescript
externalKeyboardMode: boolean  // default: false
```

Add to `SettingsState` interface, initial state, and actions (`setExternalKeyboardMode`).

### 2. SettingsScreen (`SettingsScreen.tsx`)

New toggle row after the "Audio Input" toggle:

- **Label:** "Externe Tastatur"
- **Description:** "Virtuelle Tastatur im Terminal deaktivieren"
- **Icon:** `keyboard-outline` (Ionicons)

### 3. ServerListScreen — Gear Icon (`ServerListScreen.tsx`)

Add a gear icon (`settings-outline`, Ionicons) in the header area of the ServerListScreen. Tapping navigates to `SettingsScreen`.

### 4. Terminal Keyboard Suppression

#### WebView (`terminalHtml.ts`)

When external keyboard mode is active:
- Set `shadow-input.inputmode = "none"` — prevents Android from showing the soft keyboard
- When mode is inactive: `shadow-input.inputmode = "text"` (default behavior)
- Add a `handleExternalKeyboardMode(enabled)` function callable via `postMessage`

#### TerminalView (`TerminalView.tsx`)

- Read `externalKeyboardMode` from `useSettingsStore`
- On mount and on setting change, send `postMessage` to WebView:
  ```json
  { "type": "setExternalKeyboardMode", "enabled": true/false }
  ```
- When active: skip keyboard offset animation (no need to shift terminal up for soft keyboard)

### 5. Data Flow

```
SettingsScreen Toggle
  → settingsStore.setExternalKeyboardMode(bool)
  → Zustand persists to AsyncStorage
  → TerminalView reads via useSettingsStore hook
  → postMessage to WebView
  → shadow-input.inputmode = "none" | "text"
```

## Files to Modify

| File | Change |
|------|--------|
| `mobile/src/store/settingsStore.ts` | Add `externalKeyboardMode` field + action |
| `mobile/src/screens/SettingsScreen.tsx` | Add toggle row |
| `mobile/src/screens/ServerListScreen.tsx` | Add gear icon in header |
| `mobile/src/components/terminalHtml.ts` | Handle `setExternalKeyboardMode` message, toggle `inputmode` |
| `mobile/src/components/TerminalView.tsx` | Send mode to WebView, skip keyboard offset when active |

## Out of Scope

- Bluetooth device scanning/pairing
- Automatic hardware keyboard detection
- Keyboard suppression in non-terminal screens (forms, dialogs)
