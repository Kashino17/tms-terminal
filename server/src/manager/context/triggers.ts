import { logger } from '../../utils/logger';
import type { ProjectFacts } from './collector';
import type { Entry } from '../entries/entries.types';

export type CheckInKind = 'morning' | 'evening';

/** Answer the model gives when it has nothing worth saying. */
export const SILENCE_MARKER = 'NICHTS';

/** How late a check-in may still be delivered after a restart. */
const MAX_LATE_MS = 60 * 60 * 1000;

const STALE_DAYS = 5;

export interface CheckInTime {
  kind: CheckInKind;
  hour: number;
  minute: number;
}

const DEFAULT_TIMES: CheckInTime[] = [
  { kind: 'morning', hour: 8, minute: 30 },
  { kind: 'evening', hour: 19, minute: 0 },
];

/**
 * Fires the two daily check-ins. Keyed by calendar day so a restart cannot
 * cause a second "guten Morgen", and a long outage does not deliver a stale one.
 *
 * Times are read in the machine's own zone on purpose: the user travels, and the
 * morning check-in should arrive in THEIR morning, wherever that is.
 */
export class CheckInScheduler {
  private lastFiredDay = new Map<CheckInKind, string>();

  constructor(
    private readonly now: () => number,
    private readonly onCheckIn: (kind: CheckInKind) => void,
    private readonly times: CheckInTime[] = DEFAULT_TIMES,
  ) {}

  tick(): void {
    const nowMs = this.now();
    const d = new Date(nowMs);
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

    for (const t of this.times) {
      if (this.lastFiredDay.get(t.kind) === dayKey) continue;
      const scheduled = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hour, t.minute, 0, 0).getTime();
      if (nowMs < scheduled) continue;

      // Mark it done either way — a "guten Morgen" at 14:00 is noise, and it
      // must not keep re-evaluating for the rest of the day.
      this.lastFiredDay.set(t.kind, dayKey);
      if (nowMs - scheduled > MAX_LATE_MS) continue;

      try {
        this.onCheckIn(t.kind);
      } catch (err) {
        // One broken handler must not swallow the other check-in.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[checkin] handler for "${t.kind}" failed: ${msg}`);
      }
    }
  }
}

export interface StuckPromptInput {
  sample: string;
  terminalTail: string;
  sessionLabel: string;
  projectPath?: string;
  claudeMdSummary?: string;
}

/**
 * The prompt for the expensive path. Two things in it matter most:
 * exactly ONE suggestion (a list is not help, it is homework), and explicit
 * permission to return nothing — without it a model always invents something.
 */
export function buildStuckPrompt(input: StuckPromptInput): string {
  const parts: string[] = [];
  parts.push(
    `Im Terminal "${input.sessionLabel}" taucht derselbe Fehler wiederholt auf. ` +
    `Schau ihn dir an und überlege, ob dir etwas Konkretes einfällt, das noch nicht probiert wurde.`,
  );
  if (input.projectPath !== undefined) parts.push(`\nProjekt: ${input.projectPath}`);
  parts.push(`\nWiederkehrender Fehler:\n${input.sample}`);
  parts.push(`\nLetzte Terminal-Ausgabe:\n\`\`\`\n${input.terminalTail.slice(-3000)}\n\`\`\``);
  if (input.claudeMdSummary !== undefined) {
    parts.push(`\nAus der CLAUDE.md des Projekts:\n${input.claudeMdSummary}`);
  }
  parts.push(
    `\nAntworte mit **genau einem** konkreten Vorschlag, höchstens drei Sätzen, ` +
    `im Ton "hast du schon X probiert?" — nicht "du hängst fest".\n\n` +
    `Wenn dir nichts wirklich Nützliches einfällt, antworte ausschließlich mit ${SILENCE_MARKER}. ` +
    `Das ist eine gute Antwort und ausdrücklich erwünscht — dann wird gar keine Nachricht verschickt. ` +
    `Rate nicht, nur um etwas zu sagen.`,
  );
  return parts.join('\n');
}

/**
 * Projects nobody has touched in a while that still have open to-dos.
 * Deliberately NOT an interrupting trigger — this only ever surfaces in a
 * check-in, because "you forgot something" is never urgent enough to interrupt.
 */
export function staleProjects(
  projects: ProjectFacts[],
  entries: Entry[],
  nowMs: number,
  staleDays: number = STALE_DAYS,
): ProjectFacts[] {
  const cutoff = nowMs - staleDays * 24 * 60 * 60 * 1000;
  const withOpen = new Set(
    entries
      .filter(e => e.checkable && !e.done && e.project !== undefined)
      .map(e => e.project as string),
  );
  return projects.filter(p => p.lastActivityAt < cutoff && withOpen.has(p.key));
}
