import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Snapshotter } from './snapshotter';
import { readSnapshot } from './snapshot.store';
import type { ClaudeSessionInfo } from './claude-session';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-snapr-'));
}

function harness(
  sessions: Array<{ id: string; pid: number; cwd?: string }>,
  claude: Record<number, ClaudeSessionInfo | null> = {},
) {
  const dir = tmpDir();
  const snapshotter = new Snapshotter({
    now: () => 1_700_000_000_000,
    serverPid: 4242,
    dir,
    source: {
      listSessions: () => sessions.map(s => ({ id: s.id, pid: s.pid, cols: 80, rows: 24, cwd: s.cwd })),
      labelFor: (id) => `Label ${id}`,
    },
    resolveClaude: async (pid) => claude[pid] ?? null,
  });
  return { snapshotter, dir };
}

test('captureNow writes every live session', async () => {
  const h = harness([{ id: 'a', pid: 10, cwd: '/tmp/a' }, { id: 'b', pid: 20, cwd: '/tmp/b' }]);
  await h.snapshotter.captureNow();
  const snap = readSnapshot(h.dir)!;
  assert.equal(snap.entries.length, 2);
  assert.equal(snap.serverPid, 4242);
  assert.deepEqual(snap.entries.map(e => e.id), ['a', 'b']);
  assert.equal(snap.entries[0].label, 'Label a');
});

test('a session with claude carries the mark, one without does not', async () => {
  const h = harness(
    [{ id: 'a', pid: 10 }, { id: 'b', pid: 20 }],
    { 10: { pid: 11, sessionId: 'claude-1', cwd: '/tmp/a', status: 'busy' } },
  );
  await h.snapshotter.captureNow();
  const snap = readSnapshot(h.dir)!;
  assert.equal(snap.entries[0].claude?.sessionId, 'claude-1');
  assert.equal(snap.entries[0].claude?.status, 'busy');
  assert.equal(snap.entries[1].claude, undefined);
});

test('the claude cwd wins over the pty cwd when they disagree', async () => {
  // Claude knows where it actually runs; the pty cwd is only sampled now and then.
  const h = harness(
    [{ id: 'a', pid: 10, cwd: '/veraltet' }],
    { 10: { pid: 11, sessionId: 'c', cwd: '/echt/aktuell', status: 'idle' } },
  );
  await h.snapshotter.captureNow();
  assert.equal(readSnapshot(h.dir)!.entries[0].cwd, '/echt/aktuell');
});

test('no sessions writes an empty snapshot rather than leaving a stale one', async () => {
  const h = harness([{ id: 'a', pid: 10 }]);
  await h.snapshotter.captureNow();
  assert.equal(readSnapshot(h.dir)!.entries.length, 1);

  const empty = new Snapshotter({
    now: () => 1_700_000_000_001, serverPid: 4242, dir: h.dir,
    source: { listSessions: () => [], labelFor: () => undefined },
    resolveClaude: async () => null,
  });
  await empty.captureNow();
  assert.equal(readSnapshot(h.dir)!.entries.length, 0,
    'sonst würden nach dem Schließen aller Terminals die alten wiederkommen');
});

test('a throwing claude resolver costs only the mark, not the entry', async () => {
  const dir = tmpDir();
  const s = new Snapshotter({
    now: () => 1, serverPid: 1, dir,
    source: { listSessions: () => [{ id: 'a', pid: 10, cols: 80, rows: 24, cwd: '/tmp' }], labelFor: () => undefined },
    resolveClaude: async () => { throw new Error('pgrep weg'); },
  });
  await s.captureNow();
  const snap = readSnapshot(dir)!;
  assert.equal(snap.entries.length, 1, 'das Terminal steht trotzdem drin');
  assert.equal(snap.entries[0].claude, undefined);
});

test('captureNow never throws even if writing fails', async () => {
  const s = new Snapshotter({
    now: () => 1, serverPid: 1, dir: '/definitiv/nicht/beschreibbar',
    source: { listSessions: () => [{ id: 'a', pid: 10, cols: 80, rows: 24 }], labelFor: () => undefined },
    resolveClaude: async () => null,
  });
  await s.captureNow(); // darf nicht werfen
});

test('overlapping captures do not pile up', async () => {
  // Ein langsames ps darf nicht dazu führen, dass sich Läufe stapeln.
  const dir = tmpDir();
  let running = 0;
  let maxParallel = 0;
  const s = new Snapshotter({
    now: () => 1, serverPid: 1, dir,
    source: { listSessions: () => [{ id: 'a', pid: 10, cols: 80, rows: 24 }], labelFor: () => undefined },
    resolveClaude: async () => {
      running++;
      maxParallel = Math.max(maxParallel, running);
      await new Promise(r => setTimeout(r, 50));
      running--;
      return null;
    },
  });
  await Promise.all([s.captureNow(), s.captureNow(), s.captureNow()]);
  assert.equal(maxParallel, 1, 'immer nur ein Durchlauf gleichzeitig');
});
