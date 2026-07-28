import type { AgendaItem } from './agenda.types';
import { dueReminders, type DueReminder } from './agenda.time';
import { logger } from '../../utils/logger';

const TICK_MS = 60_000;
/** Reminders missed while the server was down are caught up within this window. */
export const CATCH_UP_MS = 12 * 60 * 60 * 1000;
/** How far back reconcile looks when retiring reminders it will never fire. */
const RETIRE_FLOOR_MS = 365 * 24 * 60 * 60 * 1000;
/** A reminder more than this late is announced as "verspätet". */
const LATE_THRESHOLD_MS = 5 * 60_000;

/**
 * Fires due reminders once a minute. Deliberately model-free: reminders must
 * still work when no provider is reachable — that is the whole point of keeping
 * collecting and judging apart.
 */
export class AgendaScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private started = false;

  constructor(
    private readonly now: () => number,
    private readonly load: () => AgendaItem[],
    private readonly save: (items: AgendaItem[]) => void,
    private readonly onFire: (due: DueReminder, late: boolean) => void,
    private readonly catchUpMs: number = CATCH_UP_MS,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    const now = this.now();
    this.retireOlderThan(now - this.catchUpMs);
    this.lastTickAt = now - this.catchUpMs;
    this.tick();

    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    logger.info('[agenda] scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** Fire everything due in (lastTickAt, now]. Public so tests can crank it. */
  tick(): void {
    const now = this.now();
    const items = this.load();
    const due = dueReminders(items, now, this.lastTickAt);

    for (const d of due) {
      d.reminder.firedFor = d.occurrenceAt;
      const late = now - d.dueAt > LATE_THRESHOLD_MS;
      try {
        this.onFire(d, late);
      } catch (err) {
        // One bad handler must not stop the remaining reminders.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[agenda] reminder handler failed for "${d.item.title}": ${msg}`);
      }
    }

    this.lastTickAt = now;
    if (due.length > 0) this.save(items);
  }

  /**
   * Mark everything due before `before` as fired WITHOUT firing it. Without this,
   * a week of downtime would greet the user with dozens of stale reminders.
   */
  private retireOlderThan(before: number): void {
    const items = this.load();
    const stale = dueReminders(items, before, before - RETIRE_FLOOR_MS);
    for (const d of stale) d.reminder.firedFor = d.occurrenceAt;
    if (stale.length > 0) {
      logger.info(`[agenda] retired ${stale.length} reminder(s) older than the catch-up window`);
      this.save(items);
    }
  }
}
