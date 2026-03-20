import { spawn } from 'child_process';
import { logger } from '../utils/logger';

export interface AutopilotItem {
  id: string;
  text: string;
  optimizedPrompt?: string;
  status: 'draft' | 'optimizing' | 'queued' | 'running' | 'done' | 'error';
  error?: string;
  completedAt?: number;
}

type OptimizeCallback = (id: string, result: { prompt?: string; error?: string }) => void;
type PromptSentCallback = (sessionId: string, itemId: string) => void;
type PromptDoneCallback = (sessionId: string, itemId: string) => void;

export class AutopilotService {
  // Per-session queue
  private queues = new Map<string, AutopilotItem[]>();
  // Per-session enabled flag
  private enabled = new Map<string, boolean>();
  // Track which session is currently running a prompt
  private runningItem = new Map<string, string | null>(); // sessionId -> itemId
  // Callbacks
  private onPromptSent: PromptSentCallback | null = null;
  private onPromptDone: PromptDoneCallback | null = null;

  setCallbacks(onSent: PromptSentCallback, onDone: PromptDoneCallback): void {
    this.onPromptSent = onSent;
    this.onPromptDone = onDone;
  }

  getQueue(sessionId: string): AutopilotItem[] {
    return this.queues.get(sessionId) ?? [];
  }

  addItem(sessionId: string, item: AutopilotItem): void {
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(item);
    this.queues.set(sessionId, queue);
  }

  removeItem(sessionId: string, itemId: string): void {
    const queue = this.queues.get(sessionId) ?? [];
    this.queues.set(sessionId, queue.filter(i => i.id !== itemId));
  }

  updateItem(sessionId: string, itemId: string, updates: Partial<AutopilotItem>): void {
    const queue = this.queues.get(sessionId) ?? [];
    const idx = queue.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      queue[idx] = { ...queue[idx], ...updates };
    }
  }

  reorderQueue(sessionId: string, itemIds: string[]): void {
    const queue = this.queues.get(sessionId) ?? [];
    const ordered: AutopilotItem[] = [];
    for (const id of itemIds) {
      const item = queue.find(i => i.id === id);
      if (item) ordered.push(item);
    }
    // Add any items not in the reorder list at the end
    for (const item of queue) {
      if (!itemIds.includes(item.id)) ordered.push(item);
    }
    this.queues.set(sessionId, ordered);
  }

  setEnabled(sessionId: string, on: boolean): void {
    this.enabled.set(sessionId, on);
  }

  isEnabled(sessionId: string): boolean {
    return this.enabled.get(sessionId) ?? false;
  }

  /**
   * Optimize To-Do items using Claude CLI.
   * Spawns `claude -p "prompt"` in the project directory.
   * Calls onResult for each item with the optimized prompt or error.
   */
  async optimizeItems(
    items: { id: string; text: string }[],
    cwd: string,
    onResult: OptimizeCallback,
  ): Promise<void> {
    for (const item of items) {
      try {
        const prompt = `You are helping prepare tasks for an AI coding assistant. Analyze the current project in this directory and reformulate the following To-Do as a precise, comprehensive prompt that an AI CLI tool (like Claude Code) can execute directly. The prompt should be specific, actionable, and reference relevant files/patterns from the project where helpful. Respond ONLY with the optimized prompt text, no explanations or formatting.\n\nTo-Do: "${item.text}"`;

        logger.info(`Autopilot: optimizing "${item.text.slice(0, 50)}..." in ${cwd}`);

        const result = await new Promise<string>((resolve, reject) => {
          let output = '';
          let errOutput = '';

          const child = spawn('claude', ['-p', prompt], {
            cwd,
            shell: true,
            timeout: 120_000, // 2 min timeout
            env: { ...process.env },
          });

          child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
          child.stderr?.on('data', (data: Buffer) => { errOutput += data.toString(); });

          child.on('error', (err) => reject(err));
          child.on('close', (code) => {
            if (code === 0 && output.trim()) {
              resolve(output.trim());
            } else {
              reject(new Error(errOutput || `claude exited with code ${code}`));
            }
          });
        });

        onResult(item.id, { prompt: result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Autopilot: optimize failed for "${item.text.slice(0, 30)}": ${msg}`);
        onResult(item.id, { error: msg });
      }
    }
  }

  /**
   * Called by the idle detector when a terminal has been idle for 60s.
   * Checks if the session has an active queue and sends the next prompt.
   * Returns the prompt text to write to the PTY, or null if nothing to send.
   */
  tryDequeuePrompt(sessionId: string): { itemId: string; prompt: string } | null {
    if (!this.isEnabled(sessionId)) return null;
    if (this.runningItem.get(sessionId)) return null; // already running one

    const queue = this.queues.get(sessionId) ?? [];
    const next = queue.find(i => i.status === 'queued');
    if (!next || !next.optimizedPrompt) return null;

    next.status = 'running';
    this.runningItem.set(sessionId, next.id);
    this.onPromptSent?.(sessionId, next.id);
    logger.info(`Autopilot: sending prompt "${next.optimizedPrompt.slice(0, 50)}..." to session ${sessionId.slice(0, 8)}`);
    return { itemId: next.id, prompt: next.optimizedPrompt };
  }

  /**
   * Called when a terminal that was running a prompt becomes idle again.
   * Marks the current item as done.
   */
  markCurrentDone(sessionId: string): void {
    const itemId = this.runningItem.get(sessionId);
    if (!itemId) return;

    const queue = this.queues.get(sessionId) ?? [];
    const item = queue.find(i => i.id === itemId);
    if (item) {
      item.status = 'done';
      item.completedAt = Date.now();
    }
    this.runningItem.set(sessionId, null);
    this.onPromptDone?.(sessionId, itemId);
    logger.info(`Autopilot: prompt done for session ${sessionId.slice(0, 8)}`);
  }

  clearSession(sessionId: string): void {
    this.queues.delete(sessionId);
    this.enabled.delete(sessionId);
    this.runningItem.delete(sessionId);
  }
}

export const autopilotService = new AutopilotService();
