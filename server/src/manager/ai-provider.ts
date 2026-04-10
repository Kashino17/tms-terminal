import { logger } from '../utils/logger';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiProvider {
  id: string;
  name: string;
  /** Returns true if the provider has the required API key / binary configured. */
  isConfigured(): boolean;
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
  activeProvider?: string;
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
  name: string;
  arguments: Record<string, string>;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
}

// ── Kimi K2.5 Provider (OpenAI-compatible API) ─────────────────────────────

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
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : 'none',
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
}

// ── Provider Registry ───────────────────────────────────────────────────────

export class AiProviderRegistry {
  private providers = new Map<string, AiProvider>();
  private activeId: string;
  private config: ProviderConfig;

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

  getActive(): AiProvider {
    return this.providers.get(this.activeId)!;
  }

  getActiveAsGlm(): GlmProvider | null {
    const active = this.getActive();
    return active.id === 'glm' ? (active as GlmProvider) : null;
  }

  setActive(id: string): void {
    if (!this.providers.has(id)) throw new Error(`Unknown provider: ${id}`);
    this.activeId = id;
    this.config.activeProvider = id;
    logger.info(`Manager AI: switched to ${id}`);
  }

  getActiveId(): string {
    return this.activeId;
  }

  list(): Array<{ id: string; name: string; configured: boolean }> {
    return [...this.providers.values()].map(p => ({
      id: p.id,
      name: p.name,
      configured: p.isConfigured(),
    }));
  }

  updateConfig(updates: Partial<ProviderConfig>): void {
    if (updates.kimiApiKey !== undefined) this.config.kimiApiKey = updates.kimiApiKey;
    if (updates.glmApiKey !== undefined) this.config.glmApiKey = updates.glmApiKey;
    if (updates.activeProvider !== undefined) this.setActive(updates.activeProvider);
  }
}
