/**
 * Der Beobachter ist die Antwort auf die zweite Hälfte des Fehlerbilds: ein
 * wartender Prompt erzeugt KEINE weitere Ausgabe. Die alte, rein
 * ereignisgesteuerte Erkennung feuerte deshalb genau einmal — lag dieser eine
 * Moment ungünstig (der Nutzer tippte gerade), war die Bestätigung für immer
 * verloren. Diese Tests halten den Wiederholungstakt und seine Abbruchgründe
 * fest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenPromptWatcher, SETTLE_MS, RECHECK_MS } from './prompt.watcher';
import type { ScreenView } from '../terminal/emulator.mirror';
import type { PromptClass } from './prompt.classifier';

/** Steuerbare Uhr: Timer laufen erst, wenn der Test sie vorspult. */
function fakeTimers() {
  let now = 0;
  const pending: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => { const id = nextId++; pending.push({ at: now + ms, fn, id }); return id; },
    clearTimeoutFn: (h: unknown) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1); },
    /** Spult vor und lässt fällige Timer laufen; wartet Microtasks ab. */
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const i = pending.findIndex((p) => p.at <= now);
        if (i < 0) break;
        const [t] = pending.splice(i, 1);
        t.fn();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      }
    },
  };
}

const PERMISSION_ROWS = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
];
const IDLE_ROWS = ['  Fertig.', '', '❯ '];

function view(rows: string[], cursorY: number): ScreenView {
  return { rows, cursorX: 1, cursorY, cols: 40 };
}

test('meldet einen wartenden Prompt nach der Entprellung', async () => {
  const clock = fakeTimers();
  const seen: Array<{ cls: PromptClass; attempt: number }> = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (cls, attempt) => seen.push({ cls, attempt }));

  w.poke('s1');
  await clock.advance(SETTLE_MS);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].cls.kind, 'permission');
  assert.equal(seen[0].attempt, 0);
});

test('meldet denselben Prompt immer wieder, bis er gelöst ist', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  await clock.advance(RECHECK_MS);
  await clock.advance(RECHECK_MS);

  assert.deepEqual(seen, [0, 1, 2], 'ein wartender Prompt erzeugt keine Ausgabe — ohne Takt bliebe er ewig liegen');
});

test('resolved() stoppt den Takt', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => { seen.push(attempt); w.resolved('s1'); });

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  await clock.advance(RECHECK_MS * 3);

  assert.deepEqual(seen, [0]);
});

test('derselbe Prompt darf sich später wiederholen', async () => {
  // Zweimal derselbe Befehl heißt zweimal dieselbe Frage. Würde der gelöste
  // Fingerabdruck nicht zurückgesetzt, sobald der Bildschirm frei ist, bliebe
  // die zweite Frage für immer unbeantwortet.
  const clock = fakeTimers();
  const seen: string[] = [];
  let rows = PERMISSION_ROWS;
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(rows, rows === PERMISSION_ROWS ? 1 : 2),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (cls) => { seen.push(cls.question); w.resolved('s1'); });

  w.poke('s1');
  await clock.advance(SETTLE_MS);

  rows = IDLE_ROWS;              // beantwortet, Box weg
  w.poke('s1');
  await clock.advance(SETTLE_MS);

  rows = PERMISSION_ROWS;        // exakt dieselbe Frage kommt erneut
  w.poke('s1');
  await clock.advance(SETTLE_MS);

  assert.deepEqual(seen, ['Do you want to proceed?', 'Do you want to proceed?']);
});

test('verschwundener Prompt beendet den Takt', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  let rows = PERMISSION_ROWS;
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(rows, rows === PERMISSION_ROWS ? 1 : 2),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  rows = IDLE_ROWS;                 // Box beantwortet, Bildschirm leer
  await clock.advance(RECHECK_MS);
  await clock.advance(RECHECK_MS);

  assert.deepEqual(seen, [0]);
});

test('ein NEUER Prompt startet wieder bei attempt 0', async () => {
  const clock = fakeTimers();
  const seen: Array<{ q: string; attempt: number }> = [];
  let rows = PERMISSION_ROWS;
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(rows, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (cls, attempt) => { seen.push({ q: cls.question, attempt }); w.resolved('s1'); });

  w.poke('s1');
  await clock.advance(SETTLE_MS);

  rows = [' Do you want to run this command?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
  w.poke('s1');
  await clock.advance(SETTLE_MS);

  assert.equal(seen.length, 2);
  assert.equal(seen[1].attempt, 0);
  assert.equal(seen[1].q, 'Do you want to run this command?');
});

test('Umfragen bekommen keinen Wiederholungstakt', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view([
      ' Welchen Ansatz nehmen wir?',
      ' ❯ 1. Redis',
      '   2. In-Memory',
      '',
      ' Esc to cancel',
    ], 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS);
  await clock.advance(RECHECK_MS * 3);

  assert.deepEqual(seen, [0], 'bei einer Umfrage gibt es nichts zu wiederholen — sie wird nie automatisch beantwortet');
});

test('ohne Spiegel passiert nichts', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => null,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));

  w.poke('s1');
  await clock.advance(SETTLE_MS + RECHECK_MS);

  assert.deepEqual(seen, []);
});

test('unwatch räumt auf', async () => {
  const clock = fakeTimers();
  const seen: number[] = [];
  const w = new ScreenPromptWatcher({
    getScreen: async () => view(PERMISSION_ROWS, 1),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  w.watch('s1', (_cls, attempt) => seen.push(attempt));
  w.poke('s1');
  w.unwatch('s1');
  await clock.advance(SETTLE_MS + RECHECK_MS * 2);
  assert.deepEqual(seen, []);
});
