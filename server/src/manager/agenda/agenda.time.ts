import type { AgendaItem, AgendaReminder } from './agenda.types';

export interface WallTime {
  year: number; month: number; day: number; hour: number; minute: number;
}

export interface DueReminder {
  item: AgendaItem;
  reminder: AgendaReminder;
  /** Epoch ms at which this reminder should fire. */
  dueAt: number;
  /** Epoch ms of the occurrence it belongs to. */
  occurrenceAt: number;
}

const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Loop guards — an appointment further out than this is not worth chasing. */
const MAX_YEARS = 400;
const MAX_MONTHS = 1200;
const MAX_DAY_STEPS = 4000;

export function parseWallTime(at: string): WallTime | null {
  const m = AT_RE.exec(at);
  if (!m) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]),
  };
}

/**
 * Local wall time → epoch ms.
 * The Date constructor applies the machine's DST rules, which is exactly what we
 * want: "14:00" means 14:00 on the clock on the wall, whatever the offset is that
 * day. Times that do not exist (spring forward) normalise forward by an hour.
 */
export function wallTimeToEpoch(w: WallTime): number {
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0).getTime();
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month, 0).getDate();
}

/** Next occurrence at or after `afterMs`, or null when a one-off has passed. */
export function nextOccurrence(item: AgendaItem, afterMs: number): number | null {
  const w = parseWallTime(item.at);
  if (w === null) return null;

  if (item.repeat === 'none') {
    const t = wallTimeToEpoch(w);
    return t >= afterMs ? t : null;
  }

  if (item.repeat === 'daily' || item.repeat === 'weekly') {
    const stepDays = item.repeat === 'daily' ? 1 : 7;
    // Step in whole calendar days rather than fixed milliseconds, so a DST
    // change shifts the real duration instead of the wall-clock time.
    const cur: WallTime = { ...w };
    let t = wallTimeToEpoch(cur);
    for (let i = 0; i < MAX_DAY_STEPS && t < afterMs; i++) {
      const stepped = new Date(cur.year, cur.month - 1, cur.day + stepDays, cur.hour, cur.minute, 0, 0);
      cur.year = stepped.getFullYear();
      cur.month = stepped.getMonth() + 1;
      cur.day = stepped.getDate();
      t = stepped.getTime();
    }
    return t >= afterMs ? t : null;
  }

  if (item.repeat === 'monthly') {
    let year = w.year;
    let month = w.month;
    for (let i = 0; i < MAX_MONTHS; i++) {
      const day = Math.min(w.day, daysInMonth(year, month));
      const t = wallTimeToEpoch({ ...w, year, month, day });
      if (t >= afterMs) return t;
      month++;
      if (month > 12) { month = 1; year++; }
    }
    return null;
  }

  // yearly
  let year = w.year;
  for (let i = 0; i < MAX_YEARS; i++) {
    // 29 February in a non-leap year clamps to the 28th rather than vanishing.
    const day = Math.min(w.day, daysInMonth(year, w.month));
    const t = wallTimeToEpoch({ ...w, year, day });
    if (t >= afterMs) return t;
    year++;
  }
  return null;
}

/**
 * Every reminder whose firing time falls in (windowStartMs, nowMs].
 *
 * A reminder with offset o fires at occurrence - o, so we look for the next
 * occurrence at or after windowStart + o. That is what lets a "two days before"
 * reminder be found while the appointment itself is still two days away.
 */
export function dueReminders(
  items: AgendaItem[],
  nowMs: number,
  windowStartMs: number,
): DueReminder[] {
  const out: DueReminder[] = [];

  for (const item of items) {
    if (parseWallTime(item.at) === null) continue; // skip malformed, never throw

    for (const reminder of item.reminders) {
      const offsetMs = reminder.offsetMinutes * 60_000;
      const occurrenceAt = nextOccurrence(item, windowStartMs + offsetMs + 1);
      if (occurrenceAt === null) continue;
      if (reminder.firedFor === occurrenceAt) continue;

      const dueAt = occurrenceAt - offsetMs;
      if (dueAt > nowMs) continue;

      out.push({ item, reminder, dueAt, occurrenceAt });
    }
  }

  return out.sort((a, b) => a.dueAt - b.dueAt);
}
