# Manager Agent: Activity Indicator + Streaming

**Datum:** 2026-04-10
**Status:** Approved

## Problem

Der Manager Agent sagt "Lass mich das für dich erledigen" — danach gibt es kein Feedback. Kein Timer, kein Fortschritt, keine Möglichkeit zu erkennen ob der Agent noch aktiv ist oder aufgehört hat zu arbeiten.

## Lösung

Phasen-basierte Thinking-Bubble im Chat + Echtzeit-Token-Streaming der AI-Antwort. Zusätzlich: Claude CLI als Provider entfernen, nur GLM (Default) + Kimi behalten.

---

## 1. WebSocket-Protokoll

### Neue Server→Client Messages

| Message | Payload | Wann |
|---|---|---|
| `manager:thinking` | `{ phase: string, detail?: string, elapsed: number }` | Bei jedem Phasenwechsel |
| `manager:stream_chunk` | `{ token: string }` | Jedes Token/Chunk vom AI-Stream |
| `manager:stream_end` | `{ text: string, actions?: ManagerAction[], phases: PhaseInfo[] }` | Stream fertig |

### PhaseInfo Type

```typescript
interface PhaseInfo {
  phase: string;       // z.B. 'analyzing_terminals'
  label: string;       // z.B. 'Terminals analysieren'
  duration: number;    // Millisekunden
}
```

### Phasen-Reihenfolge

1. `analyzing_terminals` — Terminaldaten sammeln & analysieren
2. `building_context` — System-Prompt + Memory aufbauen
3. `calling_ai` — Request an AI Provider gesendet
4. `streaming` — Tokens kommen rein (ab hier `stream_chunk` Messages)
5. `executing_actions` — Befehle in Terminals schreiben (nur wenn Actions vorhanden)

### Bestehende Messages

- `manager:response` — bleibt nur für direkte Commands (z.B. "Shell 2: git status")
- `manager:error` — bleibt unverändert

---

## 2. Server-Änderungen

### AI Provider (`ai-provider.ts`)

- **Claude CLI komplett entfernen** — kein CLI-Spawn, kein Binary-Detection, kein Output-Parsing
- **Default Provider:** `glm` (statt `claude`)
- **Neue Methode:** `chatStream(messages, systemPrompt, onChunk)` — gibt AsyncIterator/Stream zurück
- Kimi und GLM nutzen OpenAI-kompatibles API-Format mit `stream: true`
- Chunks werden über Callback nach oben gereicht

### Manager Service (`manager.service.ts`)

`handleChat()` bekommt neue Callbacks:

```typescript
interface ChatCallbacks {
  onThinking: (phase: string, detail?: string) => void;
  onStreamChunk: (token: string) => void;
  onStreamEnd: (text: string, actions?: ManagerAction[], phases?: PhaseInfo[]) => void;
  onResponse: (text: string, actions?: ManagerAction[]) => void;  // nur für direkte Commands
  onError: (message: string) => void;
}
```

Ablauf in `handleChat()`:
1. `onThinking('analyzing_terminals')` → Terminals analysieren
2. `onThinking('building_context')` → Prompt + Memory bauen
3. `onThinking('calling_ai')` → Provider-Call starten
4. `chatStream()` aufrufen → jeder Chunk geht über `onStreamChunk(token)`
5. Nach Stream-Ende: Actions parsen, Memory-Updates extrahieren
6. Falls Actions: `onThinking('executing_actions')` → ausführen
7. `onStreamEnd(finalText, actions, phases)` → fertig

### WebSocket Handler (`ws.handler.ts`)

Callbacks in `manager:chat` Handler verdrahten:
- `onThinking` → sendet `manager:thinking` mit elapsed Timer
- `onStreamChunk` → sendet `manager:stream_chunk`
- `onStreamEnd` → sendet `manager:stream_end`
- Elapsed-Timer startet bei erstem `onThinking`

---

## 3. Mobile UI

### Zustand Store (`managerStore.ts`)

Neuer State:
```typescript
thinking: { phase: string; detail?: string; elapsed: number } | null;
streamingText: string;
lastPhases: PhaseInfo[] | null;
```

Neue Actions:
- `setThinking(phase, detail?, elapsed)` — aktualisiert Thinking-State
- `appendStreamChunk(token)` — hängt Token an streamingText an
- `finishStream(text, actions, phases)` — beendet Stream, erstellt finale Nachricht

### Thinking-Bubble (inline im Chat)

- Erscheint als letzte Nachricht wenn `thinking !== null`
- Zeigt: aktuelle Phase als deutscher Text + laufender Timer
- Phasen-Labels:
  - `analyzing_terminals` → "Analysiere Terminals..."
  - `building_context` → "Bereite Kontext vor..."
  - `calling_ai` → "Sende an AI..."
  - `streaming` → "Schreibt..."
  - `executing_actions` → "Führe Befehle aus..."
- Dezente Pulse-Animation neben dem Phasentext
- Bei Phase `streaming`: Bubble wird zur Streaming-Bubble, gestreamter Text baut sich live auf, Timer läuft weiter

### Nach Stream-Ende

- Thinking-Bubble wird zur normalen Assistant-Nachricht mit finalem Text
- Chip über der Nachricht: "⏱ 4.2s"
- Tap auf Chip → Modal/Popup mit:
  - Jede Phase: Name + Dauer
  - Gesamtdauer
  - Verwendeter Provider

### TypingIndicator

- Die drei pulsierenden Dots werden komplett entfernt
- Ersetzt durch die neue Thinking-Bubble

---

## 4. Provider-Cleanup

### Was rausfliegt

- `claude` Provider aus Provider-Registry
- CLI-Spawn, Binary-Detection, Output-Parsing Code
- `claude` Option im Provider-Picker (Mobile)
- Fallback-Logik auf Claude

### Was sich ändert

- Default: `glm`
- Provider-Picker: nur GLM 5.0 Turbo + Kimi Code
- Kein API-Key → Fehlermeldung im Chat: "API-Key für [Provider] nicht konfiguriert."
- Settings: Claude aus API-Key-Liste entfernen

### Config-Kompatibilität

- `~/.tms-terminal/manager.json` behält Struktur
- Bestehender `claude`-Eintrag wird ignoriert
- Kein Breaking Change
