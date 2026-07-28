import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  descendantPids, readClaudeSessionFile, resolveClaudeSession,
  parseProcessTable, childLookupFrom,
} from './claude-session';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-claude-'));
}

/** Writes a session file exactly as Claude Code v2.1.220 does. */
function writeSessionFile(dir: string, pid: number, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: `session-of-${pid}`, cwd: '/Users/x/Desktop/Foo',
    startedAt: 1785219546136, version: '2.1.220', kind: 'interactive',
    status: 'idle', ...over,
  }));
}

/** Fake process tree: pid -> direct children. */
function tree(map: Record<number, number[]>) {
  return async (pid: number): Promise<number[]> => map[pid] ?? [];
}

test('descendantPids walks the tree breadth-first down to the depth limit', async () => {
  const children = tree({ 100: [200, 201], 200: [300], 300: [400] });
  assert.deepEqual(await descendantPids(100, children, 3), [200, 201, 300, 400]);
});

test('descendantPids stops at the depth limit', async () => {
  const children = tree({ 100: [200], 200: [300], 300: [400], 400: [500] });
  const found = await descendantPids(100, children, 2);
  assert.deepEqual(found, [200, 300]);
});

test('descendantPids survives a cycle instead of looping forever', async () => {
  const children = tree({ 100: [200], 200: [100] });
  const found = await descendantPids(100, children, 5);
  assert.ok(found.includes(200));
  assert.ok(found.length < 10, 'darf nicht endlos wachsen');
});

test('readClaudeSessionFile reads the fields we need', () => {
  const dir = tmpDir();
  writeSessionFile(dir, 90832, { status: 'busy' });
  const info = readClaudeSessionFile(90832, dir)!;
  assert.equal(info.sessionId, 'session-of-90832');
  assert.equal(info.status, 'busy');
  assert.equal(info.cwd, '/Users/x/Desktop/Foo');
});

test('a session file whose pid field does not match is REJECTED', () => {
  // PIDs get reused by the OS. Without this check an old file could be
  // attributed to a completely unrelated process.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '555.json'), JSON.stringify({
    pid: 999, sessionId: 'fremd', cwd: '/tmp', status: 'idle',
  }));
  assert.equal(readClaudeSessionFile(555, dir), null);
});

test('a missing or corrupt session file yields null', () => {
  const dir = tmpDir();
  assert.equal(readClaudeSessionFile(1234, dir), null);
  fs.writeFileSync(path.join(dir, '1234.json'), 'kein json');
  assert.equal(readClaudeSessionFile(1234, dir), null);
});

test('an unknown status falls back to idle rather than being dropped', () => {
  const dir = tmpDir();
  writeSessionFile(dir, 77, { status: 'irgendwas-neues' });
  assert.equal(readClaudeSessionFile(77, dir)!.status, 'idle');
});

test('resolveClaudeSession finds claude TWO levels below the shell', async () => {
  // Claude need not be a direct child — a wrapper, npx or a shell alias puts it deeper.
  const dir = tmpDir();
  writeSessionFile(dir, 300);
  const info = await resolveClaudeSession(100, {
    children: tree({ 100: [200], 200: [300] }), sessionsDir: dir,
  });
  assert.equal(info!.sessionId, 'session-of-300');
});

test('resolveClaudeSession returns null when no descendant has a session file', async () => {
  const dir = tmpDir();
  const info = await resolveClaudeSession(100, {
    children: tree({ 100: [200, 201] }), sessionsDir: dir,
  });
  assert.equal(info, null);
});

test('resolveClaudeSession never scans the directory as a whole', async () => {
  // A stale file for a session the user deliberately ended must not resurrect it.
  const dir = tmpDir();
  writeSessionFile(dir, 999); // not a descendant of 100
  const info = await resolveClaudeSession(100, {
    children: tree({ 100: [200] }), sessionsDir: dir,
  });
  assert.equal(info, null, 'nur Nachfahren der lebenden Shell zählen');
});

test('a failing child lookup yields null instead of throwing', async () => {
  const dir = tmpDir();
  const broken = async (): Promise<number[]> => { throw new Error('pgrep weg'); };
  assert.equal(await resolveClaudeSession(100, { children: broken, sessionsDir: dir }), null);
});

// ── Prozess-Tabelle ──────────────────────────────────────────────────────────
// Bewusst ps statt pgrep -P: gemessen am 2026-07-29 verfehlt pgrep -P auf macOS
// systematisch Kinder (acht Eltern auf der Maschine meldeten weniger Kinder als
// ps, teils gar keine).

test('parseProcessTable turns real ps output into a parent map', () => {
  const out = [
    '    1     0',
    '  100     1',
    '  200   100',
    '  201   100',
    '  300   200',
  ].join('\n');
  const table = parseProcessTable(out);
  assert.deepEqual(table.get(100), [200, 201]);
  assert.deepEqual(table.get(200), [300]);
  assert.equal(table.get(999), undefined);
});

test('parseProcessTable skips junk lines instead of throwing', () => {
  const table = parseProcessTable('  PID  PPID\n  100     1\nkaputt\n\n  200   100\n');
  assert.deepEqual(table.get(100), [200]);
});

test('childLookupFrom plugs the table into descendantPids', async () => {
  const table = parseProcessTable('  200   100\n  300   200\n');
  const found = await descendantPids(100, childLookupFrom(table), 3);
  assert.deepEqual(found, [200, 300]);
});
