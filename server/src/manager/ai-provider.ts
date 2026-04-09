import { spawn } from 'child_process';
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
}

export interface ProviderConfig {
  kimiApiKey?: string;
  glmApiKey?: string;
  activeProvider?: string;
}

// ── Claude Provider (CLI) ───────────────────────────────────────────────────

class ClaudeProvider implements AiProvider {
  id = 'claude';
  name = 'Claude';

  isConfigured(): boolean {
    // Claude CLI must be in PATH — no API key needed (uses local auth)
    try {
      require('child_process').execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
    // Flatten messages into a single prompt for Claude CLI's -p flag
    let prompt = systemPrompt + '\n\n';
    for (const msg of messages) {
      if (msg.role === 'user') prompt += `User: ${msg.content}\n`;
      else if (msg.role === 'assistant') prompt += `Assistant: ${msg.content}\n`;
    }

    return new Promise<string>((resolve, reject) => {
      let output = '';
      let errOutput = '';

      const child = spawn('claude', ['-p', prompt], {
        shell: false,
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { errOutput += data.toString(); });

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          reject(new Error(errOutput || `claude exited with code ${code}`));
        }
      });
    });
  }
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
}

// ── GLM 5.0 Provider (ZhipuAI API) ─────────────────────────────────────────

// Model IDs: verify via GET https://open.bigmodel.cn/api/paas/v4/models with your API key.
// Fallback 'glm-4-plus' is GLM-4. Update to GLM-5 ID once available (e.g. 'glm-5-turbo').
const GLM_MODEL = 'glm-4-plus';

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
}

// ── Provider Registry ───────────────────────────────────────────────────────

export class AiProviderRegistry {
  private providers = new Map<string, AiProvider>();
  private activeId: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;

    const claude = new ClaudeProvider();
    const kimi = new KimiProvider(() => this.config.kimiApiKey);
    const glm = new GlmProvider(() => this.config.glmApiKey);

    this.providers.set(claude.id, claude);
    this.providers.set(kimi.id, kimi);
    this.providers.set(glm.id, glm);

    this.activeId = config.activeProvider ?? 'claude';
    logger.info(`Manager AI: ${this.providers.size} providers registered, active: ${this.activeId}`);
  }

  getActive(): AiProvider {
    return this.providers.get(this.activeId)!;
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
