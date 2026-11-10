import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseProcessList, descendants, findTranscript, readTail, claudeConfigDir } from './locate';

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-reader-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}
function session(dir: string, pid: number, sessionId: string, cwd: string, withLog = true): string {
  fs.writeFileSync(path.join(dir, 'sessions', pid + '.json'), JSON.stringify({ pid, sessionId, cwd, kind: 'interactive' }));
  const proj = path.join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, sessionId + '.jsonl');
  if (withLog) fs.writeFileSync(file, '{}\n');
  return file;
}

test('parseProcessList: „pid ppid name" je Zeile, Pfade mit Leerzeichen bleiben ganz', () => {
  const procs = parseProcessList('    1     0 /sbin/launchd\n  812   700 /Users/a/.local/share/claude/versions/2.1.321\n 900 812 /Applications/My App.app/x\nkaputt\n');
  assert.deepEqual(procs, [
    { pid: 1, ppid: 0, name: '/sbin/launchd' },
    { pid: 812, ppid: 700, name: '/Users/a/.local/share/claude/versions/2.1.321' },
    { pid: 900, ppid: 812, name: '/Applications/My App.app/x' },
  ]);
});

test('descendants: alle Nachkommen, die nächsten zuerst — fremde Prozesse nie', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'zsh' }, { pid: 11, ppid: 10, name: 'claude' }, { pid: 12, ppid: 11, name: 'node' },
    { pid: 20, ppid: 1, name: 'zsh' }, { pid: 21, ppid: 20, name: 'claude' },
  ];
  assert.deepEqual(descendants(procs, 10).map((p) => p.pid), [11, 12]);
  assert.deepEqual(descendants(procs, 99), []);
});

test('findTranscript: die Sitzung des Claude-Prozesses in GENAU diesem Terminal', () => {
  const dir = home();
  const mine = session(dir, 11, 'aaaa1111-0000', '/Users/a/Developer/tms-terminal');
  session(dir, 21, 'bbbb2222-0000', '/Users/a/Developer/tms-terminal'); // anderes Terminal, selber Ordner
  const procs = [{ pid: 10, ppid: 1, name: 'zsh' }, { pid: 11, ppid: 10, name: 'claude' }, { pid: 20, ppid: 1, name: 'zsh' }, { pid: 21, ppid: 20, name: 'claude' }];
  assert.deepEqual(findTranscript(10, procs, dir), { file: mine });
});

test('findTranscript: liegt der Verlauf nicht im erwarteten Ordner, wird er über die Sitzungs-ID gefunden', () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, 'sessions', '11.json'), JSON.stringify({ pid: 11, sessionId: 'cccc3333-0000', cwd: '/irgendwo/anders' }));
  fs.mkdirSync(path.join(dir, 'projects', '-ganz-anderer-name'));
  const file = path.join(dir, 'projects', '-ganz-anderer-name', 'cccc3333-0000.jsonl');
  fs.writeFileSync(file, '{}\n');
  assert.deepEqual(findTranscript(10, [{ pid: 11, ppid: 10, name: 'claude' }], dir), { file });
});

test('findTranscript: die Gründe, wenn es nichts zu lesen gibt', () => {
  const dir = home();
  assert.deepEqual(findTranscript(10, [{ pid: 10, ppid: 1, name: 'zsh' }, { pid: 15, ppid: 10, name: 'vim' }], dir), { reason: 'no-claude' });
  // Claude läuft, hat sich aber nicht eingetragen: eine Sitzung, die keinen Verlauf speichert.
  assert.deepEqual(findTranscript(10, [{ pid: 11, ppid: 10, name: '/Users/a/.local/share/claude/versions/2.1.321' }], dir), { reason: 'no-transcript' });
  // Eingetragen, aber noch nichts geschrieben.
  session(dir, 31, 'dddd4444-0000', '/x', false);
  assert.deepEqual(findTranscript(30, [{ pid: 31, ppid: 30, name: 'claude' }], dir), { reason: 'empty' });
  // Kaputte Eintragsdatei darf nichts umwerfen.
  fs.writeFileSync(path.join(dir, 'sessions', '41.json'), '{kaputt');
  assert.deepEqual(findTranscript(40, [{ pid: 41, ppid: 40, name: 'claude' }], dir), { reason: 'no-transcript' });
  // Eine Sitzungs-ID ist nie ein Pfad.
  fs.writeFileSync(path.join(dir, 'sessions', '51.json'), JSON.stringify({ sessionId: '../../etc/passwd', cwd: '/x' }));
  assert.deepEqual(findTranscript(50, [{ pid: 51, ppid: 50, name: 'claude' }], dir), { reason: 'no-transcript' });
});

test('readTail: große Verläufe nur vom Ende, die angeschnittene erste Zeile fällt weg', () => {
  const dir = home();
  const f = path.join(dir, 'log.jsonl');
  fs.writeFileSync(f, 'erste-zeile-lang\nzweite\ndritte\n');
  assert.equal(readTail(f, 1000), 'erste-zeile-lang\nzweite\ndritte\n');
  assert.equal(readTail(f, 16), 'zweite\ndritte\n', 'mitten in Zeile 1 begonnen → erst ab Zeile 2');
});

test('claudeConfigDir: CLAUDE_CONFIG_DIR gilt, sonst ~/.claude', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/y' }, '/home/a'), '/x/y');
  assert.equal(claudeConfigDir({}, '/home/a'), path.join('/home/a', '.claude'));
});
