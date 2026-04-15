import { ChromeTab, TAB_POLL_INTERVAL } from './chrome.types';
import { logger } from '../utils/logger';

type TabCallback = (event: TabEvent) => void;

export type TabEvent =
  | { type: 'created'; tab: ChromeTab }
  | { type: 'removed'; targetId: string }
  | { type: 'updated'; targetId: string; title?: string; url?: string };

export class ChromeTabWatcher {
  private knownTabs = new Map<string, ChromeTab>();
  private pollTimer: NodeJS.Timeout | null = null;
  private callback: TabCallback | null = null;

  constructor(private client: any) {}

  start(callback: TabCallback): void {
    this.callback = callback;
    this.pollTimer = setInterval(() => this.poll(), TAB_POLL_INTERVAL);
    this.poll();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.callback = null;
    this.knownTabs.clear();
  }

  getTabs(): ChromeTab[] {
    return Array.from(this.knownTabs.values());
  }

  private async poll(): Promise<void> {
    try {
      const targets = await this.client.Target.getTargets();
      const pageTabs = targets.targetInfos.filter(
        (t: any) => t.type === 'page' && !t.url.startsWith('devtools://'),
      );

      const currentIds = new Set<string>();

      for (const target of pageTabs) {
        currentIds.add(target.targetId);
        const existing = this.knownTabs.get(target.targetId);

        if (!existing) {
          const tab: ChromeTab = { targetId: target.targetId, title: target.title, url: target.url };
          this.knownTabs.set(target.targetId, tab);
          this.callback?.({ type: 'created', tab });
        } else {
          const titleChanged = existing.title !== target.title;
          const urlChanged = existing.url !== target.url;
          if (titleChanged || urlChanged) {
            existing.title = target.title;
            existing.url = target.url;
            this.callback?.({
              type: 'updated', targetId: target.targetId,
              title: titleChanged ? target.title : undefined,
              url: urlChanged ? target.url : undefined,
            });
          }
        }
      }

      for (const [targetId] of this.knownTabs) {
        if (!currentIds.has(targetId)) {
          this.knownTabs.delete(targetId);
          this.callback?.({ type: 'removed', targetId });
        }
      }
    } catch (err) {
      logger.warn(`[chrome:tabs] poll failed: ${err}`);
    }
  }
}
