process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgendaItem } from './agenda.types';
import type { DueReminder } from './agenda.time';
import { AgendaScheduler } from './agenda.scheduler';

const MIN = 60_000;

function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/** Scheduler wired to an in-memory item list and a hand-cranked clock. */
function harness(items: AgendaItem[], startNow: number) {
  let now = startNow;
  const fired: Array<{ title: string; late: boolean }> = [];
  const scheduler = new AgendaScheduler(
    () => now,
    () => items,
    () => { /* in-memory: mutation happens in place */ },
    (d: DueReminder, late: boolean) => fired.push({ title: d.item.title, late }),
  );
  return {
    scheduler,
    fired,
    items,
    advanceTo(ms: number) { now = ms; },
  };
}

function appointment(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id: 'a1', title: 'Zahnarzt', at: '2026-08-04T14:00', allDay: false,
    repeat: 'none', reminders: [{ id: 'r0', offsetMinutes: 0 }],
    source: 'user', createdAt: 0, ...over,
  };
}

test('a reminder that comes due fires exactly once', () => {
  const h = harness([appointment()], at(2026, 8, 4, 13, 30));
  h.scheduler.start();
  assert.equal(h.fired.length, 0, 'not due yet');

  h.advanceTo(at(2026, 8, 4, 14, 0));
  h.scheduler.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].late, false);

  h.advanceTo(at(2026, 8, 4, 14, 1));
  h.scheduler.tick();
  assert.equal(h.fired.length, 1, 'must not fire a second time');
  h.scheduler.stop();
});

test('all three lead-time reminders fire, each on its own', () => {
  const it = appointment({
    reminders: [
      { id: 'r2d', offsetMinutes: 2 * 24 * 60 },
      { id: 'r1d', offsetMinutes: 24 * 60 },
      { id: 'r1h', offsetMinutes: 60 },
    ],
  });
  const h = harness([it], at(2026, 8, 1));
  h.scheduler.start();

  h.advanceTo(at(2026, 8, 2, 14, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 1, 'two days before');

  h.advanceTo(at(2026, 8, 3, 14, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 2, 'one day before — must not be silenced by the first');

  h.advanceTo(at(2026, 8, 4, 13, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 3, 'one hour before');
  h.scheduler.stop();
});

test('after downtime a reminder 11 hours old is caught up and marked late', () => {
  const h = harness([appointment()], at(2026, 8, 5, 1, 0)); // 11h after 14:00
  h.scheduler.start();
  assert.equal(h.fired.length, 1, 'inside the 12h catch-up window');
  assert.equal(h.fired[0].late, true, 'must be flagged as late');
  h.scheduler.stop();
});

test('after downtime a reminder 13 hours old is silently retired', () => {
  const h = harness([appointment()], at(2026, 8, 5, 3, 0)); // 13h after 14:00
  h.scheduler.start();
  assert.equal(h.fired.length, 0, 'outside the window — no flood after long downtime');

  h.advanceTo(at(2026, 8, 5, 4, 0));
  h.scheduler.tick();
  assert.equal(h.fired.length, 0, 'and it stays quiet afterwards');
  h.scheduler.stop();
});

test('a yearly birthday fires again the following year', () => {
  const it = appointment({
    title: 'Geburtstag Mama', at: '2020-07-30T09:00', repeat: 'yearly',
    reminders: [{ id: 'r0', offsetMinutes: 0 }],
  });
  const h = harness([it], at(2026, 7, 30, 8, 0));
  h.scheduler.start();

  h.advanceTo(at(2026, 7, 30, 9, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 1);

  h.advanceTo(at(2027, 7, 30, 9, 0)); h.scheduler.tick();
  assert.equal(h.fired.length, 2, 'the next year must fire too');
  h.scheduler.stop();
});

test('start() is idempotent and stop() halts ticking', () => {
  const h = harness([appointment()], at(2026, 8, 4, 13, 0));
  h.scheduler.start();
  h.scheduler.start();
  h.scheduler.stop();
  h.advanceTo(at(2026, 8, 4, 14, 0));
  h.scheduler.tick(); // manual tick still works
  assert.equal(h.fired.length, 1);
});
