# Native Tool Calling for GLM-5-Turbo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch GLM from fragile custom-tag-based actions to native OpenAI-compatible tool calling, update model ID to glm-5-turbo, and fix stale terminal output buffers.

**Architecture:** Add `chatStreamWithTools()` to the GLM provider that sends function definitions via the `tools` API parameter and parses tool-call deltas from the SSE stream. Manager service routes GLM through this new method while Kimi continues using the existing `chatStream()`. System prompt is shortened by removing tag documentation.

**Tech Stack:** TypeScript, Node.js, OpenAI-compatible streaming API with tool_calls

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `server/src/manager/ai-provider.ts` | Add `chatStreamWithTools()` to GLM, update model ID |
| Modify | `server/src/manager/manager.service.ts` | Provider-aware streaming, tool call → action mapping, shorter prompt, stale buffer fix |

---

### Task 1: GLM Provider — Update Model ID + Add `chatStreamWithTools()`

**Files:**
- Modify: `server/src/manager/ai-provider.ts`

- [ ] **Step 1: Update model ID**

Change line 157 from:
```typescript
const GLM_MODEL = 'glm-4-plus';
```
to:
```typescript
const GLM_MODEL = 'glm-5-turbo';
```

- [ ] **Step 2: Add exported types for tool calling**

After the `ProviderConfig` interface (line 29), add:

```typescript
// ── Tool Calling Types ─────────────────────────────────────────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, string>;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
}
```

- [ ] **Step 3: Add `chatStreamWithTools()` to GlmProvider**

Add this method to the `GlmProvider` class after the existing `chatStream()` method (after line 271):

```typescript
  async chatStreamWithTools(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: (token: string) => void,
  ): Promise<StreamResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('GLM API key not configured');

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages: apiMessages,
        temperature: 0.3,
        max_tokens: 4096,
        stream: true,
        tools,
        tool_choice: 'auto',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM API error ${res.status}: ${body.slice(0, 200)}`);
    }

    let fullText = '';
    const toolCallAccum = new Map<number, { name: string; args: string }>();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{
              delta: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          const delta = parsed.choices[0]?.delta;

          // Text content
          if (delta?.content) {
            fullText += delta.content;
            onChunk(delta.content);
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { name: '', args: '' });
              }
              const acc = toolCallAccum.get(idx)!;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    // Parse accumulated tool calls
    const toolCalls: ToolCall[] = [];
    for (const [, acc] of toolCallAccum) {
      if (acc.name && acc.args) {
        try {
          toolCalls.push({ name: acc.name, arguments: JSON.parse(acc.args) });
        } catch {
          logger.warn(`Manager: failed to parse tool call args: ${acc.args.slice(0, 100)}`);
        }
      }
    }

    return { text: fullText, toolCalls };
  }
```

- [ ] **Step 4: Add a type guard to the registry for GLM provider access**

Add this method to `AiProviderRegistry` after `getActive()` (line 298):

```typescript
  getActiveAsGlm(): GlmProvider | null {
    const active = this.getActive();
    return active.id === 'glm' ? (active as GlmProvider) : null;
  }
```

- [ ] **Step 5: Verify it compiles**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server && npm run build
```

Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add server/src/manager/ai-provider.ts
git commit -m "feat(ai-provider): add chatStreamWithTools to GLM, update to glm-5-turbo"
```

---

### Task 2: Manager Service — Tool Definitions + Provider-Aware Streaming

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Add tool definition imports and constants**

At the top of the file, update the import from `ai-provider.ts` (line 1):

```typescript
import { AiProviderRegistry, ChatMessage, ProviderConfig, ToolDefinition, StreamResult } from './ai-provider';
```

After the `MAX_CONTEXT_PER_SESSION` constant (line 14), add the tool definitions:

```typescript
// ── Native Tool Definitions (for GLM) ──────────────────────────────────────

const MANAGER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_to_terminal',
      description: 'Schreibt einen Befehl in ein Terminal und führt ihn aus. Nutze diese Funktion IMMER wenn der User möchte dass ein Befehl ausgeführt wird.',
      parameters: {
        type: 'object',
        properties: {
          session_label: { type: 'string', description: 'Das Terminal-Label, z.B. "Shell 1", "Shell 2"' },
          command: { type: 'string', description: 'Der auszuführende Befehl, z.B. "git status", "npm run build"' },
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
          session_label: { type: 'string', description: 'Das Terminal-Label, z.B. "Shell 1"' },
        },
        required: ['session_label'],
      },
    },
  },
];
```

- [ ] **Step 2: Add `resolveLabel()` helper and `toolCallsToActions()` method**

Add these two methods to `ManagerService`, before the `handleChat` method:

```typescript
  /** Resolve a terminal label like "Shell 2" to a sessionId. */
  private resolveLabel(label: string): string | null {
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.toLowerCase() === label.toLowerCase()) return id;
    }
    // Try partial match (e.g. "Shell2" without space)
    const normalized = label.replace(/\s+/g, '').toLowerCase();
    for (const [id, lbl] of this.sessionLabels) {
      if (lbl.replace(/\s+/g, '').toLowerCase() === normalized) return id;
    }
    logger.warn(`Manager: could not resolve label "${label}"`);
    return null;
  }

  /** Convert native tool calls to ManagerActions. */
  private toolCallsToActions(toolCalls: Array<{ name: string; arguments: Record<string, string> }>): ManagerAction[] {
    const actions: ManagerAction[] = [];
    for (const tc of toolCalls) {
      const label = tc.arguments.session_label;
      const sessionId = label ? this.resolveLabel(label) : null;
      if (!sessionId) {
        logger.warn(`Manager: tool call ${tc.name} — could not resolve label "${label}"`);
        continue;
      }
      if (tc.name === 'write_to_terminal') {
        actions.push({ type: 'write_to_terminal', sessionId, detail: tc.arguments.command ?? '' });
      } else if (tc.name === 'send_enter') {
        actions.push({ type: 'send_enter', sessionId, detail: '' });
      }
    }
    return actions;
  }
```

- [ ] **Step 3: Update `handleChat()` — provider-aware streaming with tool calling**

In `handleChat()`, replace the streaming section (the block from `const provider =` through to `phases[phases.length - 1].duration = Date.now() - phaseStart;` — approximately lines 642-655) with:

```typescript
      const provider = this.registry.getActive();
      const glm = this.registry.getActiveAsGlm();
      logger.info(`Manager: streaming chat via ${provider.name}${glm ? ' (with tools)' : ''}`);

      // Phase 4: Streaming
      recordPhase('streaming', 'Schreibt');

      let reply: string;
      let nativeToolCalls: Array<{ name: string; arguments: Record<string, string> }> = [];

      if (glm) {
        // GLM: use native tool calling
        const result = await glm.chatStreamWithTools(
          [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
          systemPrompt,
          isOnboarding ? [] : MANAGER_TOOLS,
          (token) => this.onStreamChunk?.(token),
        );
        reply = result.text;
        nativeToolCalls = result.toolCalls;
      } else {
        // Kimi: text-only streaming (tags parsed later)
        reply = await provider.chatStream(
          [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
          systemPrompt,
          (token) => this.onStreamChunk?.(token),
        );
      }

      // Close last phase duration
      phases[phases.length - 1].duration = Date.now() - phaseStart;
```

Note: During onboarding, we pass an empty tools array `[]` so GLM doesn't try to call tools during the personality setup conversation.

- [ ] **Step 4: Update action collection — native tool calls + regex fallback**

Replace the actions section (approximately lines 705-716, from `// Parse actions from reply` through the end of the `executing_actions` phase) with:

```typescript
      // Collect actions: native tool calls (GLM) + regex fallback (tags in text)
      const nativeActions = this.toolCallsToActions(nativeToolCalls);
      const tagActions = this.parseActions(reply);
      const actions = [...nativeActions, ...tagActions];

      // Phase 5: Execute actions (only if there are any)
      if (actions.length > 0) {
        phaseStart = Date.now();
        recordPhase('executing_actions', 'Befehle ausführen');
        for (const action of actions) {
          this.executeAction(action);
        }
        phases[phases.length - 1].duration = Date.now() - phaseStart;
      }
```

- [ ] **Step 5: Handle tool-call-only responses (no text)**

In the `finalText` section (approximately line 738), update to handle the case where GLM only produced tool calls with no visible text:

Replace:
```typescript
      const finalText = cleanReply || (parsedConfig
        ? `${parsedConfig.agentName} ist eingerichtet und bereit.`
        : 'Verstanden — ich habe mir alles gemerkt.');
```

With:
```typescript
      let finalText = cleanReply;
      if (!finalText) {
        if (parsedConfig) {
          finalText = `${parsedConfig.agentName} ist eingerichtet und bereit.`;
        } else if (actions.length > 0) {
          // Auto-generate confirmation for tool-call-only responses
          const summaries = actions.map(a => {
            const lbl = this.sessionLabels.get(a.sessionId) ?? a.sessionId.slice(0, 8);
            return a.type === 'write_to_terminal'
              ? `\`${a.detail}\` in ${lbl}`
              : `Enter in ${lbl}`;
          });
          finalText = `Ausgeführt: ${summaries.join(', ')}`;
        } else {
          finalText = 'Verstanden — ich habe mir alles gemerkt.';
        }
      }
```

- [ ] **Step 6: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): native tool calling for GLM, tag fallback for Kimi"
```

---

### Task 3: System Prompt — Remove Tag Documentation

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Replace the tag-based tool documentation in `buildSystemPrompt()`**

In the `buildSystemPrompt()` function (starting at line 121), find the block from `## Deine Fähigkeiten` through to `Sag NIEMALS "Ich habe keinen Zugriff"` (lines 153-186). Replace it with:

```typescript
## Deine Fähigkeiten

Du hast ECHTEN Zugriff auf alle Terminals. Das ist keine Simulation.

1. TERMINAL-OUTPUT LESEN: Du siehst den Output aller aktiven Sessions. Der Output wird dir automatisch mitgegeben.

2. BEFEHLE AUSFÜHREN: Du hast Terminal-Tools (write_to_terminal, send_enter). Nutze sie SOFORT wenn der User einen Befehl ausführen will. Frag NICHT nach ob er sicher ist — führ es einfach aus.

3. PROZESSE ABBRECHEN: Du kannst laufende Prozesse mit Ctrl+C stoppen (schreibe dafür das Zeichen über write_to_terminal).

4. TERMINAL-STATUS ERKENNEN: Du erkennst ob ein Terminal idle ist, ob ein Build läuft, ob ein Fehler aufgetreten ist, ob ein AI-Agent auf Input wartet.

${p.proactive ? `5. PROAKTIV HANDELN: Du denkst mit. Wenn was schiefläuft, sagst du Bescheid. Wenn was auffällt, erwähnst du es. Du schlägst Aktionen vor und führst sie auf Wunsch aus.` : ''}

WICHTIG: Sag NIEMALS "Ich habe keinen Zugriff" oder "Ich kann keine Befehle ausführen" — du KANNST es. Nutze die Tools.
```

This removes the entire `## So führst du Terminal-Befehle aus` section (~20 lines of tag documentation, examples, and format rules) and replaces the capabilities section with a shorter version that references tools instead of tags.

- [ ] **Step 2: Remove the "Antwort-Format" tag instruction**

Find and remove these lines (approximately lines 188-190):
```
## Antwort-Format
Schreibe IMMER zuerst deinen normalen, sichtbaren Text. Danach (und NUR danach) die internen Tags.
Dein sichtbarer Text muss IMMER wie eine natürliche menschliche Antwort klingen.
```

Replace with:
```
## Antwort-Format
Antworte natürlich und menschlich. Wenn du einen Befehl ausführst, sag kurz was du tust.
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server && npm run build
```

Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(prompt): replace tag docs with native tool references"
```

---

### Task 4: Stale Output Buffer Fix

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Change `outputBuffers` to track timestamps**

Replace the field declaration (line 280):
```typescript
  private outputBuffers = new Map<string, string>();
```

With:
```typescript
  private outputBuffers = new Map<string, { data: string; lastUpdated: number }>();
```

- [ ] **Step 2: Update `feedOutput()` to track timestamps**

Replace the `feedOutput` method (lines 362-380) with:

```typescript
  /** Called from ws.handler on every terminal:output event. */
  feedOutput(sessionId: string, data: string): void {
    if (!this.enabled) return;

    const clean = data.replace(ANSI_STRIP, '');
    if (!clean.trim()) return;

    const existing = this.outputBuffers.get(sessionId);
    const existingData = existing?.data ?? '';
    const combined = existingData + clean;

    // Cap buffer size — keep tail
    let finalData: string;
    if (combined.length > OUTPUT_BUFFER_MAX) {
      const sliced = combined.slice(combined.length - OUTPUT_BUFFER_MAX);
      const firstNl = sliced.indexOf('\n');
      finalData = firstNl >= 0 ? sliced.slice(firstNl + 1) : sliced;
    } else {
      finalData = combined;
    }

    this.outputBuffers.set(sessionId, { data: finalData, lastUpdated: Date.now() });
  }
```

- [ ] **Step 3: Update `clearSession()` — no change needed**

`clearSession()` calls `this.outputBuffers.delete(sessionId)` which works with any value type. No change needed.

- [ ] **Step 4: Update `buildTerminalContexts()` to use new buffer structure and detect stale buffers**

Replace the `buildTerminalContexts` method (lines 397-403) with:

```typescript
  /** Build structured context for all active sessions. */
  private buildTerminalContexts(): TerminalContext[] {
    const contexts: TerminalContext[] = [];
    const now = Date.now();
    for (const [sessionId, buf] of this.outputBuffers) {
      const label = this.sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const isStale = (now - buf.lastUpdated) > 60_000;
      const analysis = analyzeTerminalOutput(buf.data);
      const session = globalManager.getSession?.(sessionId);

      // Override status to idle if buffer is stale
      const status = isStale ? 'idle' : analysis.status;

      contexts.push({
        sessionId,
        label,
        cwd: session?.cwd,
        process: session?.processName,
        project: analysis.project,
        tool: analysis.tool,
        status,
        recentOutput: buf.data.length > MAX_CONTEXT_PER_SESSION
          ? '...' + buf.data.slice(-MAX_CONTEXT_PER_SESSION)
          : buf.data,
      });
    }
    return contexts;
  }
```

- [ ] **Step 5: Update `formatContextBlock()` to show stale indicator**

In `formatContextBlock()`, after the status label line (approximately line 411), add a stale indicator. Replace:

```typescript
  private formatContextBlock(contexts: TerminalContext[]): string {
    let block = '## Terminal-Übersicht\n\n';
    for (const ctx of contexts) {
      const emoji = STATUS_EMOJI[ctx.status];
      const statusLabel = STATUS_LABEL[ctx.status];
      block += `### ${emoji} ${ctx.label} — ${statusLabel}\n`;
```

With:

```typescript
  private formatContextBlock(contexts: TerminalContext[]): string {
    let block = '## Terminal-Übersicht\n\n';
    const now = Date.now();
    for (const ctx of contexts) {
      const emoji = STATUS_EMOJI[ctx.status];
      const statusLabel = STATUS_LABEL[ctx.status];
      const buf = this.outputBuffers.get(ctx.sessionId);
      const staleSecs = buf ? Math.round((now - buf.lastUpdated) / 1000) : 0;
      const staleNote = staleSecs > 60 ? ` ⏳ Letzter Output vor ${staleSecs}s — wahrscheinlich idle` : '';
      block += `### ${emoji} ${ctx.label} — ${statusLabel}${staleNote}\n`;
```

- [ ] **Step 6: Update `poll()` — clear buffers using new structure**

In the `poll()` method, find where buffers are cleared after summarization (approximately line 468):

Replace:
```typescript
        this.outputBuffers.set(s.sessionId, '');
```

With:
```typescript
        this.outputBuffers.set(s.sessionId, { data: '', lastUpdated: Date.now() });
```

- [ ] **Step 7: Update `poll()` — check activity using new buffer structure**

In the `poll()` method, find where active contexts are filtered (approximately line 426):

Replace:
```typescript
    const activeContexts = contexts.filter(c => c.recentOutput.length > 0);
```

With:
```typescript
    const activeContexts = contexts.filter(c => c.recentOutput.length > 0);
```

No change needed — `recentOutput` is already set from `buf.data` in `buildTerminalContexts()`.

- [ ] **Step 8: Verify it compiles**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server && npm run build
```

Expected: Clean compilation.

- [ ] **Step 9: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "fix(manager): stale output buffer detection with timestamps"
```

---

### Task 5: Build & Verify

**Files:** None (verification only)

- [ ] **Step 1: Full server build**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server && npm run build
```

Expected: Clean compilation, no TypeScript errors.

- [ ] **Step 2: Verify model ID is updated**

```bash
grep -n "GLM_MODEL" /Users/ayysir/Desktop/TMS\ Terminal/server/src/manager/ai-provider.ts
```

Expected: `const GLM_MODEL = 'glm-5-turbo';`

- [ ] **Step 3: Verify tool definitions exist**

```bash
grep -n "MANAGER_TOOLS" /Users/ayysir/Desktop/TMS\ Terminal/server/src/manager/manager.service.ts
```

Expected: Tool definitions and usage in handleChat.

- [ ] **Step 4: Verify tag documentation is removed from prompt**

```bash
grep -n "WRITE_TO\|SEND_ENTER" /Users/ayysir/Desktop/TMS\ Terminal/server/src/manager/manager.service.ts
```

Expected: Only matches in `parseActions()` (the regex fallback) and `cleanReply` — NOT in `buildSystemPrompt()`.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve build issues from native tool calling"
```
