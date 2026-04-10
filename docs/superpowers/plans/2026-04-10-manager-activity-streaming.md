# Manager Agent Activity Indicator + Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time phase indicators and token streaming to the Manager Agent so users can see what the agent is doing at every moment.

**Architecture:** Server emits phase events (`manager:thinking`) during processing and streams AI tokens (`manager:stream_chunk`) over the existing WebSocket. Mobile replaces the 3-dot TypingIndicator with a live Thinking Bubble that shows the current phase + timer, then transitions to streaming text. Claude CLI provider is removed; GLM becomes the default.

**Tech Stack:** TypeScript, Node.js (server), React Native + Zustand (mobile), OpenAI-compatible streaming APIs (GLM/Kimi)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `shared/protocol.ts` | Add 3 new server message types + PhaseInfo type |
| Modify | `server/src/manager/ai-provider.ts` | Remove Claude CLI, add `chatStream()`, set GLM default |
| Modify | `server/src/manager/manager.service.ts` | Add thinking callbacks, streaming flow, phase tracking |
| Modify | `server/src/websocket/ws.handler.ts` | Wire new callbacks to WebSocket sends |
| Modify | `mobile/src/store/managerStore.ts` | Add thinking/streaming state + actions, change default provider |
| Modify | `mobile/src/screens/ManagerChatScreen.tsx` | Replace TypingIndicator with ThinkingBubble, handle streaming, add phase popup |

---

### Task 1: Protocol — Add New Message Types

**Files:**
- Modify: `shared/protocol.ts`

- [ ] **Step 1: Add PhaseInfo type and new server message interfaces**

In `shared/protocol.ts`, after the existing `ManagerMemoryDataMessage` interface (line 269), add:

```typescript
// ── Manager streaming (Server → Client) ──────────────────────────
export interface PhaseInfo {
  phase: string;
  label: string;
  duration: number;
}

export interface ManagerThinkingMessage {
  type: 'manager:thinking';
  payload: { phase: string; detail?: string; elapsed: number };
}

export interface ManagerStreamChunkMessage {
  type: 'manager:stream_chunk';
  payload: { token: string };
}

export interface ManagerStreamEndMessage {
  type: 'manager:stream_end';
  payload: {
    text: string;
    actions?: Array<{ type: string; sessionId: string; detail: string }>;
    phases: PhaseInfo[];
  };
}
```

- [ ] **Step 2: Add new types to ServerMessage union**

In the `ServerMessage` union type (line 271-293), add the three new types:

```typescript
  | ManagerThinkingMessage
  | ManagerStreamChunkMessage
  | ManagerStreamEndMessage;
```

- [ ] **Step 3: Commit**

```bash
git add shared/protocol.ts
git commit -m "feat(protocol): add manager thinking/streaming message types"
```

---

### Task 2: AI Provider — Remove Claude CLI, Add Streaming

**Files:**
- Modify: `server/src/manager/ai-provider.ts`

- [ ] **Step 1: Remove the entire ClaudeProvider class**

Delete lines 26-74 (the `ClaudeProvider` class and its comment header). This removes:
- The `ClaudeProvider` class
- The `spawn`-based CLI chat implementation
- The `which claude` binary detection

Also remove the `import { spawn } from 'child_process';` on line 1 — it's no longer needed.

- [ ] **Step 2: Add `chatStream` to the AiProvider interface**

Update the `AiProvider` interface to include a streaming method:

```typescript
export interface AiProvider {
  id: string;
  name: string;
  isConfigured(): boolean;
  chat(messages: ChatMessage[], systemPrompt: string): Promise<string>;
  chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    onChunk: (token: string) => void,
  ): Promise<string>;
}
```

- [ ] **Step 3: Add `chatStream` to KimiProvider**

Add this method to the `KimiProvider` class, after the existing `chat` method:

```typescript
  async chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    onChunk: (token: string) => void,
  ): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('Kimi API key not configured');

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch(KIMI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: apiMessages,
        temperature: 0.3,
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kimi API error ${res.status}: ${body.slice(0, 200)}`);
    }

    let full = '';
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
            choices: Array<{ delta: { content?: string } }>;
          };
          const token = parsed.choices[0]?.delta?.content;
          if (token) {
            full += token;
            onChunk(token);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    return full;
  }
```

- [ ] **Step 4: Add `chatStream` to GlmProvider**

Add the same streaming method to `GlmProvider`, after its existing `chat` method. The logic is identical except for the endpoint and model:

```typescript
  async chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    onChunk: (token: string) => void,
  ): Promise<string> {
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
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM API error ${res.status}: ${body.slice(0, 200)}`);
    }

    let full = '';
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
            choices: Array<{ delta: { content?: string } }>;
          };
          const token = parsed.choices[0]?.delta?.content;
          if (token) {
            full += token;
            onChunk(token);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    return full;
  }
```

- [ ] **Step 5: Update the AiProviderRegistry constructor — remove Claude, default to GLM**

Replace the constructor of `AiProviderRegistry`:

```typescript
  constructor(config: ProviderConfig) {
    this.config = config;

    const kimi = new KimiProvider(() => this.config.kimiApiKey);
    const glm = new GlmProvider(() => this.config.glmApiKey);

    this.providers.set(kimi.id, kimi);
    this.providers.set(glm.id, glm);

    this.activeId = config.activeProvider && this.providers.has(config.activeProvider)
      ? config.activeProvider
      : 'glm';
    logger.info(`Manager AI: ${this.providers.size} providers registered, active: ${this.activeId}`);
  }
```

Note: The `activeId` fallback handles existing configs that still have `activeProvider: 'claude'` — they'll silently switch to `glm`.

- [ ] **Step 6: Commit**

```bash
git add server/src/manager/ai-provider.ts
git commit -m "feat(ai-provider): remove Claude CLI, add chatStream, default to GLM"
```

---

### Task 3: Manager Service — Phase Tracking + Streaming Flow

**Files:**
- Modify: `server/src/manager/manager.service.ts`

- [ ] **Step 1: Add new callback types and PhaseInfo import**

At the top of the file, after the existing imports, add:

```typescript
import type { PhaseInfo } from '../../../shared/protocol';
```

Then replace the callback type definitions (lines 35-37) with:

```typescript
type SummaryCallback = (summary: ManagerSummary) => void;
type ResponseCallback = (response: ManagerResponse) => void;
type ErrorCallback = (error: string) => void;
type ThinkingCallback = (phase: string, detail?: string, elapsed?: number) => void;
type StreamChunkCallback = (token: string) => void;
type StreamEndCallback = (text: string, actions: ManagerAction[], phases: PhaseInfo[]) => void;
```

- [ ] **Step 2: Add new callback fields and update setCallbacks**

In the `ManagerService` class, after the existing callback fields (lines 285-288), add:

```typescript
  private onThinking: ThinkingCallback | null = null;
  private onStreamChunk: StreamChunkCallback | null = null;
  private onStreamEnd: StreamEndCallback | null = null;
```

Update `setCallbacks` to accept the new callbacks:

```typescript
  setCallbacks(
    onSummary: SummaryCallback,
    onResponse: ResponseCallback,
    onError: ErrorCallback,
    onPersonalityConfigured?: (config: PersonalityConfig) => void,
    onThinking?: ThinkingCallback,
    onStreamChunk?: StreamChunkCallback,
    onStreamEnd?: StreamEndCallback,
  ): void {
    this.onSummary = onSummary;
    this.onResponse = onResponse;
    this.onError = onError;
    if (onPersonalityConfigured) this.onPersonalityConfigured = onPersonalityConfigured;
    if (onThinking) this.onThinking = onThinking;
    if (onStreamChunk) this.onStreamChunk = onStreamChunk;
    if (onStreamEnd) this.onStreamEnd = onStreamEnd;
  }
```

- [ ] **Step 3: Add a phase tracking helper**

Add this private helper method to `ManagerService`, before `handleChat`:

```typescript
  private emitThinking(phase: string, startTime: number, detail?: string): void {
    const elapsed = Date.now() - startTime;
    this.onThinking?.(phase, detail, elapsed);
  }
```

- [ ] **Step 4: Rewrite `handleChat` to use phases and streaming**

Replace the `handleChat` method (lines 561-698) with:

```typescript
  async handleChat(text: string, targetSessionId?: string, onboarding?: boolean): Promise<void> {
    if (!this.enabled) {
      throw new Error('Manager ist nicht aktiv — bitte zuerst aktivieren (grüner Punkt)');
    }

    // Try to execute terminal commands directly (before AI call)
    const directAction = this.tryExecuteCommand(text, targetSessionId ?? undefined);
    if (directAction) {
      this.memory = loadMemory();
      this.memory.recentChat.push({ role: 'user', text, timestamp: Date.now() });
      this.memory.recentChat.push({ role: 'assistant', text: directAction, timestamp: Date.now() });
      this.memory.stats.totalMessages += 2;
      saveMemory(this.memory);
      this.onResponse?.({ text: directAction, actions: [] });
      return;
    }

    const startTime = Date.now();
    const phases: PhaseInfo[] = [];
    let phaseStart = startTime;

    const recordPhase = (phase: string, label: string) => {
      const now = Date.now();
      if (phases.length > 0) {
        phases[phases.length - 1].duration = now - phaseStart;
      }
      phases.push({ phase, label, duration: 0 });
      phaseStart = now;
      this.emitThinking(phase, startTime);
    };

    // Phase 1: Analyze terminals
    recordPhase('analyzing_terminals', 'Terminals analysieren');

    const contexts = this.buildTerminalContexts();
    let contextBlock: string;

    if (targetSessionId) {
      const targetCtx = contexts.find(c => c.sessionId === targetSessionId);
      contextBlock = targetCtx
        ? this.formatContextBlock([targetCtx])
        : `(Terminal ${targetSessionId.slice(0, 8)} hat keinen Output)`;
    } else {
      contextBlock = this.formatContextBlock(contexts);
    }

    const userMessage = `${text}\n\n---\n${contextBlock}`;
    this.chatHistory.push({ role: 'user', content: text });

    // Phase 2: Build context
    recordPhase('building_context', 'Kontext vorbereiten');

    this.memory = loadMemory();
    const memoryIsEmpty = this.memory.user.learnedFacts.length === 0 && !this.memory.user.name;
    const isOnboarding = onboarding && memoryIsEmpty;
    const basePrompt = isOnboarding ? ONBOARDING_PROMPT : buildSystemPrompt(this.personality);
    const memoryContext = buildMemoryContext(this.memory);
    const systemPrompt = `${basePrompt}\n\n${memoryContext}\n\n${MEMORY_UPDATE_INSTRUCTION}`;

    // Phase 3: Call AI
    recordPhase('calling_ai', 'Sende an AI');

    try {
      const provider = this.registry.getActive();
      logger.info(`Manager: streaming chat via ${provider.name}`);

      // Phase 4: Streaming
      recordPhase('streaming', 'Schreibt');

      const reply = await provider.chatStream(
        [...this.chatHistory, { role: 'user', content: onboarding ? text : userMessage }],
        systemPrompt,
        (token) => this.onStreamChunk?.(token),
      );

      // Close last phase duration
      phases[phases.length - 1].duration = Date.now() - phaseStart;

      // Check for personality config (onboarding completion)
      const parsedConfig = parsePersonalityConfig(reply);
      if (parsedConfig) {
        this.personality = parsedConfig;
        this.memory.personality = {
          ...this.memory.personality,
          agentName: parsedConfig.agentName,
          tone: parsedConfig.tone,
          detail: parsedConfig.detail,
          emojis: parsedConfig.emojis,
          proactive: parsedConfig.proactive,
        };
        this.onPersonalityConfigured?.(parsedConfig);
        logger.info(`Manager: onboarding complete — name="${parsedConfig.agentName}", tone=${parsedConfig.tone}`);
      }

      // Parse memory updates from reply
      const memUpdate = parseMemoryUpdate(reply);
      if (memUpdate) {
        if (!parsedConfig && isOnboarding) {
          for (const fact of memUpdate.learnedFacts) {
            const nameMatch = fact.match(/agent\s+(?:heißt|name|nennt?\s+sich)\s+["']?(\w+)/i)
              ?? fact.match(/(?:nenn|heiß)\w*\s+(?:dich|mich|sich)\s+["']?(\w+)/i);
            if (nameMatch) {
              const name = nameMatch[1];
              this.memory.personality.agentName = name;
              this.personality.agentName = name;
              this.onPersonalityConfigured?.({
                ...this.personality,
                agentName: name,
              });
              logger.info(`Manager: auto-detected agent name from memory: "${name}"`);
              break;
            }
          }
        }
        applyMemoryUpdate(this.memory, memUpdate);
        logger.info(`Manager: memory updated — ${memUpdate.learnedFacts.length} facts, ${memUpdate.insights.length} insights`);
      }

      this.memory.recentChat.push({ role: 'user', text, timestamp: Date.now() });
      this.memory.stats.totalMessages += 2;
      this.memory.stats.lastInteraction = new Date().toISOString().slice(0, 10);
      if (!this.memory.stats.firstInteraction) {
        this.memory.stats.firstInteraction = this.memory.stats.lastInteraction;
      }
      saveMemory(this.memory);

      // Parse actions from reply
      const actions = this.parseActions(reply);

      // Phase 5: Execute actions (only if there are any)
      if (actions.length > 0) {
        phaseStart = Date.now();
        recordPhase('executing_actions', 'Befehle ausführen');
        for (const action of actions) {
          this.executeAction(action);
        }
        phases[phases.length - 1].duration = Date.now() - phaseStart;
      }

      // Clean reply
      const cleanReply = stripMemoryTags(
        reply
          .replace(/\[WRITE_TO:[^\]]+\][^[]*\[\/WRITE_TO\]/g, '')
          .replace(/\[SEND_ENTER:[^\]]+\]/g, '')
          .replace(/\[PERSONALITY_CONFIG\][\s\S]*?\[\/PERSONALITY_CONFIG\]/g, '')
      );

      this.chatHistory.push({ role: 'assistant', content: cleanReply });
      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-40);
      }

      this.memory.recentChat.push({ role: 'assistant', text: cleanReply.slice(0, 2000), timestamp: Date.now() });
      saveMemory(this.memory);

      if (this.memory.recentChat.length > MAX_RECENT_CHAT) {
        this.distill().catch(err => logger.warn(`Manager: auto-distill failed — ${err}`));
      }

      const finalText = cleanReply || (parsedConfig
        ? `${parsedConfig.agentName} ist eingerichtet und bereit.`
        : 'Verstanden — ich habe mir alles gemerkt.');

      // Send stream end with phases
      this.onStreamEnd?.(finalText, actions, phases);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manager: chat failed — ${msg}`);
      this.onError?.(`Fehler: ${msg}`);
    }
  }
```

- [ ] **Step 5: Commit**

```bash
git add server/src/manager/manager.service.ts
git commit -m "feat(manager): add phase tracking and streaming to handleChat"
```

---

### Task 4: WebSocket Handler — Wire Streaming Callbacks

**Files:**
- Modify: `server/src/websocket/ws.handler.ts`

- [ ] **Step 1: Update the `manager:toggle` callbacks**

Find the `manager:toggle` handler (around line 342). Update the `setCallbacks` call to include the new callbacks:

Replace:
```typescript
        managerService.setCallbacks(
          (summary) => send(ws, { type: 'manager:summary', payload: summary } as any),
          (response) => send(ws, { type: 'manager:response', payload: response } as any),
          (error) => send(ws, { type: 'manager:error', payload: { message: error } } as any),
          (config) => send(ws, { type: 'manager:personality_configured', payload: config } as any),
        );
```

With:
```typescript
        managerService.setCallbacks(
          (summary) => send(ws, { type: 'manager:summary', payload: summary } as any),
          (response) => send(ws, { type: 'manager:response', payload: response } as any),
          (error) => send(ws, { type: 'manager:error', payload: { message: error } } as any),
          (config) => send(ws, { type: 'manager:personality_configured', payload: config } as any),
          (phase, detail, elapsed) => send(ws, { type: 'manager:thinking', payload: { phase, detail, elapsed } } as any),
          (token) => send(ws, { type: 'manager:stream_chunk', payload: { token } } as any),
          (text, actions, phases) => send(ws, { type: 'manager:stream_end', payload: { text, actions, phases } } as any),
        );
```

- [ ] **Step 2: Update the `manager:chat` callbacks**

Find the `manager:chat` handler (around line 361). Apply the same update to its `setCallbacks` call:

Replace:
```typescript
      managerService.setCallbacks(
        (summary) => send(ws, { type: 'manager:summary', payload: summary } as any),
        (response) => send(ws, { type: 'manager:response', payload: response } as any),
        (error) => send(ws, { type: 'manager:error', payload: { message: error } } as any),
        (config) => send(ws, { type: 'manager:personality_configured', payload: config } as any),
      );
```

With:
```typescript
      managerService.setCallbacks(
        (summary) => send(ws, { type: 'manager:summary', payload: summary } as any),
        (response) => send(ws, { type: 'manager:response', payload: response } as any),
        (error) => send(ws, { type: 'manager:error', payload: { message: error } } as any),
        (config) => send(ws, { type: 'manager:personality_configured', payload: config } as any),
        (phase, detail, elapsed) => send(ws, { type: 'manager:thinking', payload: { phase, detail, elapsed } } as any),
        (token) => send(ws, { type: 'manager:stream_chunk', payload: { token } } as any),
        (text, actions, phases) => send(ws, { type: 'manager:stream_end', payload: { text, actions, phases } } as any),
      );
```

- [ ] **Step 3: Commit**

```bash
git add server/src/websocket/ws.handler.ts
git commit -m "feat(ws): wire thinking/streaming callbacks to WebSocket"
```

---

### Task 5: Zustand Store — Thinking & Streaming State

**Files:**
- Modify: `mobile/src/store/managerStore.ts`

- [ ] **Step 1: Add PhaseInfo type and new state fields**

After the existing `PersonalityConfig` interface (line 49), add:

```typescript
export interface PhaseInfo {
  phase: string;
  label: string;
  duration: number;
}
```

Update the `ManagerState` interface (starting at line 74) — add new fields after `loading`:

```typescript
  /** Current thinking phase (null = not thinking). */
  thinking: { phase: string; detail?: string; elapsed: number } | null;
  /** Accumulated text during streaming. */
  streamingText: string;
  /** Phase info from the last completed response. */
  lastPhases: PhaseInfo[] | null;
```

Add new actions after `setLoading`:

```typescript
  setThinking: (phase: string, detail?: string, elapsed?: number) => void;
  appendStreamChunk: (token: string) => void;
  finishStream: (text: string, actions?: ManagerMessage['actions'], phases?: PhaseInfo[]) => void;
```

- [ ] **Step 2: Initialize new state and implement actions**

In the store's `create` call, add the initial state values after `loading: false`:

```typescript
      thinking: null,
      streamingText: '',
      lastPhases: null,
```

Add the new action implementations after `setLoading`:

```typescript
      setThinking: (phase, detail, elapsed) => set({
        thinking: { phase, detail, elapsed: elapsed ?? 0 },
      }),

      appendStreamChunk: (token) => set((s) => ({
        streamingText: s.streamingText + token,
      })),

      finishStream: (text, actions, phases) => set((s) => {
        const messages = [...s.messages, {
          id: makeId(),
          role: 'assistant' as const,
          text,
          timestamp: Date.now(),
          actions,
        }];
        return {
          messages: messages.slice(-MAX_MESSAGES),
          loading: false,
          thinking: null,
          streamingText: '',
          lastPhases: phases ?? null,
        };
      }),
```

- [ ] **Step 3: Change default activeProvider to 'glm'**

Change line 115 from:
```typescript
      activeProvider: 'claude',
```
to:
```typescript
      activeProvider: 'glm',
```

- [ ] **Step 4: Commit**

```bash
git add mobile/src/store/managerStore.ts
git commit -m "feat(store): add thinking/streaming state and actions, default to GLM"
```

---

### Task 6: Chat Screen — ThinkingBubble + Streaming + Phase Popup

**Files:**
- Modify: `mobile/src/screens/ManagerChatScreen.tsx`

- [ ] **Step 1: Replace TypingIndicator with ThinkingBubble component**

Replace the entire `TypingIndicator` component (lines 77-107) with:

```typescript
// ── Phase Labels ───────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  analyzing_terminals: 'Analysiere Terminals...',
  building_context: 'Bereite Kontext vor...',
  calling_ai: 'Sende an AI...',
  streaming: 'Schreibt...',
  executing_actions: 'Führe Befehle aus...',
};

// ── Thinking Bubble ────────────────────────────────────────────────────────

function ThinkingBubble({ phase, streamingText }: { phase: string; streamingText: string }) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.ease, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 600, easing: Easing.ease, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  const isStreaming = phase === 'streaming' && streamingText.length > 0;
  const label = PHASE_LABELS[phase] ?? phase;

  return (
    <View style={styles.thinkingRow}>
      <View style={styles.thinkingBubble}>
        {!isStreaming && (
          <View style={styles.thinkingHeader}>
            <Animated.View style={[styles.thinkingDot, { opacity: pulse }]} />
            <Text style={styles.thinkingPhase}>{label}</Text>
            <Text style={styles.thinkingTimer}>{elapsed.toFixed(1)}s</Text>
          </View>
        )}
        {isStreaming && (
          <>
            <View style={styles.thinkingHeader}>
              <Animated.View style={[styles.thinkingDot, { opacity: pulse }]} />
              <Text style={styles.thinkingTimer}>{elapsed.toFixed(1)}s</Text>
            </View>
            <Markdown style={mdStyles}>{streamingText}</Markdown>
          </>
        )}
      </View>
    </View>
  );
}
```

- [ ] **Step 2: Add PhasePopup component**

Add this component after the `ThinkingBubble` component:

```typescript
// ── Phase Popup ────────────────────────────────────────────────────────────

function PhasePopup({
  phases,
  provider,
  visible,
  onClose,
}: {
  phases: PhaseInfo[];
  provider: string;
  visible: boolean;
  onClose: () => void;
}) {
  const totalDuration = phases.reduce((sum, p) => sum + p.duration, 0);

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.popupOverlay} onPress={onClose}>
        <View style={styles.popupContent}>
          <Text style={styles.popupTitle}>Verarbeitungsdetails</Text>
          {phases.map((p, i) => (
            <View key={i} style={styles.popupRow}>
              <Text style={styles.popupPhase}>{p.label}</Text>
              <Text style={styles.popupDuration}>{(p.duration / 1000).toFixed(1)}s</Text>
            </View>
          ))}
          <View style={[styles.popupRow, styles.popupTotal]}>
            <Text style={styles.popupTotalLabel}>Gesamt</Text>
            <Text style={styles.popupTotalDuration}>{(totalDuration / 1000).toFixed(1)}s</Text>
          </View>
          <Text style={styles.popupProvider}>Provider: {provider}</Text>
        </View>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 3: Add Modal import**

At the top of the file (line 6), add `Modal` to the react-native imports:

```typescript
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
```

Also add the `PhaseInfo` import from the store:

```typescript
import { useManagerStore, ManagerMessage, PhaseInfo } from '../store/managerStore';
```

- [ ] **Step 4: Wire up new store state and message handlers**

In the component, update the store destructuring (around line 115-120) to include new fields:

```typescript
  const {
    enabled, messages, activeProvider, providers, loading,
    setEnabled, addMessage, addSummary, addResponse, addError,
    setProviders, setLoading, clearMessages, deleteMessage,
    personality, onboarded, setPersonality, setOnboarded,
    thinking, streamingText, lastPhases,
    setThinking, appendStreamChunk, finishStream,
  } = useManagerStore();
```

Add local state for the phase popup, after the existing local state declarations:

```typescript
  const [phasePopupVisible, setPhasePopupVisible] = useState(false);
```

- [ ] **Step 5: Add WebSocket handlers for new message types**

In the `useEffect` message handler (around line 141), add three new cases inside the switch statement, after the existing `manager:` cases:

```typescript
        case 'manager:thinking':
          setThinking(msg.payload.phase, msg.payload.detail, msg.payload.elapsed);
          break;
        case 'manager:stream_chunk':
          appendStreamChunk(msg.payload.token);
          break;
        case 'manager:stream_end':
          finishStream(msg.payload.text, msg.payload.actions, msg.payload.phases);
          break;
```

Update the `useEffect` dependency array to include the new functions:

```typescript
  }, [wsService, addSummary, addResponse, addError, setProviders, setEnabled,
      setThinking, appendStreamChunk, finishStream]);
```

- [ ] **Step 6: Replace TypingIndicator usage with ThinkingBubble**

Find the typing indicator rendering (around line 684-685):

```tsx
      {/* Typing indicator */}
      {loading && <TypingIndicator />}
```

Replace with:

```tsx
      {/* Thinking / Streaming indicator */}
      {thinking && <ThinkingBubble phase={thinking.phase} streamingText={streamingText} />}
```

- [ ] **Step 7: Add phase chip to rendered messages**

In the `renderMessage` function (around line 440), add a phase chip above the message content. Inside the `<View style={[styles.messageBubble, ...]}>` block, before the session chips, add:

```tsx
            {/* Phase duration chip (last response only) */}
            {!isUser && !isSystem && lastPhases && index === filteredMessages.length - 1 && (
              <TouchableOpacity
                style={styles.phaseChip}
                onPress={() => setPhasePopupVisible(true)}
              >
                <Feather name="clock" size={10} color={colors.textMuted} />
                <Text style={styles.phaseChipText}>
                  {(lastPhases.reduce((s, p) => s + p.duration, 0) / 1000).toFixed(1)}s
                </Text>
              </TouchableOpacity>
            )}
```

- [ ] **Step 8: Add PhasePopup render**

At the bottom of the component's return, just before the final `</KeyboardAvoidingView>`, add:

```tsx
      {/* Phase details popup */}
      {lastPhases && (
        <PhasePopup
          phases={lastPhases}
          provider={activeProviderName}
          visible={phasePopupVisible}
          onClose={() => setPhasePopupVisible(false)}
        />
      )}
```

- [ ] **Step 9: Add styles for ThinkingBubble, PhasePopup, and PhaseChip**

Replace the old typing indicator styles (`typingRow`, `typingBubble`, `typingDot` — around lines 984-1004) with:

```typescript
  // Thinking Bubble
  thinkingRow: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  thinkingBubble: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    alignSelf: 'flex-start',
    maxWidth: '85%',
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  thinkingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  thinkingPhase: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    flex: 1,
  },
  thinkingTimer: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    fontFamily: 'monospace',
  },

  // Phase Chip
  phaseChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
  },
  phaseChipText: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },

  // Phase Popup
  popupOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  popupContent: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: spacing.lg,
    width: '80%',
    maxWidth: 320,
  },
  popupTitle: {
    color: colors.text,
    fontSize: fontSizes.md,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  popupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  popupPhase: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  popupDuration: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontFamily: 'monospace',
  },
  popupTotal: {
    borderBottomWidth: 0,
    marginTop: 4,
  },
  popupTotalLabel: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontWeight: '700',
  },
  popupTotalDuration: {
    color: colors.primary,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  popupProvider: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
```

- [ ] **Step 10: Commit**

```bash
git add mobile/src/screens/ManagerChatScreen.tsx
git commit -m "feat(chat): ThinkingBubble with phases, streaming text, phase popup"
```

---

### Task 7: Build & Verify

**Files:** None (verification only)

- [ ] **Step 1: Build the server**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server && npm run build
```

Expected: Clean compilation, no TypeScript errors.

- [ ] **Step 2: Verify no references to Claude provider remain**

```bash
grep -rn "claude\|ClaudeProvider\|which claude" server/src/manager/ --include="*.ts" | grep -v "// " | grep -v ".d.ts"
```

Expected: No matches (except possibly in comments if any — which we should also clean up).

- [ ] **Step 3: Commit any fixes**

If the build reveals issues, fix them and commit:

```bash
git add -A && git commit -m "fix: resolve build issues from streaming implementation"
```

---

### Task 8: Final Cleanup — Remove Stale References

**Files:**
- Modify: `server/src/websocket/ws.handler.ts` (if `claude` referenced in API key handler)

- [ ] **Step 1: Clean up API key handler**

In `ws.handler.ts`, find the `manager:set_api_key` handler (around line 414). There should be no `claude` case there since Claude never used API keys, but verify and clean up if needed.

- [ ] **Step 2: Verify the `manager:response` still works for direct commands**

The `manager:response` message type is still used when `handleChat` detects a direct command (e.g. "Shell 2: git status") and skips the AI call. This path calls `this.onResponse?.(...)` which maps to the existing `manager:response` WebSocket send. Verify this path is intact.

- [ ] **Step 3: Final commit**

```bash
git add -A && git commit -m "chore: clean up stale Claude references and verify direct command path"
```
