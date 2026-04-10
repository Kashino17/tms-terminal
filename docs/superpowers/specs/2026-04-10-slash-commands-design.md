# Slash-Command-Picker + /sm Summary

**Datum:** 2026-04-10
**Status:** Approved

## Problem

Slash-Commands sind versteckt — der User muss sie auswendig kennen. Es gibt keine Möglichkeit, eine Terminal-Summary aktiv anzufordern.

## Lösung

Telegram-Style Slash-Command-Picker über dem Input + neuer `/sm` Command für Terminal-Zusammenfassungen.

---

## 1. Slash-Command-Picker

### Trigger

Picker erscheint wenn `input.startsWith('/')`. Verschwindet wenn `/` gelöscht oder Command ausgeführt wird.

### Command-Definitionen

```typescript
const SLASH_COMMANDS = [
  { cmd: '/sm', label: 'Zusammenfassung', desc: 'Terminal-Summary (alle oder ausgewähltes)' },
  { cmd: '/reset', label: 'Zurücksetzen', desc: 'Agent-Memory löschen, neu starten' },
  { cmd: '/clear', label: 'Chat leeren', desc: 'Chat-Verlauf löschen' },
  { cmd: '/memory', label: 'Memory', desc: 'Memory-Viewer öffnen' },
  { cmd: '/help', label: 'Hilfe', desc: 'Verfügbare Befehle anzeigen' },
];
```

### Smart-Filter

Eingabe `/re` → filtert zu `/reset`. Case-insensitive Match auf `cmd` ab dem 2. Zeichen.

### UI

- Position: Direkt über dem TextInput, unter den Terminal-Chips
- Stil: Dunkle Liste, jede Zeile: Command (bold) + Beschreibung (muted)
- Max Höhe: 5 Einträge (alle passen rein)
- Tap auf Eintrag → Command wird sofort ausgeführt
- Keine Animation nötig — einfach ein/ausblenden

### Ausführung

Tap auf Picker-Eintrag ruft dieselbe Logik auf wie das manuelle Tippen + Senden. Input wird geleert, Command wird verarbeitet.

---

## 2. /sm — Terminal-Summary

### Verhalten

- **Chip "Alle" aktiv:** `manager:poll` ohne `targetSessionId` → Summary aller Terminals
- **Spezifischer Chip aktiv (z.B. Shell 2):** `manager:poll` mit `targetSessionId` → Summary nur für dieses Terminal

### Server-Änderung

`manager:poll` Payload bekommt optionales `targetSessionId` Feld:

```typescript
// Client → Server
{ type: 'manager:poll', payload: { targetSessionId?: string } }
```

`poll()` Methode in `manager.service.ts` bekommt optionalen `targetSessionId` Parameter. Wenn gesetzt, wird nur dieses Terminal zusammengefasst.

### Protokoll-Änderung

`ManagerPollMessage` in `shared/protocol.ts` erweitern:

```typescript
export interface ManagerPollMessage {
  type: 'manager:poll';
  payload?: { targetSessionId?: string };
}
```

---

## Was unverändert bleibt

- Bestehende Commands (`/reset`, `/help`, `/clear`, `/memory`) — Logik bleibt gleich
- Poll-Timer (15 Min) — läuft weiter unabhängig
- Manager-Chat UI — nur der Picker kommt dazu
