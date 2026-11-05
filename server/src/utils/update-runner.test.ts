import { test } from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runUpdate } = require('../../bin/update-runner.js');

const P = {
  root: 'C:\\tms\\server', cli: 'C:\\tms\\server\\bin\\cli.js', dist: 'C:\\tms\\server\\dist',
  newDist: 'C:\\tms\\server\\dist.new', oldDist: 'C:\\tms\\server\\dist.old',
  newIndex: 'C:\\tms\\server\\dist.new\\server\\src\\index.js',
  tsbuildinfo: 'C:\\tms\\server\\.tsbuildinfo', newTsbuildinfo: 'C:\\tms\\server\\.tsbuildinfo.new',
};

/** Fake world: records every action; `fail` names the step that should fail. */
function world({ fail = '', serverComesUp = true } = {}) {
  const log: string[] = [];
  const files = new Set<string>([P.dist]);
  return {
    log, files,
    deps: {
      run(cmd: string) {
        log.push(`run ${cmd}`);
        if (fail && cmd.startsWith(fail)) return false;
        if (cmd.startsWith('npx tsc')) files.add(P.newIndex), files.add(P.newDist);
        return true;
      },
      node(args: string[]) {
        log.push(`node ${args.join(' ')}`);
        if (args[0] === 'status') return serverComesUp;
        return true;
      },
      exists: (p: string) => files.has(p),
      remove(p: string) { log.push(`rm ${p}`); files.delete(p); },
      rename(a: string, b: string) { log.push(`mv ${a} -> ${b}`); if (files.has(a)) { files.delete(a); files.add(b); } },
      say(_msg: string) { /* log line */ },
      sleep() { /* no wait in tests */ },
    },
  };
}

test('Windows-Update: erfolgreich — bauen neben dem laufenden Server, erst dann stoppen und tauschen', () => {
  const w = world();
  assert.equal(runUpdate(P, w.deps), true);
  const order = w.log.map((l) => l.split(' ')[0] + ' ' + l.split(' ')[1]);
  const i = (s: string) => order.findIndex((l) => l.startsWith(s));
  assert.ok(i('run git') < i('run npm') && i('run npm') < i('run npx'), 'pull → install → build');
  assert.ok(i('run npx') < i('node stop'), 'Server wird erst NACH dem Build angefasst');
  assert.ok(i('node stop') < i('node start'));
  assert.ok(w.log.some((l) => l === `mv ${P.newDist} -> ${P.dist}`), 'neues dist eingesetzt');
  assert.ok(w.log.includes(`rm ${P.oldDist}`) && w.log.at(-1) === `rm ${P.oldDist}`, 'altes dist am Ende entfernt');
});

for (const step of ['git pull', 'npm install', 'npx tsc']) {
  test(`Windows-Update: scheitert "${step}", bleibt der Server unangetastet`, () => {
    const w = world({ fail: step });
    assert.equal(runUpdate(P, w.deps), false);
    assert.ok(!w.log.some((l) => l.startsWith('node stop')), 'kein Stopp');
    assert.ok(!w.log.some((l) => l.startsWith('mv ')), 'kein Tausch');
  });
}

test('Windows-Update: Build ohne Einstiegspunkt → Abbruch ohne Stopp', () => {
  const w = world();
  w.deps.run = (cmd: string) => { w.log.push(`run ${cmd}`); return true; }; // tsc "succeeds" but writes nothing
  assert.equal(runUpdate(P, w.deps), false);
  assert.ok(!w.log.some((l) => l.startsWith('node stop')));
});

test('Windows-Update: neuer Server kommt nicht hoch → zurück auf das alte dist', () => {
  const w = world({ serverComesUp: false });
  assert.equal(runUpdate(P, w.deps), false);
  const tail = w.log.slice(w.log.findIndex((l) => l.startsWith('node status')));
  assert.ok(tail.some((l) => l === `mv ${P.oldDist} -> ${P.dist}`), 'altes dist zurück');
  assert.ok(tail.some((l) => l.startsWith('node start')), 'alter Server wieder gestartet');
});
