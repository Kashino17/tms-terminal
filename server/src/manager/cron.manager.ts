import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const CRON_FILE = path.join(CONFIG_DIR, 'cron-jobs.json');

// ── Types ───────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression
  type: 'simple' | 'claude';
  command: string;
  targetDir?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: string;
}

// ── Cron Expression Helpers ─────────────────────────────────────────────────

/**
 * Parse a cron expression to milliseconds interval.
 * Supported patterns:
 *   * /N * * * *   → every N minutes
 *   0 * /N * * *   → every N hours
 *   0 0 * * *      → daily (24h)
 *   0 0 * * N      → weekly (7 days)
 */
export function cronToMs(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return 0;

  const [minute, hour, _dom, _month, dow] = parts;

  // */N * * * * → every N minutes
  const everyMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') {
    return parseInt(everyMinMatch[1], 10) * 60 * 1000;
  }

  // 0 */N * * * → every N hours
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (minute === '0' && everyHourMatch) {
    return parseInt(everyHourMatch[1], 10) * 60 * 60 * 1000;
  }

  // 0 0 * * N → weekly (specific day of week)
  if (minute === '0' && hour === '0' && _dom === '*' && _month === '*' && dow !== '*') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  // 0 0 * * * → daily
  if (minute === '0' && hour === '0' && _dom === '*' && _month === '*' && dow === '*') {
    return 24 * 60 * 60 * 1000;
  }

  // 0 N * * * → once a day at hour N (treat as daily)
  if (minute === '0' && /^\d+$/.test(hour) && _dom === '*' && _month === '*' && dow === '*') {
    return 24 * 60 * 60 * 1000;
  }

  // Fallback: N * * * * → every hour at minute N (treat as hourly)
  if (/^\d+$/.test(minute) && hour === '*') {
    return 60 * 60 * 1000;
  }

  return 0;
}

/**
 * Human-readable German label for a cron expression.
 */
export function cronToLabel(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [minute, hour, _dom, _month, dow] = parts;

  // */N * * * * → Alle N Minuten
  const everyMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? 'Jede Minute' : `Alle ${n} Minuten`;
  }

  // 0 */N * * * → Alle N Stunden
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (minute === '0' && everyHourMatch) {
    const n = parseInt(everyHourMatch[1], 10);
    return n === 1 ? 'Stündlich' : `Alle ${n} Stunden`;
  }

  // 0 0 * * N → Wöchentlich
  const dayNames: Record<string, string> = {
    '0': 'Sonntag', '1': 'Montag', '2': 'Dienstag', '3': 'Mittwoch',
    '4': 'Donnerstag', '5': 'Freitag', '6': 'Samstag', '7': 'Sonntag',
  };
  if (minute === '0' && hour === '0' && _dom === '*' && _month === '*' && dow !== '*') {
    const dayName = dayNames[dow] ?? `Tag ${dow}`;
    return `Wöchentlich (${dayName})`;
  }

  // 0 0 * * * → Täglich
  if (minute === '0' && hour === '0' && _dom === '*' && _month === '*' && dow === '*') {
    return 'Täglich (Mitternacht)';
  }

  // 0 N * * * → Täglich um N Uhr
  if (minute === '0' && /^\d+$/.test(hour) && _dom === '*' && _month === '*' && dow === '*') {
    return `Täglich um ${hour}:00`;
  }

  return schedule;
}

// ── CronManager ─────────────────────────────────────────────────────────────

export class CronManager {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private executeCallback: ((job: CronJob) => void) | null = null;

  setExecuteCallback(cb: (job: CronJob) => void): void {
    this.executeCallback = cb;
  }

  load(): void {
    try {
      if (fs.existsSync(CRON_FILE)) {
        const raw = fs.readFileSync(CRON_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const jobList: CronJob[] = data.jobs ?? [];
        for (const job of jobList) {
          this.jobs.set(job.id, job);
          if (job.enabled) {
            this.scheduleJob(job);
          }
        }
        logger.info(`CronManager: loaded ${jobList.length} jobs (${jobList.filter(j => j.enabled).length} enabled)`);
      } else {
        logger.info('CronManager: no cron-jobs.json found, starting fresh');
      }
    } catch (err) {
      logger.warn(`CronManager: failed to load — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  save(): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      const jobList = [...this.jobs.values()];
      const data = JSON.stringify({ jobs: jobList }, null, 2);
      const tmpFile = CRON_FILE + '.tmp';
      fs.writeFileSync(tmpFile, data, 'utf-8');
      fs.renameSync(tmpFile, CRON_FILE);
    } catch (err) {
      logger.warn(`CronManager: failed to save — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  addJob(job: CronJob): void {
    this.jobs.set(job.id, job);
    if (job.enabled) {
      this.scheduleJob(job);
    }
    this.save();
    logger.info(`CronManager: added job "${job.name}" (${job.id}) schedule=${job.schedule} type=${job.type}`);
  }

  removeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.jobs.delete(id);
    this.save();
    logger.info(`CronManager: removed job "${job.name}" (${id})`);
    return true;
  }

  toggleJob(id: string, enabled: boolean): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.enabled = enabled;
    if (enabled) {
      this.scheduleJob(job);
    } else {
      const timer = this.timers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    }
    this.save();
    logger.info(`CronManager: toggled job "${job.name}" (${id}) → enabled=${enabled}`);
    return job;
  }

  listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  getJob(id: string): CronJob | null {
    return this.jobs.get(id) ?? null;
  }

  updateJobResult(id: string, result: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lastRunAt = Date.now();
    job.lastResult = result.slice(0, 500); // cap result length
    this.save();
  }

  stopAll(): void {
    for (const [_id, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    logger.info('CronManager: all timers stopped');
  }

  scheduleJob(job: CronJob): void {
    // Clear existing timer
    const existing = this.timers.get(job.id);
    if (existing) {
      clearTimeout(existing);
    }

    const intervalMs = cronToMs(job.schedule);
    if (intervalMs <= 0) {
      logger.warn(`CronManager: invalid schedule "${job.schedule}" for job "${job.name}" — not scheduling`);
      return;
    }

    const timer = setTimeout(() => this.executeAndReschedule(job.id), intervalMs);
    timer.unref();
    this.timers.set(job.id, timer);
    logger.info(`CronManager: scheduled "${job.name}" — next run in ${Math.round(intervalMs / 1000)}s`);
  }

  private executeAndReschedule(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;

    logger.info(`CronManager: executing job "${job.name}" (${id})`);

    try {
      if (this.executeCallback) {
        this.executeCallback(job);
      }
      this.updateJobResult(id, 'executed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`CronManager: job "${job.name}" failed — ${msg}`);
      this.updateJobResult(id, `error: ${msg}`);
    }

    // Re-schedule for next run
    this.scheduleJob(job);
  }
}
