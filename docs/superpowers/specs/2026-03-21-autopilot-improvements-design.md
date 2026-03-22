# Autopilot Improvements — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Mobile client primarily, one minor server-side adjustment

## Overview

Four improvements to the Autopilot feature in the TMS Terminal mobile app:

1. **Optional optimization** — Drafts can be queued directly without Claude CLI optimization
2. **Queue numbering** — Active items display their execution position
3. **Extended reordering** — Jump to top/bottom, pick arbitrary position via number picker
4. **Prompt library** — Global, persistent collection of reusable prompts

## 1. Optional Optimization

### Current Behavior
- Items are added as `draft` → must be batch-optimized via Claude CLI → become `queued`
- No way to skip the optimization step

### New Behavior
- Long-press ActionSheet on a `draft` or `error` item gains a **"Direkt in Queue"** option
- Selecting it:
  1. Sets `status` to `'queued'`
  2. Copies `text` into `optimizedPrompt` (the server's `tryDequeuePrompt` reads `optimizedPrompt`)
  3. Sends `autopilot:update_item` via WebSocket with `{ id, status: 'queued', optimizedPrompt: text }`
- The existing batch-optimize flow remains unchanged for To-Dos that benefit from optimization

### Store Method
- `queueDirectly(sessionId, itemId)` — sets `status` to `'queued'`, copies `text` to `optimizedPrompt`, sends `autopilot:update_item` via WebSocket

### Why Minimal Server Changes
The server already handles any item with `status: 'queued'` and a populated `optimizedPrompt`. The existing `autopilot:update_item` WebSocket message propagates the change. The only server-side change is to accept `status` and `optimizedPrompt` in the `autopilot:add_item` handler (see section 4, `addSavedToQueue`).

## 2. Queue Numbering

### Current Behavior
- Items show status icons but no position number
- Execution order is implicit from list position

### New Behavior
- Each **active** item (`draft`, `optimizing`, `queued`, `running`, `error`) displays a position number on the left side of the row (e.g., `1`, `2`, `3`, ...)
- **Done** items get no number — they remain at the bottom, dimmed
- Numbers update live when items are reordered, added, or removed
- The number reflects execution order: item #1 runs next when queue is enabled

### Implementation Notes
- Derive position from the item's index in the sorted active-items array
- Display as a small, monospace-styled label in the row's left margin, before the status icon

## 3. Extended Reordering

### Current Behavior
- Long-press → ActionSheet with "Nach oben" (+1), "Nach unten" (-1), "Loeschen"
- **Bug:** existing move up/down handlers call `store.reorderItems()` but do NOT send the `autopilot:reorder` WebSocket message → server queue order is out of sync

### New ActionSheet Options

Available options depend on item status:

| Option | draft | optimizing | queued | running | error | done |
|---|---|---|---|---|---|---|
| "Ganz nach oben" | yes | yes | yes | — | yes | — |
| "Nach oben" | yes | yes | yes | — | yes | — |
| "Nach unten" | yes | yes | yes | — | yes | — |
| "Ganz nach unten" | yes | yes | yes | — | yes | — |
| "Position waehlen..." | yes | yes | yes | — | yes | — |
| "Direkt in Queue" | yes | — | — | — | yes | — |
| "Prompt speichern" | yes | yes | yes | yes | yes | yes |
| "Loeschen" | yes | yes | yes | — | yes | yes |

- `running` items cannot be reordered or deleted (they are mid-execution)
- `done` items can only be saved to library or deleted

### Position Picker Modal
- Simple modal with a title "Position waehlen" and a scrollable list of numbers (1 to N, where N = count of active items)
- Current position is highlighted
- Tapping a number moves the item to that position and closes the modal
- Tapping outside the modal or a "Abbrechen" button dismisses without action
- The remaining items shift accordingly

### Reorder Logic (new store methods)
- `moveToTop(sessionId, itemId)` — removes item from current position, inserts at index 0
- `moveToBottom(sessionId, itemId)` — removes item, inserts at last active index
- `moveToPosition(sessionId, itemId, targetPosition)` — removes item, inserts at `targetPosition - 1` (0-indexed)
- All three call `reorderItems()` internally and send `autopilot:reorder` via WebSocket
- **Fix existing bug:** refactor `handleMoveUp`/`handleMoveDown` to also send `autopilot:reorder` via WebSocket (route all reorder operations through a shared helper that syncs with server)

## 4. Prompt Library

### Data Model
```typescript
interface SavedPrompt {
  id: string;          // unique ID (uses existing makeId() from store)
  title: string;       // short display name
  text: string;        // the prompt text
  createdAt: number;   // timestamp
}
```

### Storage
- Stored in the `autopilotStore` as a new top-level field: `savedPrompts: SavedPrompt[]` (initialized as `[]`)
- Persisted via AsyncStorage (same Zustand persist middleware as existing state)
- **Global** — not scoped to any session or server

### Store Methods
- `addSavedPrompt(title, text)` — creates and persists a new SavedPrompt using `makeId()`
- `updateSavedPrompt(id, updates)` — edits title or text
- `removeSavedPrompt(id)` — deletes from library
- `addSavedToQueue(sessionId, savedPromptId)` — creates a new queue item with `status: 'queued'` and both `text` and `optimizedPrompt` set to the saved prompt's text. Sends `autopilot:add_item` with `{ id, text, status: 'queued', optimizedPrompt: text }` (requires server handler to accept optional `status` and `optimizedPrompt` fields)
- **Guard:** "In Queue" button is disabled when no active session exists (`sessionId` is undefined)

### Server-Side Change (minor)
The `autopilot:add_item` handler in `ws.handler.ts` currently hardcodes `status: 'draft'`. Change to accept optional `status` and `optimizedPrompt` from the payload, defaulting to `'draft'` if not provided. This is a 2-line change.

### UI: Collapsible Section in AutopilotPanel
- Located **below** the queue list
- Header: **"Gespeicherte Prompts"** with expand/collapse chevron icon + count badge
- Collapsed by default

#### Expanded Content
- List of saved prompts, each showing:
  - Title (bold)
  - Text preview (truncated, 1 line)
  - **"In Queue"** button on the right — adds prompt to current session's queue as `queued` (disabled if no active session)
- Long-press on a saved prompt → ActionSheet with:
  - **"Bearbeiten"** — opens inline edit form (title + text fields, same layout as the add form)
  - **"Loeschen"** — removes from library
- **"+ Neuen Prompt speichern"** button at the bottom of the section → opens inline form with title and text fields

#### Saving from Queue Items
- The Long-press ActionSheet on any queue item (any status) gains a **"Prompt speichern"** option
- Opens a small form pre-filled with `optimizedPrompt` if available, otherwise `text`, plus an empty title field
- Saves to the global library
- Triggers haptic feedback on save (consistent with existing add/remove haptics)

## Affected Files

| File | Changes |
|---|---|
| `mobile/src/store/autopilotStore.ts` | New `savedPrompts: SavedPrompt[]` state (default `[]`), new methods: `addSavedPrompt`, `updateSavedPrompt`, `removeSavedPrompt`, `addSavedToQueue`, `queueDirectly`, `moveToTop`, `moveToBottom`, `moveToPosition` |
| `mobile/src/components/AutopilotPanel.tsx` | Position numbers in rows, extended ActionSheet (status-aware), position picker modal with cancel, prompt library collapsible section, save-prompt form, haptic feedback, fix existing reorder WebSocket sync bug |
| `server/src/websocket/ws.handler.ts` | `autopilot:add_item` handler accepts optional `status` and `optimizedPrompt` fields (2-line change) |

## Out of Scope
- Auto-saving optimized prompts to library (explicitly rejected — manual only)
- Per-session or per-server prompt libraries (explicitly rejected — global only)
- Drag & drop reordering (explicitly rejected — ActionSheet approach chosen)
- Separate input fields for To-Dos vs. prompts (explicitly rejected — single input with optional optimization)
