import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptFacts, collectProjects } from './collector';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-collect-'));
}

/** Writes a transcript that looks like a real Claude Code jsonl file. */
function writeTranscript(dir: string, name: string, opts: {
  cwd: string; branch: string; title: string; prompts: number; startIso: string; endIso: string;
}): void {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'user', cwd: opts.cwd, gitBranch: opts.branch,
    timestamp: opts.startIso, sessionId: 's-1', version: '2.1.220',
    message: { role: 'user', content: 'erster Prompt' },
  }));
  for (let i = 0; i < opts.prompts; i++) {
    lines.push(JSON.stringify({ type: 'last-prompt', prompt: `Prompt ${i}` }));
  }
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId: 's-1' }));
  lines.push(JSON.stringify({
    type: 'assistant', cwd: opts.cwd, gitBranch: opts.branch,
    timestamp: opts.endIso, sessionId: 's-1',
  }));
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
}

test('reads cwd, branch, title and prompt count out of a transcript', () => {
  const dir = tmpDir();
  writeTranscript(dir, 'a.jsonl', {
    cwd: '/Users/x/Desktop/Foo', branch: 'master', title: 'Serverfehler beheben',
    prompts: 4, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:30:00.000Z',
  });
  const facts = readTranscriptFacts(path.join(dir, 'a.jsonl'));
  assert.equal(facts.cwd, '/Users/x/Desktop/Foo');
  assert.equal(facts.gitBranch, 'master');
  assert.equal(facts.title, 'Serverfehler beheben');
  assert.equal(facts.promptCount, 4);
  assert.equal(facts.startedAt, Date.parse('2026-07-28T08:00:00.000Z'));
  assert.equal(facts.endedAt, Date.parse('2026-07-28T09:30:00.000Z'));
});

test('a truncated or malformed transcript yields partial facts instead of throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{"type":"user","cwd":"/tmp/x"}\nNOT JSON AT ALL\n{"typ');
  const facts = readTranscriptFacts(path.join(dir, 'broken.jsonl'));
  assert.equal(facts.cwd, '/tmp/x', 'the readable part is still used');
});

test('an empty file is harmless', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.equal(readTranscriptFacts(path.join(dir, 'empty.jsonl')).promptCount, 0);
});

test('a missing file is harmless', () => {
  assert.equal(readTranscriptFacts('/definitiv/nicht/da.jsonl').promptCount, 0);
});

test('collectProjects groups sessions per project, newest first', () => {
  const root = tmpDir();
  const projA = path.join(root, '-Users-x-Desktop-Foo');
  const projB = path.join(root, '-Users-x-Desktop-Bar');
  fs.mkdirSync(projA); fs.mkdirSync(projB);

  writeTranscript(projA, 'old.jsonl', {
    cwd: '/Users/x/Desktop/Foo', branch: 'master', title: 'Altes Thema',
    prompts: 2, startIso: '2026-07-20T08:00:00.000Z', endIso: '2026-07-20T09:00:00.000Z',
  });
  writeTranscript(projA, 'new.jsonl', {
    cwd: '/Users/x/Desktop/Foo', branch: 'feat/x', title: 'Neues Thema',
    prompts: 5, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:00:00.000Z',
  });
  writeTranscript(projB, 'only.jsonl', {
    cwd: '/Users/x/Desktop/Bar', branch: 'main', title: 'Bar-Thema',
    prompts: 1, startIso: '2026-07-25T08:00:00.000Z', endIso: '2026-07-25T08:30:00.000Z',
  });
  // mtime is the ordering key — make it explicit rather than relying on write order.
  fs.utimesSync(path.join(projA, 'old.jsonl'), new Date('2026-07-20T09:00:00Z'), new Date('2026-07-20T09:00:00Z'));
  fs.utimesSync(path.join(projA, 'new.jsonl'), new Date('2026-07-28T09:00:00Z'), new Date('2026-07-28T09:00:00Z'));
  fs.utimesSync(path.join(projB, 'only.jsonl'), new Date('2026-07-25T08:30:00Z'), new Date('2026-07-25T08:30:00Z'));

  const projects = collectProjects({ projectsDir: root });
  assert.equal(projects.length, 2);
  assert.equal(projects[0].name, 'Foo', 'most recently active project comes first');
  assert.equal(projects[0].recentSessions[0].title, 'Neues Thema');
  assert.equal(projects[0].recentSessions.length, 2);
  assert.equal(projects[0].path, '/Users/x/Desktop/Foo');
});

test('directories without transcripts are skipped', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '-Users-x-Desktop-Leer'));
  assert.deepEqual(collectProjects({ projectsDir: root }), []);
});

test('a missing projects directory yields an empty list, not a crash', () => {
  assert.deepEqual(collectProjects({ projectsDir: '/definitiv/nicht/da' }), []);
});

test('sessionsPerProject caps how much history is kept', () => {
  const root = tmpDir();
  const proj = path.join(root, '-Users-x-Desktop-Viel');
  fs.mkdirSync(proj);
  for (let i = 0; i < 8; i++) {
    writeTranscript(proj, `s${i}.jsonl`, {
      cwd: '/Users/x/Desktop/Viel', branch: 'master', title: `Thema ${i}`,
      prompts: 1, startIso: `2026-07-2${i}T08:00:00.000Z`, endIso: `2026-07-2${i}T09:00:00.000Z`,
    });
  }
  const projects = collectProjects({ projectsDir: root, sessionsPerProject: 3 });
  assert.equal(projects[0].recentSessions.length, 3);
});

test('a transcript without an ai-title still produces a session', () => {
  const root = tmpDir();
  const proj = path.join(root, '-Users-x-Desktop-Namenlos');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'x.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/Users/x/Desktop/Namenlos', timestamp: '2026-07-28T08:00:00.000Z' }) + '\n');
  const projects = collectProjects({ projectsDir: root });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].recentSessions[0].title, '(ohne Titel)');
});

test('projects whose transcripts have not moved are reused untouched', () => {
  const root = tmpDir();
  const proj = path.join(root, '-Users-x-Desktop-Ruhig');
  fs.mkdirSync(proj);
  writeTranscript(proj, 'a.jsonl', {
    cwd: '/Users/x/Desktop/Ruhig', branch: 'master', title: 'Ursprung',
    prompts: 1, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:00:00.000Z',
  });

  const first = collectProjects({ projectsDir: root });
  assert.equal(first[0].recentSessions[0].title, 'Ursprung');

  // Rewrite the CONTENT but keep the mtime: the cached entry must win, proving
  // the second run never opened the file.
  const stat = fs.statSync(path.join(proj, 'a.jsonl'));
  writeTranscript(proj, 'a.jsonl', {
    cwd: '/Users/x/Desktop/Ruhig', branch: 'master', title: 'Sollte NICHT gelesen werden',
    prompts: 9, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:00:00.000Z',
  });
  fs.utimesSync(path.join(proj, 'a.jsonl'), stat.atime, stat.mtime);

  const second = collectProjects({ projectsDir: root, previous: first });
  assert.equal(second[0].recentSessions[0].title, 'Ursprung', 'cache was reused');
});

test('a project whose transcript moved IS re-read', () => {
  const root = tmpDir();
  const proj = path.join(root, '-Users-x-Desktop-Aktiv');
  fs.mkdirSync(proj);
  writeTranscript(proj, 'a.jsonl', {
    cwd: '/Users/x/Desktop/Aktiv', branch: 'master', title: 'Alt',
    prompts: 1, startIso: '2026-07-28T08:00:00.000Z', endIso: '2026-07-28T09:00:00.000Z',
  });
  const first = collectProjects({ projectsDir: root });

  writeTranscript(proj, 'a.jsonl', {
    cwd: '/Users/x/Desktop/Aktiv', branch: 'master', title: 'Neu',
    prompts: 2, startIso: '2026-07-28T10:00:00.000Z', endIso: '2026-07-28T11:00:00.000Z',
  });
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(proj, 'a.jsonl'), later, later);

  const second = collectProjects({ projectsDir: root, previous: first });
  assert.equal(second[0].recentSessions[0].title, 'Neu', 'changed project must be re-read');
});
