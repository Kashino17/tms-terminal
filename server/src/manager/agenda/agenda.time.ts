import type { AgendaItem, AgendaReminder } from './agenda.types';

export interface WallTime {
  year: number; month: number; day: number; hour: number; minute: number;
}

export interface Occurrence {
  /** Epoch ms of this occurrence, resolved in the item's effective zone. */
  at: number;
  /** Wall-clock identity, e.g. "2026-08-04T08:00". Stable across timezone changes. */
  key: string;
}

export interface DueReminder {
  item: AgendaItem;
  reminder: AgendaReminder;
  /** Epoch ms at which this reminder should fire. */
  dueAt: number;
  /** Epoch ms of the occurrence it belongs to. */
  occurrenceAt: number;
  /** Wall-clock identity of that occurrence — what gets written to firedFor. */
  occurrenceKey: string;
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

export function formatWallTime(w: WallTime): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

/**
 * Offset of `tz` from UTC at a given instant, in milliseconds.
 * Uses Intl rather than a dependency: format the instant in the target zone,
 * read the components back, and see how far they are from UTC.
 */
function zoneOffsetAt(epochMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (type: string): number => {
    const found = parts.find(p => p.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  // hour12:false can render midnight as "24" in some ICU versions.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - epochMs;
}

/**
 * Local wall time → epoch ms.
 *
 * Without `tz` this uses the machine's own zone, which is what a floating
 * appointment means: 14:00 is 14:00 wherever the laptop currently is.
 *
 * With `tz` the wall time is resolved in that zone instead, so an appointment
 * anchored to Europe/Berlin stays Berlin time while the user is elsewhere.
 *
 * Either way the Date/Intl machinery applies the correct DST rules, and times
 * that do not exist (spring forward) normalise forward by an hour.
 */
export function wallTimeToEpoch(w: WallTime, tz?: string): number {
  if (tz === undefined) {
    return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0).getTime();
  }
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0);
  const firstGuess = asIfUtc - zoneOffsetAt(asIfUtc, tz);
  // A second pass settles DST boundaries, where the offset at the guessed
  // instant differs from the offset we started with.
  const refined = asIfUtc - zoneOffsetAt(firstGuess, tz);
  return refined;
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. Pure calendar maths —
  // reading local components of a locally-built date is timezone-independent.
  return new Date(year, month, 0).getDate();
}

/**
 * Next occurrence at or after `afterMs`, with its stable wall-clock identity.
 * Returns null when a one-off has already passed.
 */
export function nextOccurrenceDetail(item: AgendaItem, afterMs: number): Occurrence | null {
  const w = parseWallTime(item.at);
  if (w === null) return null;
  const tz = item.tz;

  if (item.repeat === 'none') {
    const at = wallTimeToEpoch(w, tz);
    return at >= afterMs ? { at, key: formatWallTime(w) } : null;
  }

  if (item.repeat === 'daily' || item.repeat === 'weekly') {
    const stepDays = item.repeat === 'daily' ? 1 : 7;
    // Step in whole calendar days rather than fixed milliseconds, so a DST
    // change shifts the real duration instead of the wall-clock time.
    const cur: WallTime = { ...w };
    let at = wallTimeToEpoch(cur, tz);
    for (let i = 0; i < MAX_DAY_STEPS && at < afterMs; i++) {
      const stepped = new Date(cur.year, cur.month - 1, cur.day + stepDays, cur.hour, cur.minute, 0, 0);
      cur.year = stepped.getFullYear();
      cur.month = stepped.getMonth() + 1;
      cur.day = stepped.getDate();
      at = wallTimeToEpoch(cur, tz);
    }
    return at >= afterMs ? { at, key: formatWallTime(cur) } : null;
  }

  if (item.repeat === 'monthly') {
    let year = w.year;
    let month = w.month;
    for (let i = 0; i < MAX_MONTHS; i++) {
      const day = Math.min(w.day, daysInMonth(year, month));
      const candidate: WallTime = { ...w, year, month, day };
      const at = wallTimeToEpoch(candidate, tz);
      if (at >= afterMs) return { at, key: formatWallTime(candidate) };
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
    const candidate: WallTime = { ...w, year, day };
    const at = wallTimeToEpoch(candidate, tz);
    if (at >= afterMs) return { at, key: formatWallTime(candidate) };
    year++;
  }
  return null;
}

/** Convenience wrapper for callers that only need the timestamp. */
export function nextOccurrence(item: AgendaItem, afterMs: number): number | null {
  return nextOccurrenceDetail(item, afterMs)?.at ?? null;
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
      // A bogus tz makes Intl throw. One bad appointment must not take the whole
      // alarm clock down with it — every other reminder still has to fire.
      let occurrence: Occurrence | null;
      try {
        occurrence = nextOccurrenceDetail(item, windowStartMs + offsetMs + 1);
      } catch {
        continue;
      }
      if (occurrence === null) continue;
      if (reminder.firedFor === occurrence.key) continue;

      const dueAt = occurrence.at - offsetMs;
      if (dueAt > nowMs) continue;

      out.push({
        item, reminder, dueAt,
        occurrenceAt: occurrence.at,
        occurrenceKey: occurrence.key,
      });
    }
  }

  return out.sort((a, b) => a.dueAt - b.dueAt);
}
