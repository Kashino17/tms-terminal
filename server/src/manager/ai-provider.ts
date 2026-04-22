import { logger } from '../utils/logger';
import { LmStudioController, type ModelStatusEvent, type ModelStatusListener } from './lmstudio.controller';

export type RegistryModelStatusListener = (providerId: string, ev: ModelStatusEvent) => void;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
}

export interface AiProvider {
  id: string;
  name: string;
  isLocal?: boolean;
  /** Returns true if the provider has the required API key / binary configured. */
  isConfigured(): boolean;
  /** Returns true if this provider supports tool calling. */
  supportsTools(): boolean;
  /** Send chat messages and return the assistant's reply. */
  chat(messages: ChatMessage[], systemPrompt: string): Promise<string>;
  /** Stream chat response, calling onChunk for each token. Returns full text. */
  chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    onChunk: (token: string) => void,
  ): Promise<string>;
}

export interface ProviderConfig {
  kimiApiKey?: string;
  glmApiKey?: string;
  openaiApiKey?: string;
  activeProvider?: string;
  lmStudioUrl?: string;
  /** Override model IDs for local providers. Must match LM Studio's exact identifier
   *  (see `lms ls`). Defaults fall back to common Qwen3 / Gemma 4 names. */
  localModels?: {
    gemma4?: string;
    qwen27b?: string;
    qwen35b?: string;
  };
}

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
  id: string;
  name: string;
  arguments: Record<string, string>;
}

/** Raw tool call object as returned by GLM API (for multi-turn flow) */
export interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface StreamUsage {
  promptTokens?: number;
  completionTokens: number;
  totalTokens?: number;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  /** Raw tool calls for appending to conversation (multi-turn flow) */
  rawToolCalls: RawToolCall[];
  /** Token usage stats (completion tokens counted per chunk, prompt from final chunk if available) */
  usage?: StreamUsage;
}

// ── Kimi K2.5 Provider (OpenAI-compatible API) ─────────────────────────────

// ── Timeout Constants ──────────────────────────────────────────────────────
const CLOUD_TIMEOUT_MS = 60_000;        // 60s for cloud APIs (GLM, Kimi)
const LOCAL_TIMEOUT_MS = 600_000;       // 10min hard ceiling for local non-streaming calls
const LOCAL_IDLE_TIMEOUT_MS = 60_000;   // 60s without any token = treat as hung
const LOCAL_STREAM_HARD_LIMIT_MS = 1_800_000; // 30min absolute cap for a single streaming call
const LOCAL_MAX_OUTPUT_TOKENS = 16_384; // Output budget for local models — bigger than cloud so long generations aren't truncated

/**
 * Creates an AbortSignal that fires if either:
 *   - `hardLimitMs` total elapses since creation, OR
 *   - `idleMs` elapses since the last `touch()` call.
 *
 * Use on streaming LLM calls where "took a while" ≠ "hung". Call `touch()` on
 * every received token so slow-but-progressing responses don't get killed.
 */
function createStreamTimeout(idleMs: number, hardLimitMs: number, userCancel?: AbortSignal): {
  signal: AbortSignal;
  touch: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout;
  let disposed = false;

  const armIdle = () => {
    if (disposed) return;
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`Modell reagiert nicht mehr (${idleMs / 1000}s kein Token). Bitte erneut senden.`));
    }, idleMs);
    idleTimer.unref();
  };

  const hardTimer = setTimeout(() => {
    controller.abort(new Error(`Modell läuft zu lange (>${Math.round(hardLimitMs / 60_000)}min). Bitte erneut senden.`));
  }, hardLimitMs);
  hardTimer.unref();

  if (userCancel) {
    if (userCancel.aborted) controller.abort(userCancel.reason);
    else userCancel.addEventListener('abort', () => controller.abort(userCancel.reason), { once: true });
  }

  armIdle();

  return {
    signal: controller.signal,
    touch: () => {
      if (disposed) return;
      clearTimeout(idleTimer);
      armIdle();
    },
    dispose: () => {
      disposed = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    },
  };
}

// Kimi Code API (kimi.com/code) — NOT the same as Moonshot Open Platform
// sk-kimi-* keys only work on api.kimi.com/coding/v1, not on api.moonshot.ai
const KIMI_ENDPOINT = 'https://api.kimi.com/coding/v1/chat/completions';
const KIMI_MODEL = 'kimi-for-coding';

class KimiProvider implements AiProvider {
  id = 'kimi';
  name = 'Kimi Code';
  private getApiKey: () => string | undefined;

  constructor(getApiKey: () => string | undefined) {
    this.getApiKey = getApiKey;
  }

  isConfigured(): boolean {
    return !!this.getApiKey();
  }

  supportsTools(): boolean { return false; }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
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
      }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kimi API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content ?? '';
  }

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
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
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
}

// ── GLM 5.0 Provider (ZhipuAI API) ─────────────────────────────────────────

// Model IDs: verify via GET https://open.bigmodel.cn/api/paas/v4/models with your API key.
// Fallback 'glm-4-plus' is GLM-4. Update to GLM-5 ID once available (e.g. 'glm-5-turbo').
const GLM_MODEL = 'glm-5-turbo';

class GlmProvider implements AiProvider {
  id = 'glm';
  name = 'GLM 5.0 Turbo';
  private getApiKey: () => string | undefined;

  constructor(getApiKey: () => string | undefined) {
    this.getApiKey = getApiKey;
  }

  isConfigured(): boolean {
    return !!this.getApiKey();
  }

  supportsTools(): boolean { return true; }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
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
      }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content ?? '';
  }

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
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
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

  async chatStreamWithTools(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: (token: string) => void,
    toolChoice: 'auto' | { type: 'function'; function: { name: string } } = 'auto',
    cancelSignal?: AbortSignal,
  ): Promise<StreamResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('GLM API key not configured');

    const apiMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
    ];

    const timeoutSignal = AbortSignal.timeout(CLOUD_TIMEOUT_MS);
    const signal = cancelSignal
      ? AbortSignal.any([timeoutSignal, cancelSignal])
      : timeoutSignal;

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
        tool_choice: toolChoice,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const tcLabel = typeof toolChoice === 'string' ? toolChoice : `forced:${toolChoice.function.name}`;
    logger.info(`GLM API: request sent (${tools.length} tools, ${apiMessages.length} msgs, model=${GLM_MODEL}, tool_choice=${tcLabel})`);

    let fullText = '';
    let completionTokens = 0;
    let promptTokens = 0;
    let totalTokens = 0;
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
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
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = parsed.choices[0]?.delta;

          // Text content
          if (delta?.content) {
            fullText += delta.content;
            completionTokens++;
            onChunk(delta.content);
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { id: '', name: '', args: '' });
              }
              const acc = toolCallAccum.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }

          // Capture usage from final chunk
          if (parsed.usage) {
            if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens;
            if (parsed.usage.completion_tokens) completionTokens = parsed.usage.completion_tokens;
            if (parsed.usage.total_tokens) totalTokens = parsed.usage.total_tokens;
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    // Parse accumulated tool calls
    const toolCalls: ToolCall[] = [];
    const rawToolCalls: RawToolCall[] = [];
    for (const [, acc] of toolCallAccum) {
      if (acc.name && acc.args) {
        try {
          const id = acc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          toolCalls.push({ id, name: acc.name, arguments: JSON.parse(acc.args) });
          rawToolCalls.push({
            id,
            type: 'function',
            function: { name: acc.name, arguments: acc.args },
          });
        } catch {
          logger.warn(`Manager: failed to parse tool call args: ${acc.args.slice(0, 100)}`);
        }
      }
    }

    const usage: StreamUsage = { completionTokens, promptTokens: promptTokens || undefined, totalTokens: totalTokens || undefined };
    return { text: fullText, toolCalls, rawToolCalls, usage };
  }

  /**
   * Second-turn API call: send tool execution results back to GLM.
   * GLM uses these to generate the final natural language response.
   */
  async chatStreamWithToolResults(
    messages: Array<{ role: string; content?: string | null; tool_calls?: RawToolCall[]; tool_call_id?: string }>,
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: (token: string) => void,
  ): Promise<StreamResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('GLM API key not configured');

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
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
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM API error ${res.status}: ${body.slice(0, 200)}`);
    }

    let fullText = '';
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
            fullText += token;
            onChunk(token);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    return { text: fullText, toolCalls: [], rawToolCalls: [] };
  }
}

// ── LM Studio Provider (Gemma 4 via OpenAI-compatible API) ─────────────────

const LMSTUDIO_DEFAULT_URL = 'http://localhost:1234/v1';

class LMStudioProvider implements AiProvider {
  id: string;
  name: string;
  isLocal = true;
  private modelId: string;
  private getBaseUrl: () => string;
  private available: boolean | null = null;

  constructor(id: string, name: string, modelId: string, getBaseUrl: () => string) {
    this.id = id;
    this.name = name;
    this.modelId = modelId;
    this.getBaseUrl = getBaseUrl;
  }

  getModelId(): string {
    return this.modelId;
  }

  isConfigured(): boolean {
    return true; // No API key needed, but might be offline
  }

  supportsTools(): boolean { return true; }

  /** Check if LM Studio is reachable */
  async checkAvailability(): Promise<boolean> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      this.available = res.ok;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
    const baseUrl = this.getBaseUrl();
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer lm-studio',
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: apiMessages,
        temperature: 0.7,
        max_tokens: LOCAL_MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LM Studio error ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content ?? '';
  }

  async chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    onChunk: (token: string) => void,
  ): Promise<string> {
    const baseUrl = this.getBaseUrl();
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const timeout = createStreamTimeout(LOCAL_IDLE_TIMEOUT_MS, LOCAL_STREAM_HARD_LIMIT_MS);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer lm-studio',
        },
        body: JSON.stringify({
          model: this.modelId,
          messages: apiMessages,
          temperature: 0.7,
          max_tokens: LOCAL_MAX_OUTPUT_TOKENS,
          stream: true,
        }),
        signal: timeout.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`LM Studio error ${res.status}: ${body.slice(0, 200)}`);
      }

      let full = '';
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        timeout.touch();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> };
            const token = parsed.choices[0]?.delta?.content;
            if (token) { full += token; onChunk(token); }
          } catch {}
        }
      }
      return full;
    } finally {
      timeout.dispose();
    }
  }

  /** Stream with tool calling support (OpenAI-compatible format) */
  async chatStreamWithTools(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: (token: string) => void,
    toolChoice: 'auto' | { type: 'function'; function: { name: string } } = 'auto',
    cancelSignal?: AbortSignal,
  ): Promise<StreamResult> {
    const baseUrl = this.getBaseUrl();
    const apiMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
    ];

    const timeout = createStreamTimeout(LOCAL_IDLE_TIMEOUT_MS, LOCAL_STREAM_HARD_LIMIT_MS, cancelSignal);

    let fullText = '';
    let completionTokens = 0;
    let promptTokens = 0;
    let totalTokens = 0;
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

    try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer lm-studio',
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: apiMessages,
        temperature: 0.7,
        max_tokens: LOCAL_MAX_OUTPUT_TOKENS,
        stream: true,
        tools,
        tool_choice: toolChoice,
      }),
      signal: timeout.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LM Studio error ${res.status}: ${body.slice(0, 200)}`);
    }

    const tcLabel = typeof toolChoice === 'string' ? toolChoice : `forced:${toolChoice.function.name}`;
    logger.info(`LM Studio API: request sent (${tools.length} tools, ${apiMessages.length} msgs, model=${this.modelId.split('/').pop()}, tool_choice=${tcLabel})`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      timeout.touch();
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
                tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = parsed.choices[0]?.delta;
          if (delta?.content) { fullText += delta.content; completionTokens++; onChunk(delta.content); }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccum.has(idx)) toolCallAccum.set(idx, { id: '', name: '', args: '' });
              const acc = toolCallAccum.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
          if (parsed.usage) {
            if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens;
            if (parsed.usage.completion_tokens) completionTokens = parsed.usage.completion_tokens;
            if (parsed.usage.total_tokens) totalTokens = parsed.usage.total_tokens;
          }
        } catch {}
      }
    }

    const toolCalls: ToolCall[] = [];
    const rawToolCalls: RawToolCall[] = [];
    for (const [, acc] of toolCallAccum) {
      if (acc.name && acc.args) {
        try {
          const id = acc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          toolCalls.push({ id, name: acc.name, arguments: JSON.parse(acc.args) });
          rawToolCalls.push({ id, type: 'function', function: { name: acc.name, arguments: acc.args } });
        } catch {
          logger.warn(`LM Studio: failed to parse tool call args: ${acc.args.slice(0, 100)}`);
        }
      }
    }

    // ── Gemma 4 Fallback: parse native <|tool_call> tags from content ──
    // When LM Studio can't parse Gemma 4's native format, the raw tags
    // end up in fullText instead of tool_calls. Parse them manually.
    if (toolCalls.length === 0 && fullText.includes('<|tool_call>')) {
      const parsed = parseGemma4ToolCalls(fullText);
      if (parsed.length > 0) {
        logger.info(`LM Studio: parsed ${parsed.length} Gemma 4 native tool call(s) from content`);
        for (const p of parsed) {
          toolCalls.push(p);
          rawToolCalls.push({
            id: p.id,
            type: 'function',
            function: { name: p.name, arguments: JSON.stringify(p.arguments) },
          });
        }
        // Strip tool call tags from the text content
        fullText = fullText.replace(/<\|tool_call>.*?<tool_call\|>/gs, '').trim();
      }
    }

    const usage: StreamUsage = { completionTokens, promptTokens: promptTokens || undefined, totalTokens: totalTokens || undefined };
    return { text: fullText, toolCalls, rawToolCalls, usage };
    } finally {
      timeout.dispose();
    }
  }
}

// ── Gemma 4 Native Tool Call Parser ─────────────────────────────────────────

/** Parse Gemma 4's native tool call format from raw text.
 *  Format: <|tool_call>call:function_name{key:<|"|>value<|"|>,key2:123}<tool_call|>
 *  String values use <|"|>...<|"|> delimiters. Numbers/booleans are bare. */
function parseGemma4ToolCalls(text: string): ToolCall[] {
  const results: ToolCall[] = [];
  const pattern = /<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>/gs;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const argsRaw = match[2];
    const args: Record<string, string> = {};

    // Parse key-value pairs from Gemma's format
    // Keys are bare words, values are either <|"|>string<|"|> or bare numbers/booleans
    const kvPattern = /(\w+):\s*(?:<\|"\|>((?:[^<]|<(?!\|"\|>))*)<\|"\|>|([^,}]+))/g;
    let kvMatch: RegExpExecArray | null;
    while ((kvMatch = kvPattern.exec(argsRaw)) !== null) {
      const key = kvMatch[1];
      const value = kvMatch[2] ?? kvMatch[3]?.trim() ?? '';
      args[key] = value;
    }

    const id = `gemma_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    results.push({ id, name, arguments: args });
  }

  return results;
}

// ── Provider Registry ───────────────────────────────────────────────────────

/** Interface for providers that support tool calling (GLM, LM Studio) */
export interface ToolCallingProvider extends AiProvider {
  chatStreamWithTools(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    onChunk: (token: string) => void,
    toolChoice?: 'auto' | { type: 'function'; function: { name: string } },
    cancelSignal?: AbortSignal,
  ): Promise<StreamResult>;
}

export class AiProviderRegistry {
  private providers = new Map<string, AiProvider>();
  private activeId: string;
  private config: ProviderConfig;
  private lmStudio: LmStudioController;
  private onModelStatus: RegistryModelStatusListener | null = null;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.lmStudio = new LmStudioController();

    const kimi = new KimiProvider(() => this.config.kimiApiKey);
    const glm = new GlmProvider(() => this.config.glmApiKey);
    const getUrl = () => this.config.lmStudioUrl ?? LMSTUDIO_DEFAULT_URL;

    // Local models — IDs can be overridden via config.localModels to match
    // whatever is shown by `lms ls` on this machine.
    const gemmaId = config.localModels?.gemma4 ?? 'google/gemma-4-31b';
    const qwen27bId = config.localModels?.qwen27b ?? 'qwen/qwen3-coder-30b';
    const qwen35bId = config.localModels?.qwen35b ?? 'qwen/qwen3.6-35b-a3b';

    const gemma = new LMStudioProvider('gemma-4', 'Gemma 4 31B', gemmaId, getUrl);
    const qwen27b = new LMStudioProvider('qwen-27b', 'Qwen 3 Coder 30B', qwen27bId, getUrl);
    const qwen35b = new LMStudioProvider('qwen-35b', 'Qwen 3.6 35B', qwen35bId, getUrl);

    this.providers.set(kimi.id, kimi);
    this.providers.set(glm.id, glm);
    this.providers.set(gemma.id, gemma);
    this.providers.set(qwen27b.id, qwen27b);
    this.providers.set(qwen35b.id, qwen35b);

    this.activeId = config.activeProvider && this.providers.has(config.activeProvider)
      ? config.activeProvider
      : 'glm';
    logger.info(`Manager AI: ${this.providers.size} providers registered, active: ${this.activeId}`);

    // Check LM Studio availability in background
    gemma.checkAvailability()
      .then((ok) => { if (ok) logger.info(`LM Studio: reachable (active local target: ${gemmaId})`); })
      .catch(() => {});

    // Sync LM Studio state to match the active provider on startup
    const initial = this.providers.get(this.activeId)!;
    if (initial.isLocal && initial instanceof LMStudioProvider) {
      this.lmStudio.switchTo(initial.getModelId(), this.forwardStatus(initial.id)).catch(() => {});
    } else {
      this.lmStudio.unloadAll().catch(() => {});
    }
  }

  /** Register a listener that receives model-load status events. */
  setOnModelStatus(listener: RegistryModelStatusListener | null): void {
    this.onModelStatus = listener;
  }

  private forwardStatus(providerId: string): ModelStatusListener {
    return (ev) => this.onModelStatus?.(providerId, ev);
  }

  getActive(): AiProvider {
    return this.providers.get(this.activeId)!;
  }

  /** Get the active provider as a ToolCallingProvider if it supports tools */
  getActiveWithTools(): ToolCallingProvider | null {
    const active = this.getActive();
    if (active.supportsTools() && 'chatStreamWithTools' in active) {
      return active as ToolCallingProvider;
    }
    return null;
  }

  setActive(id: string): void {
    if (!this.providers.has(id)) throw new Error(`Unknown provider: ${id}`);
    this.activeId = id;
    this.config.activeProvider = id;
    logger.info(`Manager AI: switched to ${id}`);

    // Auto load/kill: when switching to a local provider load it and unload
    // every other LM Studio model; when switching to a cloud provider unload
    // all local models so VRAM is freed.
    const provider = this.providers.get(id)!;
    if (provider.isLocal && provider instanceof LMStudioProvider) {
      this.lmStudio.switchTo(provider.getModelId(), this.forwardStatus(provider.id)).catch(() => {});
    } else {
      this.lmStudio.unloadAll().catch(() => {});
    }
  }

  getActiveId(): string {
    return this.activeId;
  }

  list(): Array<{ id: string; name: string; configured: boolean; isLocal?: boolean }> {
    return [...this.providers.values()].map(p => ({
      id: p.id,
      name: p.name,
      configured: p.isConfigured(),
      isLocal: p.isLocal,
    }));
  }

  updateConfig(updates: Partial<ProviderConfig>): void {
    if (updates.kimiApiKey !== undefined) this.config.kimiApiKey = updates.kimiApiKey;
    if (updates.glmApiKey !== undefined) this.config.glmApiKey = updates.glmApiKey;
    if (updates.openaiApiKey !== undefined) this.config.openaiApiKey = updates.openaiApiKey;
    if (updates.activeProvider !== undefined) this.setActive(updates.activeProvider);
  }

  getOpenaiApiKey(): string | undefined {
    return this.config.openaiApiKey;
  }

  /** Get ordered list of fallback providers (configured, non-local, not active) */
  getFallbackOrder(): AiProvider[] {
    const activeId = this.activeId;
    return [...this.providers.values()].filter(p =>
      p.id !== activeId && p.isConfigured() && !p.isLocal
    );
  }
}
