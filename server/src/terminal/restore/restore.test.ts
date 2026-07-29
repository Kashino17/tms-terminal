import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from './snapshot.types';
import { restoreTerminals, looksReady, MAX_SNAPSHOT_AGE_MS } from './restore';

const NOW = 1_700_000_000_000;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    capturedAt: NOW - 60_000,
    serverPid: 999,
    entries: [
      { id: 'a', label: 'Shell 1', cwd: '/tmp/a', cols: 80, rows: 24,
        claude: { sessionId: 'claude-a', status: 'idle' } },
      { id: 'b', label: 'Shell 2', cwd: '/tmp/b', cols: 80, rows: 24 },
    ],
    ...over,
  };
}

/** Collects what restore did, without starting a single process. */
function harness(snapshot: Snapshot | null, opts: { pidAlive?: boolean } = {}) {
  const created: Array<{ id: string; cwd: string }> = [];
  const written: Array<{ id: string; data: string }> = [];
  const marks: Array<{ id: string; text: string }> = [];
  const observers = new Map<string, (data: string) => void>();
  const fallbacks: Array<() => void> = [];

  const deps = {
    now: () => NOW,
    takeSnapshot: () => snapshot,
    isPidAlive: () => opts.pidAlive ?? false,
    createSession: (e: { id: string; cwd: string; cols: number; rows: number }, onOutput: (d: string) => void) => {
      created.push({ id: e.id, cwd: e.cwd });
      observers.set(e.id, onOutput);
      return true;
    },
    writeToSession: (id: string, data: string) => { written.push({ id, data }); },
    markSession: (id: string, text: string) => { marks.push({ id, text }); },
    maxSessions: 50,
    // Notbremsen-Timer einsammeln statt echt laufen lassen: sonst haengt jeder
    // Test 5 Sekunden und schreibt NACH der Zusicherung noch in die Session.
    setTimeoutFn: (fn: () => void) => { fallbacks.push(fn); return 0; },
  };
  return { deps, created, written, marks, observers, fallbacks };
}

test('a fresh snapshot restores every entry', async () => {
  const h = harness(snap());
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(h.created.map(c => c.id), ['a', 'b']);
  assert.deepEqual(h.created.map(c => c.cwd), ['/tmp/a', '/tmp/b']);
  assert.deepEqual(result.restored, ['a', 'b']);
});

test('the resume command goes out only once the shell looks ready', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  assert.equal(h.written.length, 0, 'noch nichts geschrieben — die Shell hat sich nicht gemeldet');

  h.observers.get('a')!('ayysir@MacBook-Pro ~ % ');
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].id, 'a');
  assert.equal(h.written[0].data, 'claude --resume claude-a\r');
});

test('a terminal without a claude mark never gets a command', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  h.observers.get('b')!('ayysir@MacBook-Pro ~ % ');
  assert.deepEqual(h.written, []);
});

test('the command is sent exactly once, however much output follows', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  const observer = h.observers.get('a')!;
  observer('~ % ');
  observer('~ % ');
  observer('mehr Ausgabe\n~ % ');
  assert.equal(h.written.length, 1);
});

test('the safety net sends the command when the shell never looks ready', async () => {
  // Eine exotische Shell, die nie einen erkennbaren Prompt druckt, darf die
  // Wiederherstellung nicht dauerhaft blockieren.
  const h = harness(snap());
  await restoreTerminals(h.deps);
  assert.equal(h.written.length, 0, 'noch nichts');
  h.fallbacks.forEach(fn => fn());          // 5-Sekunden-Notbremse ausloesen
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].data, 'claude --resume claude-a\r');
});

test('the safety net does not send twice when the prompt arrived first', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  h.observers.get('a')!('~ % ');
  h.fallbacks.forEach(fn => fn());
  assert.equal(h.written.length, 1, 'genau einmal, egal in welcher Reihenfolge');
});

test('a snapshot older than the limit is discarded', async () => {
  const h = harness(snap({ capturedAt: NOW - MAX_SNAPSHOT_AGE_MS - 1000 }));
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(h.created, []);
  assert.equal(result.skipped, 'stale');
});

test('a snapshot just inside the limit is restored', async () => {
  const h = harness(snap({ capturedAt: NOW - MAX_SNAPSHOT_AGE_MS + 1000 }));
  assert.equal((await restoreTerminals(h.deps)).restored.length, 2);
});

test('a living serverPid means another server owns these terminals', async () => {
  const h = harness(snap(), { pidAlive: true });
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(h.created, []);
  assert.equal(result.skipped, 'other-server');
});

test('no snapshot at all is not an error', async () => {
  const h = harness(null);
  const result = await restoreTerminals(h.deps);
  assert.equal(result.skipped, 'none');
  assert.deepEqual(result.restored, []);
});

test('interrupted sessions are reported separately — they wait for input', async () => {
  const h = harness(snap({
    entries: [{ id: 'a', cwd: '/tmp/a', cols: 80, rows: 24, claude: { sessionId: 'c', status: 'busy' } }],
  }));
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(result.interrupted, ['a']);
});

test('a session that cannot be created is reported, the rest still comes back', async () => {
  const h = harness(snap());
  h.deps.createSession = (e, onOutput) => {
    if (e.id === 'a') return false;
    h.created.push({ id: e.id, cwd: e.cwd });
    h.observers.set(e.id, onOutput);
    return true;
  };
  const result = await restoreTerminals(h.deps);
  assert.deepEqual(result.restored, ['b']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'a');
});

test('more entries than the session limit are capped and named, not silently dropped', async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({
    id: `s${i}`, cwd: '/tmp', cols: 80, rows: 24,
  }));
  const h = harness(snap({ entries: many }));
  const result = await restoreTerminals(h.deps);
  assert.equal(result.restored.length, 50);
  assert.equal(result.failed.length, 5);
  assert.match(result.failed[0].reason, /Grenze|limit/i);
});

test('every restored terminal gets a marker line', async () => {
  const h = harness(snap());
  await restoreTerminals(h.deps);
  assert.equal(h.marks.length, 2);
  assert.match(h.marks[0].text, /wiederhergestellt/i);
  assert.match(h.marks[0].text, /Claude/i, 'bei a wird die fortgesetzte Sitzung genannt');
  assert.doesNotMatch(h.marks[1].text, /Claude/i, 'bei b nicht');
});

// ── Bereitschafts-Erkennung ──────────────────────────────────────────────────

test('looksReady recognises common shell prompts', () => {
  for (const s of ['ayysir@MacBook-Pro ~ % ', 'user@host:~/dev$ ', '❯ ', '/tmp # ', 'x › ']) {
    assert.equal(looksReady(s), true, `sollte bereit sein: ${JSON.stringify(s)}`);
  }
});

test('looksReady does not fire on ordinary output', () => {
  for (const s of ['Installing dependencies...', 'npm run build\n', '', 'Fehler: irgendwas']) {
    assert.equal(looksReady(s), false, `sollte NICHT bereit sein: ${JSON.stringify(s)}`);
  }
});

// ── Der Auto-Approve-Schalter muss den Neustart überleben ───────────────────
// Wiederhergestellte Terminals kommen zurück, der Schalter bisher nicht: er war
// danach still aus, bis die App sich meldet — genau die Lücke, in der es
// aussieht, als drücke der Server wieder nicht.
test('wiederhergestellte Sitzung bekommt ihren Auto-Approve-Schalter zurück', async () => {
  const applied: Array<{ id: string; on: boolean }> = [];
  const result = await restoreTerminals({
    now: () => NOW,
    takeSnapshot: () => ({
      capturedAt: NOW - 60_000,
      serverPid: 999,
      entries: [
        { id: 'a', cwd: '/tmp', cols: 80, rows: 24, autoApprove: true },
        { id: 'b', cwd: '/tmp', cols: 80, rows: 24, autoApprove: false },
        { id: 'c', cwd: '/tmp', cols: 80, rows: 24 },
      ],
    }),
    isPidAlive: () => false,
    createSession: () => true,
    writeToSession: () => {},
    markSession: () => {},
    applyAutoApprove: (id, on) => applied.push({ id, on }),
    maxSessions: 10,
    setTimeoutFn: (fn) => { void fn; return 0; },
  });

  assert.equal(result.restored.length, 3);
  assert.deepEqual(applied, [
    { id: 'a', on: true },
    { id: 'b', on: false },
  ], 'nur gespeicherte Werte werden gesetzt — fehlt der Wert, bleibt es beim Standard');
});
