process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgendaItem } from './agenda.types';
import { parseWallTime, nextOccurrence, nextOccurrenceDetail, dueReminders } from './agenda.time';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function item(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id: 'i1', title: 'Test', at: '2026-08-04T14:00', allDay: false,
    repeat: 'none', reminders: [], source: 'user', createdAt: 0, ...over,
  };
}

function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test('parseWallTime accepts the canonical form and rejects junk', () => {
  assert.deepEqual(parseWallTime('2026-08-04T14:00'),
    { year: 2026, month: 8, day: 4, hour: 14, minute: 0 });
  assert.equal(parseWallTime('2026-08-04'), null);
  assert.equal(parseWallTime('2026-08-04T14:00:00Z'), null);
  assert.equal(parseWallTime('garbage'), null);
});

test('a one-off returns its own time, then null once past', () => {
  const it = item({ at: '2026-08-04T14:00' });
  assert.equal(nextOccurrence(it, at(2026, 8, 1)), at(2026, 8, 4, 14, 0));
  assert.equal(nextOccurrence(it, at(2026, 8, 4, 13, 59)), at(2026, 8, 4, 14, 0));
  assert.equal(nextOccurrence(it, at(2026, 8, 4, 14, 1)), null);
});

test('14:00 stays 14:00 across the autumn DST change', () => {
  // Europe/Berlin falls back on 2026-10-25. A daily 14:00 appointment must be
  // 14:00 wall-clock on both sides — not 13:00 or 15:00.
  const it = item({ at: '2026-10-24T14:00', repeat: 'daily' });
  const before = nextOccurrence(it, at(2026, 10, 24))!;
  const after = nextOccurrence(it, at(2026, 10, 26))!;
  assert.equal(new Date(before).getHours(), 14);
  assert.equal(new Date(after).getHours(), 14, 'must still be 14:00 local after DST');
  // The gap is 48h of wall time but 49h of real time — proof DST was applied.
  assert.equal(after - before, 49 * HOUR);
});

test('a 02:30 reminder on the spring-forward night yields a usable time', () => {
  // Europe/Berlin springs forward 2026-03-29: 02:30 local does not exist.
  // It must normalise forward, never produce NaN and never loop forever.
  const it = item({ at: '2026-03-29T02:30', repeat: 'none' });
  const occ = nextOccurrence(it, at(2026, 3, 1));
  assert.notEqual(occ, null);
  assert.equal(Number.isNaN(occ), false);
  assert.equal(new Date(occ!).getHours(), 3, 'non-existent 02:30 normalises to 03:30');
});

test('a yearly 29 February falls back to 28 February in non-leap years', () => {
  const it = item({ at: '2024-02-29T09:00', repeat: 'yearly' });
  const y2027 = nextOccurrence(it, at(2027, 1, 1))!;
  assert.equal(new Date(y2027).getMonth(), 1, 'February');
  assert.equal(new Date(y2027).getDate(), 28, '28th in a non-leap year');
  const y2028 = nextOccurrence(it, at(2028, 1, 1))!;
  assert.equal(new Date(y2028).getDate(), 29, '29th in the leap year 2028');
});

test('a yearly birthday keeps recurring', () => {
  const it = item({ at: '2020-07-30T00:00', allDay: true, repeat: 'yearly' });
  assert.equal(nextOccurrence(it, at(2026, 7, 1)), at(2026, 7, 30));
  assert.equal(nextOccurrence(it, at(2026, 8, 1)), at(2027, 7, 30));
});

test('monthly clamps to the last day of short months', () => {
  const it = item({ at: '2026-01-31T08:00', repeat: 'monthly' });
  const feb = nextOccurrence(it, at(2026, 2, 1))!;
  assert.equal(new Date(feb).getMonth(), 1);
  assert.equal(new Date(feb).getDate(), 28);
});

test('dueReminders finds a two-day-ahead reminder while the appointment is still future', () => {
  const it = item({
    at: '2026-08-04T14:00',
    reminders: [
      { id: 'r2d', offsetMinutes: 2 * 24 * 60 },
      { id: 'r1h', offsetMinutes: 60 },
    ],
  });
  const now = at(2026, 8, 2, 14, 0); // exactly two days before
  const due = dueReminders([it], now, now - 5 * MIN);
  assert.equal(due.length, 1);
  assert.equal(due[0].reminder.id, 'r2d');
  assert.equal(due[0].occurrenceAt, at(2026, 8, 4, 14, 0));
});

test('an already-fired reminder for the same occurrence is not returned again', () => {
  const it = item({
    at: '2026-08-04T14:00',
    reminders: [{ id: 'r1h', offsetMinutes: 60, firedFor: '2026-08-04T14:00' }],
  });
  const now = at(2026, 8, 4, 13, 0);
  assert.equal(dueReminders([it], now, now - 5 * MIN).length, 0);
});

test('a yearly reminder fires again next year despite firedFor from last year', () => {
  const it = item({
    at: '2020-07-30T09:00', repeat: 'yearly',
    reminders: [{ id: 'r0', offsetMinutes: 0, firedFor: '2025-07-30T09:00' }],
  });
  const now = at(2026, 7, 30, 9, 0);
  const due = dueReminders([it], now, now - 5 * MIN);
  assert.equal(due.length, 1, "last year's firedFor must not silence this year");
  assert.equal(due[0].occurrenceAt, at(2026, 7, 30, 9, 0));
});

test('reminders outside the window are not returned', () => {
  const it = item({ at: '2026-08-04T14:00', reminders: [{ id: 'r0', offsetMinutes: 0 }] });
  const tooEarly = at(2026, 8, 4, 13, 0);
  assert.equal(dueReminders([it], tooEarly, tooEarly - 5 * MIN).length, 0, 'not due yet');
  const wayLater = at(2026, 8, 6, 14, 0);
  assert.equal(dueReminders([it], wayLater, wayLater - 5 * MIN).length, 0, 'fell out of the window');
});

test('results are sorted by due time', () => {
  const it = item({
    at: '2026-08-04T14:00',
    reminders: [
      { id: 'late', offsetMinutes: 0 },
      { id: 'early', offsetMinutes: 30 },
    ],
  });
  const now = at(2026, 8, 4, 14, 0);
  const due = dueReminders([it], now, now - 2 * HOUR);
  assert.deepEqual(due.map(d => d.reminder.id), ['early', 'late']);
});

test('an unparseable item is skipped instead of throwing', () => {
  const bad = item({ at: 'kaputt', reminders: [{ id: 'r', offsetMinutes: 0 }] });
  const now = at(2026, 8, 4, 14, 0);
  assert.deepEqual(dueReminders([bad], now, now - DAY), []);
});

// ── Reisen zwischen Zeitzonen ────────────────────────────────────────────────
// Der Nutzer reist viel; die Maschinen-Zeitzone ändert sich also im Betrieb.

test('a floating occurrence keeps its identity when the machine changes timezone', () => {
  const it = item({ at: '2026-08-04T08:00', repeat: 'daily' });
  const from = Date.parse('2026-08-04T00:00:00Z');

  process.env.TZ = 'Asia/Bangkok';
  const bkk = nextOccurrenceDetail(it, from)!;
  process.env.TZ = 'Europe/Berlin';
  const ber = nextOccurrenceDetail(it, from)!;
  process.env.TZ = 'Europe/Berlin'; // leave the suite in a known zone

  assert.notEqual(bkk.at, ber.at, 'the instant does shift — 08:00 local means different moments');
  assert.equal(bkk.key, ber.key, 'but the identity must NOT shift, or it fires twice');
  assert.equal(bkk.key, '2026-08-04T08:00');
});

test('a floating reminder already fired is not repeated after flying west', () => {
  // Fired at 08:00 Bangkok, then the laptop moves to Berlin. Without a stable
  // key the same morning fires a second time five hours later.
  const it = item({
    at: '2026-08-04T08:00', repeat: 'daily',
    reminders: [{ id: 'r0', offsetMinutes: 0, firedFor: '2026-08-04T08:00' }],
  });
  process.env.TZ = 'Europe/Berlin';
  const now = new Date(2026, 7, 4, 8, 0, 0, 0).getTime();
  assert.deepEqual(dueReminders([it], now, now - 6 * HOUR), []);
});

test('an anchored appointment keeps its instant no matter where the laptop is', () => {
  // Dentist booked in Berlin for 14:00. Fly to Bangkok — it must still be
  // 12:00 UTC, i.e. 19:00 Bangkok, not 14:00 Bangkok.
  const it = item({ at: '2026-08-04T14:00', tz: 'Europe/Berlin' });
  const from = Date.parse('2026-08-01T00:00:00Z');

  process.env.TZ = 'Asia/Bangkok';
  const seenFromBangkok = nextOccurrenceDetail(it, from)!;
  process.env.TZ = 'Europe/Berlin';
  const seenFromBerlin = nextOccurrenceDetail(it, from)!;

  assert.equal(seenFromBangkok.at, seenFromBerlin.at, 'anchored = same instant everywhere');
  assert.equal(new Date(seenFromBangkok.at).toISOString(), '2026-08-04T12:00:00.000Z',
    '14:00 Berlin in August is 12:00 UTC');
});

test('an anchored appointment respects DST in ITS zone, not the machine zone', () => {
  // 14:00 Berlin in January is 13:00 UTC (CET), in August 12:00 UTC (CEST).
  const winter = item({ at: '2026-01-15T14:00', tz: 'Europe/Berlin' });
  process.env.TZ = 'Asia/Bangkok';
  const occ = nextOccurrenceDetail(winter, Date.parse('2026-01-01T00:00:00Z'))!;
  process.env.TZ = 'Europe/Berlin';
  assert.equal(new Date(occ.at).toISOString(), '2026-01-15T13:00:00.000Z');
});

test('an unknown timezone does not crash the whole alarm clock', () => {
  const it = item({ at: '2026-08-04T14:00', tz: 'Mars/Olympus_Mons' });
  assert.throws(() => nextOccurrenceDetail(it, 0), /time zone|timeZone|Invalid/i,
    'Intl rejects it loudly — the scheduler must catch this, see agenda.scheduler');
});

test('one appointment with a bogus timezone does not silence the others', () => {
  const broken = item({
    id: 'broken', at: '2026-08-04T14:00', tz: 'Mars/Olympus_Mons',
    reminders: [{ id: 'rb', offsetMinutes: 0 }],
  });
  const fine = item({
    id: 'fine', at: '2026-08-04T14:00',
    reminders: [{ id: 'rf', offsetMinutes: 0 }],
  });
  const now = at(2026, 8, 4, 14, 0);
  const due = dueReminders([broken, fine], now, now - 5 * MIN);
  assert.equal(due.length, 1, 'the healthy appointment still fires');
  assert.equal(due[0].reminder.id, 'rf');
});
