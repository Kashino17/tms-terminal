process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckInScheduler, buildStuckPrompt, staleProjects, SILENCE_MARKER } from './triggers';
import type { ProjectFacts } from './collector';
import type { Entry } from '../entries/entries.types';

const DAY = 24 * 60 * 60 * 1000;

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test('the morning check-in fires once at 08:30 and not again that day', () => {
  let t = at(2026, 7, 28, 8, 29);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));

  s.tick();
  assert.deepEqual(fired, [], 'not yet');

  t = at(2026, 7, 28, 8, 30);
  s.tick();
  assert.deepEqual(fired, ['morning']);

  t = at(2026, 7, 28, 9, 0);
  s.tick();
  assert.deepEqual(fired, ['morning'], 'must not repeat within the day');
});

test('the evening check-in is separate from the morning one', () => {
  let t = at(2026, 7, 28, 8, 30);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  t = at(2026, 7, 28, 19, 0);
  s.tick();
  assert.deepEqual(fired, ['morning', 'evening']);
});

test('the next day fires again', () => {
  let t = at(2026, 7, 28, 8, 30);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  t = at(2026, 7, 29, 8, 30);
  s.tick();
  assert.deepEqual(fired, ['morning', 'morning']);
});

test('a check-in missed by hours is not fired late', () => {
  // Server was down all morning and comes up at 14:00 — a "guten Morgen" now is noise.
  let t = at(2026, 7, 28, 14, 0);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  assert.deepEqual(fired, [], 'more than an hour late — skip it');
});

test('a check-in 20 minutes late still fires', () => {
  let t = at(2026, 7, 28, 8, 50);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  assert.deepEqual(fired, ['morning']);
});

test('a check-in skipped as too late does not fire later the same day', () => {
  let t = at(2026, 7, 28, 14, 0);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => fired.push(kind));
  s.tick();
  t = at(2026, 7, 28, 15, 0);
  s.tick();
  assert.deepEqual(fired, [], 'stays skipped for the rest of the day');
});

test('a throwing handler does not stop the other check-in', () => {
  let t = at(2026, 7, 28, 8, 30);
  const fired: string[] = [];
  const s = new CheckInScheduler(() => t, (kind) => {
    if (kind === 'morning') throw new Error('Handler kaputt');
    fired.push(kind);
  });
  s.tick();
  t = at(2026, 7, 28, 19, 0);
  s.tick();
  assert.deepEqual(fired, ['evening'], 'the evening check-in still runs');
});

test('the stuck prompt gives the model everything it needs and permission to stay silent', () => {
  const prompt = buildStuckPrompt({
    sample: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    terminalTail: 'npm run dev\n... Fehler ...',
    sessionLabel: 'Shell 1',
    projectPath: '/Users/ayysir/Desktop/Foo',
    claudeMdSummary: '# Foo\nPostgres läuft auf Port 5432.',
  });
  assert.match(prompt, /ECONNREFUSED/);
  assert.match(prompt, /Shell 1/);
  assert.match(prompt, /Desktop\/Foo/);
  assert.match(prompt, /Postgres/);
  assert.match(prompt, new RegExp(SILENCE_MARKER), 'the model must be told it may say nothing');
  assert.match(prompt, /\*\*genau einem\*\* konkreten Vorschlag/i, 'exactly one suggestion, not a list');
});

test('the stuck prompt works without a project or CLAUDE.md', () => {
  const prompt = buildStuckPrompt({
    sample: 'Error: kaputt', terminalTail: 'x', sessionLabel: 'Shell 2',
  });
  assert.match(prompt, /Shell 2/);
  assert.match(prompt, new RegExp(SILENCE_MARKER));
});

// ── Brachliegende Projekte ───────────────────────────────────────────────────

function proj(key: string, lastActivityAt: number): ProjectFacts {
  return {
    key, path: `/Users/x/${key}`, name: key, lastActivityAt,
    recentSessions: [], collectedAt: lastActivityAt,
  };
}

function todo(project: string): Entry {
  return {
    id: `e-${project}`, text: `offen in ${project}`, checkable: true, done: false,
    project, createdAt: 0, updatedAt: 0, source: 'user',
  };
}

test('a project untouched for over five days with open to-dos counts as stale', () => {
  const now = at(2026, 7, 28, 10, 0);
  const stale = staleProjects([proj('Alt', now - 9 * DAY)], [todo('Alt')], now);
  assert.deepEqual(stale.map(p => p.key), ['Alt']);
});

test('a recently touched project is never stale, open to-dos or not', () => {
  const now = at(2026, 7, 28, 10, 0);
  assert.deepEqual(staleProjects([proj('Frisch', now - 2 * DAY)], [todo('Frisch')], now), []);
});

test('an old project without open to-dos is finished, not forgotten', () => {
  const now = at(2026, 7, 28, 10, 0);
  assert.deepEqual(staleProjects([proj('Fertig', now - 30 * DAY)], [], now), []);
});

test('done to-dos do not keep a project alive', () => {
  const now = at(2026, 7, 28, 10, 0);
  const done: Entry = { ...todo('Erledigt'), done: true };
  assert.deepEqual(staleProjects([proj('Erledigt', now - 30 * DAY)], [done], now), []);
});

test('a note (not checkable) does not make a project stale either', () => {
  const now = at(2026, 7, 28, 10, 0);
  const note: Entry = { ...todo('NurNotiz'), checkable: false };
  assert.deepEqual(staleProjects([proj('NurNotiz', now - 30 * DAY)], [note], now), []);
});
