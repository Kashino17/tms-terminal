# Terminal-Rename via Long-Press im Manager-Chat — Design

**Date:** 2026-04-28
**Status:** Approved
**Scope:** Single feature, single screen (V2 Manager Chat)

---

## Goal

Long-Press auf eine Pane im Multi-Spotlight des Manager-Chats öffnet ein
Bottom-Sheet, in dem der User dem Terminal einen individuellen Namen geben kann.
Der Name wirkt sofort und persistent in der ganzen App (Pane-Header,
Chat-Tab-Chip, Terminal-Screen-Tabs).

## Non-Goals

- Andere Aktionen im selben Sheet (Schließen, Farbe, Notifications, Pane lösen)
- Eine separate Übersicht aller Terminals zum Bulk-Renamen
- Override des internen "Shell N"-Slugs, den die AI sieht (siehe
  `memory/project-state.md` → Shell-Naming; eigenes Feature)
- Long-Press auf den Pane-Body (WebView) — Gesten-Konflikt mit xterm.js,
  bewusst ausgelassen

## Background

`TerminalTab` (`mobile/src/types/terminal.types.ts:5-25`) hat bereits zwei
relevante Felder:

- `title: string` — der editierbare Anzeigename
- `customTitle?: boolean` — Flag, das auto-naming aus dem CWD deaktiviert

Die Display-Funktion `tabDisplayName` (`mobile/src/utils/tabDisplayName.ts`)
priorisiert bereits den Custom-Titel, wenn `customTitle === true` ist:

```ts
export function tabDisplayName(tab: TerminalTab): string {
  if (tab.customTitle) return tab.title;
  if (tab.lastCwd) { /* derive last cwd component */ }
  return tab.title;
}
```

`TerminalScreen.handleRenameTab` (`mobile/src/screens/TerminalScreen.tsx:725-727`)
setzt beide Felder bereits konsistent:

```ts
updateTab(serverId, tabId, { title: newName, customTitle: true });
```

→ Die Persistenz-Mechanik existiert. Es fehlt nur ein UI-Einstieg im
Manager-Chat (V2).

## User Story

Als User schaue ich auf das Multi-Spotlight-Grid im Manager-Chat. Ein Pane
zeigt aktuell „TMS Terminal" (auto-derived aus dem CWD). Ich möchte ihm
einen sprechenden Namen geben, z. B. „Build-Server".

1. Ich drücke ~500 ms auf den Header-Streifen der Pane (Punkt + Name +
   RUN-Badge + ↗).
2. Ein Bottom-Sheet öffnet sich mit dem aktuellen Namen vorausgefüllt im
   Eingabefeld.
3. Ich tippe „Build-Server", drücke „Speichern".
4. Sheet schließt, Pane-Header zeigt „Build-Server", Chat-Tab-Chip ändert
   sich auf „S1·Build-Server", und die Änderung überlebt App-Restart.
5. Optional: Wenn ich später wieder auf Auto-Naming will, mache ich erneut
   Long-Press → tippe auf „Auf Auto-Namen zurücksetzen" → der Pane zeigt
   wieder den CWD-Basename.

## Trigger

**Long-Press auf den Pane-Header**, nicht auf den ganzen Pane:

- Der Body ist eine WebView (xterm.js). Auf Android greift die WebView
  Long-Press selbst für Text-Selection ab → Gesten-Konflikt.
- Der Header ist bereits ein `Pressable` (`MultiSpotlight.tsx:198`) mit
  genug Touch-Target (~36 px hoch).
- Der Header zeigt den Namen an → genau dort Long-Press = sehr diskoverbar.

**Leere Panes** ("Pane N leer") reagieren nicht — kein Tab vorhanden, also
nichts zu renamen.

**Long-Press-Dauer:** native `onLongPress`-Default (~500 ms). Kein
benutzerdefinierter `delayLongPress` nötig.

## UI: Bottom-Sheet

Dasselbe Pattern wie `messageMenu` / `taskPanel` in `ManagerChatScreenV2.tsx`:
`<Modal transparent animationType="fade">` mit `Pressable` als Backdrop,
inneres Sheet, paddingBottom = `insets.bottom + 8`.

**Inhalt (von oben nach unten):**

1. Drag-Handle (visuelle Konsistenz mit anderen V2-Sheets)
2. Heading: „Terminal umbenennen"
3. Aktueller Name als Vorschau (kleiner, muted), z. B. „Aktuell: TMS Terminal"
4. `TextInput`:
   - `autoFocus`, `selectTextOnFocus`
   - `returnKeyType="done"`, `blurOnSubmit`, `onSubmitEditing` triggert Save
   - `maxLength={40}`
   - Pre-fill: `tab.title` (nicht `tabDisplayName(tab)`, damit der User die
     reine `title`-Quelle sieht und nicht versehentlich den derived CWD-Wert
     übernimmt — bei `customTitle === false` ist `title` allerdings derzeit
     der zuletzt gesetzte Title; das ist der intuitive Default).
5. Button-Reihe:
   - „Abbrechen" (sekundär)
   - „Speichern" (primär)
6. **Conditional Footer-Button** (nur wenn `tab.customTitle === true`):
   - „Auf Auto-Namen zurücksetzen" mit Feather-Icon `rotate-ccw`,
     destruktiv-ish gestylt, separiert mit Divider

**Save-Logik:**
- Trim Input
- Wenn leer oder unverändert → wie Cancel (kein Update)
- Sonst: `updateTab(serverId, tabId, { title: trimmed, customTitle: true })`
- Sheet schließt, `refocusFocusedPane()` (Keyboard-Refokus des aktiven Panes,
  analog zu `handleClosePanel`)

**Reset-Logik:**
- `updateTab(serverId, tabId, { customTitle: false })`
- `tab.title` wird **nicht** zurückgesetzt — `tabDisplayName` ignoriert ihn,
  solange `customTitle` falsy ist und ein `lastCwd` vorhanden ist. Falls der
  User später erneut renamed, wird der alte Title-String als Pre-fill nicht
  mehr stören, da das Sheet ohnehin den aktuellen `tab.title` zeigt.

## Komponenten- und Daten-Änderungen

### `mobile/src/components/manager/MultiSpotlight.tsx`

Neuer optionaler Prop:
```ts
onPaneLongPress?: (index: number) => void;
```

In der Pane-Header-`Pressable` (Zeile ~198):
```tsx
<Pressable
  style={s.head}
  onPress={() => onActivePaneChange(i)}
  onLongPress={() => onPaneLongPress?.(i)}
  delayLongPress={500}  // explicit für Stabilität
>
```

Keine Änderungen am Pane-Body, an Pane-Empty-Slots oder an der
Double-Tap-Logik.

### `mobile/src/screens/ManagerChatScreenV2.tsx`

**Neuer State:**
```ts
const [renameSheet, setRenameSheet] = useState<{ tabId: string } | null>(null);
const [renameValue, setRenameValue] = useState('');
```

**Neuer Handler `handlePaneLongPress`:**
```ts
const handlePaneLongPress = useCallback((idx: number) => {
  const sid = panes[idx];
  if (!sid) return;  // empty pane
  const tab = tabs.find((t) => t.sessionId === sid);
  if (!tab) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  setRenameValue(tab.title);
  setRenameSheet({ tabId: tab.id });
}, [panes, tabs]);
```

**Neuer Handler `commitRename` + `closeRenameSheet`:**
```ts
const commitRename = useCallback(() => {
  if (!renameSheet) return;
  const trimmed = renameValue.trim();
  if (trimmed.length > 0) {
    updateTab(serverId, renameSheet.tabId, { title: trimmed, customTitle: true });
  }
  setRenameSheet(null);
  setRenameValue('');
  refocusFocusedPane();
}, [renameSheet, renameValue, serverId, updateTab, refocusFocusedPane]);

const resetToAutoName = useCallback(() => {
  if (!renameSheet) return;
  updateTab(serverId, renameSheet.tabId, { customTitle: false });
  setRenameSheet(null);
  setRenameValue('');
  refocusFocusedPane();
}, [renameSheet, serverId, updateTab, refocusFocusedPane]);

const closeRenameSheet = useCallback(() => {
  setRenameSheet(null);
  setRenameValue('');
  refocusFocusedPane();
}, [refocusFocusedPane]);
```

**JSX:**
- `<MultiSpotlight ... onPaneLongPress={handlePaneLongPress} />`
- Neuer `<Modal>`-Block am Ende, neben den anderen V2-Sheets

`updateTab` ist bereits aus `useTerminalStore` verfügbar (siehe
ähnliche Calls anderswo); falls noch nicht importiert in V2, einmalig
ergänzen.

## Persistenz

Bereits abgedeckt durch `terminalStore` (Zustand + AsyncStorage). Kein
neuer Persistenz-Pfad nötig.

## Edge Cases

| Fall | Verhalten |
|------|-----------|
| User leert das Eingabefeld und drückt Speichern | Sheet schließt ohne Update (Trim-Leer-Guard) |
| User tippt nur Whitespace | Wie leer (Trim-Leer-Guard) |
| User gibt denselben Namen ein | Update läuft (Idempotent), kein Schaden |
| Long-Press auf eine leere Pane | Handler returnt früh, kein Sheet |
| Long-Press während Drag (Pane-Reorder) | `onLongPress` feuert nicht, wenn `onMoveShouldSetPanResponder` greift — kein Konflikt |
| Tab wird geschlossen, während Sheet offen ist | `commitRename` ruft `updateTab` auf eine nicht-existente Tab-ID, der Store ignoriert das ohne Crash; Sheet schließt regulär |
| Custom-Name auf bereits Custom-Tab | Funktioniert — überschreibt `title`, `customTitle` bleibt true |

## Testing

Manuell (kein Unit-Test-Setup für RN-Screens):

1. App starten, Manager-Chat öffnen, einen Pane mit einem Terminal füllen.
2. Long-Press auf den Pane-Header → Sheet öffnet sich, Eingabefeld ist
   fokussiert mit aktuellem Titel.
3. Neuen Namen eingeben („Foo"), Speichern → Pane-Header zeigt „Foo",
   Chat-Tab-Chip zeigt „S1·Foo".
4. App komplett schließen + neu starten → Name bleibt „Foo".
5. Im Terminal-Screen prüfen → Tab heißt „Foo".
6. Erneut Long-Press → „Auf Auto-Namen zurücksetzen" tippen → Pane zeigt
   wieder den CWD-Basename.
7. Long-Press auf eine leere Pane → kein Sheet, keine Reaktion.
8. Long-Press, Sheet öffnet, „Abbrechen" → kein Update.
9. Long-Press, Sheet öffnet, leeren String, Speichern → kein Update.

## TypeScript-Validation

`npx tsc --noEmit -p mobile/tsconfig.json` muss grün durchlaufen.

## Out of Scope (Future Work)

- "Shell 1/2/3"-Slug für die AI: ein separates Feature, das die Manager-AI
  echte Tab-Namen statt Shell-Slots zeigt (siehe `project-state.md`).
- Multi-Aktion-Sheet (Schließen, Farbe, etc.) — wenn echter Bedarf.
- Long-Press auf Chat-Tab-Chip als Alt-Trigger — kann später dazu kommen,
  aber Pane-Header reicht.
