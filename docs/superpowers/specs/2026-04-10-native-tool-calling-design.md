# Native Tool Calling für GLM-5-Turbo

**Datum:** 2026-04-10
**Status:** Approved

## Problem

GLM nutzt Custom-Tags (`[WRITE_TO:...]`) aus dem System-Prompt nicht zuverlässig. Statt Befehle auszuführen, redet es über die Aufgabe oder fragt unnötig nach. Ursache: Das Modell ist für natives Tool Calling optimiert (0.67% Fehlerrate), nicht für Freitext-Tag-Parsing.

Zusätzlich: Model ID ist veraltet (`glm-4-plus` statt `glm-5-turbo`) und Terminal-Output-Buffer werden nie als stale markiert.

## Lösung

Hybrid-Ansatz: Terminal-Actions als native Function Tools über die OpenAI-kompatible `tools` API. Memory-Updates und Personality-Config bleiben als Text-Tags im Prompt.

---

## 1. Tool Definitions

Zwei native Tools für GLM:

```typescript
const MANAGER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_to_terminal',
      description: 'Schreibt einen Befehl in ein Terminal und führt ihn aus. Nutze diese Funktion IMMER wenn der User möchte dass ein Befehl ausgeführt wird.',
      parameters: {
        type: 'object',
        properties: {
          session_label: {
            type: 'string',
            description: 'Das Terminal-Label, z.B. "Shell 1", "Shell 2"',
          },
          command: {
            type: 'string',
            description: 'Der auszuführende Befehl, z.B. "git status", "npm run build"',
          },
        },
        required: ['session_label', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_enter',
      description: 'Drückt Enter in einem Terminal. Nutze dies um wartende Prompts zu bestätigen.',
      parameters: {
        type: 'object',
        properties: {
          session_label: {
            type: 'string',
            description: 'Das Terminal-Label, z.B. "Shell 1"',
          },
        },
        required: ['session_label'],
      },
    },
  },
];
```

`session_label` statt `sessionId`: Das Modell sieht im Kontext Labels ("Shell 1"), nicht UUIDs. Server resolvet Label → sessionId.

---

## 2. GLM Provider Änderungen

### Model ID Update

`glm-4-plus` → `glm-5-turbo`

### Neue Methode: `chatStreamWithTools()`

```typescript
interface ToolCall {
  name: string;
  arguments: Record<string, string>;
}

interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
}

chatStreamWithTools(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDefinition[],
  onChunk: (token: string) => void,
): Promise<StreamResult>
```

- Sendet `tools` Array und `tool_choice: 'auto'` im Request Body
- Streamt Text-Tokens über `onChunk` (wie bisher)
- Akkumuliert Tool-Call-Deltas still im Hintergrund (kein `onChunk` für Tool-Calls)
- Tool-Call-Arguments kommen als JSON-Fragmente über mehrere Chunks — werden gesammelt und am Ende `JSON.parse()`

### Stream-Response-Format (OpenAI-kompatibel)

Text-Chunks:
```json
{"choices":[{"delta":{"content":"Klar, ich mach das."}}]}
```

Tool-Call-Chunks:
```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"write_to_terminal","arguments":"{\"session_label\":"}}]}}]}
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Shell 2\",\"command\":\"hi\"}"}}]}}]}
```

### Kimi bleibt unverändert

Kimi nutzt weiterhin `chatStream()` ohne Tools.

### Bestehende `chat()` und `chatStream()` auf GLM bleiben

`chatStreamWithTools()` ist eine zusätzliche Methode. Die alten Methoden bleiben für Fälle wie `poll()` und `distill()` die keine Tools brauchen.

---

## 3. Manager Service Änderungen

### handleChat() Ablauf

1. Phasen 1-3: identisch (analyzing_terminals → building_context → calling_ai)
2. Phase 4 (streaming): Provider-Weiche:
   - GLM: `chatStreamWithTools(messages, systemPrompt, MANAGER_TOOLS, onChunk)` → `StreamResult`
   - Kimi: `chatStream(messages, systemPrompt, onChunk)` → `string` (Text-only, Tags wie bisher)
3. Nach Stream-Ende: Tool Calls aus `StreamResult.toolCalls` lesen + Regex-Fallback für Tags im Text
4. Phase 5: Tool Calls → ManagerActions → ausführen

### Tool Call → ManagerAction Mapping

```
write_to_terminal({ session_label: "Shell 2", command: "hi" })
  → { type: 'write_to_terminal', sessionId: resolveLabel("Shell 2"), detail: "hi" }

send_enter({ session_label: "Shell 1" })
  → { type: 'send_enter', sessionId: resolveLabel("Shell 1"), detail: "" }
```

`resolveLabel()` nutzt die bestehende `sessionLabels` Map.

### System-Prompt Änderungen

**Entfernt:** Der gesamte Block "So führst du Terminal-Befehle aus" (~30 Zeilen Tag-Erklärungen, Beispiele, WRITE_TO/SEND_ENTER Dokumentation).

**Ersetzt durch:** Ein kurzer Absatz:
```
## Deine Terminal-Tools
Du hast echte Tools um Befehle in Terminals auszuführen. Nutze write_to_terminal um Befehle zu senden und send_enter um Enter zu drücken. Führe Befehle SOFORT aus wenn der User es will — frag nicht nach, ob er sicher ist.
```

**Beibehalten:** Memory-Tags (`[MEMORY_UPDATE]...[/MEMORY_UPDATE]`), Personality-Config-Tags, Persönlichkeits-Block, Antwort-Format-Regeln.

### Regex-Fallback

`parseActions()` (der bestehende Regex-Parser für `[WRITE_TO:]` Tags) bleibt als Fallback. Wenn GLM trotz nativer Tools doch Tags im Text produziert, werden sie trotzdem erkannt und ausgeführt.

---

## 4. Streaming-Verhalten bei Tool Calls

### GLM antwortet mit Text + Tool Calls

1. ThinkingBubble: Phasen wie bisher
2. Text-Tokens werden live gestreamt (sichtbar)
3. Tool-Call-Deltas werden still akkumuliert (nicht sichtbar)
4. Phase "Führe Befehle aus..."
5. `stream_end` mit Text + Actions + Phasen

### GLM antwortet nur mit Tool Calls (kein Text)

1. ThinkingBubble: Phasen + Timer, kein Streaming-Text
2. Tool Calls werden ausgeführt
3. Auto-generierte Bestätigung: z.B. "Befehl `hi` in Shell 2 ausgeführt."
4. `stream_end` mit Bestätigungstext + Actions + Phasen

### `manager:stream_chunk` enthält nur Text-Tokens

Tool-Call-Fragments gehen nicht an den Client. Alles bleibt Server-intern.

---

## 5. Stale Output-Buffer Fix

### Problem

Output-Buffer werden nur bei `poll()` geleert. Zwischen Polls zeigt der Kontext alten Terminal-Output — ein fertiger Build wird als "Build läuft" interpretiert.

### Lösung

`lastUpdated` Timestamp pro Buffer-Eintrag in `outputBuffers`:

```typescript
private outputBuffers = new Map<string, { data: string; lastUpdated: number }>();
```

In `feedOutput()`: `lastUpdated = Date.now()` bei jedem neuen Output.

In `analyzeTerminalOutput()`: Wenn `Date.now() - lastUpdated > 60_000` (60s ohne neues Output), Status wird auf `idle` gesetzt, unabhängig vom Buffer-Inhalt.

In `formatContextBlock()`: Stale-Markierung im Kontext: `⏳ Letzter Output vor Xs — Terminal wahrscheinlich idle`.

---

## Was unverändert bleibt

- Kimi Provider (kein Tool Calling)
- Memory-Tag-System (`[MEMORY_UPDATE]`, `[PERSONALITY_CONFIG]`)
- Mobile UI (ThinkingBubble, Streaming, Phase-Popup)
- WebSocket-Protokoll (keine neuen Message-Types)
- Direct Command Parser (`tryExecuteCommand()`)
