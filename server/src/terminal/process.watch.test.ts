import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessWatch } from './process.watch';

function harness(names: string[]) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const reads: number[] = [];
  const reports: string[] = [];
  const w = new ProcessWatch({
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
    read: async () => { reads.push(now); return names.shift() ?? null; },
    report: (_id, n) => reports.push(n),
    minIntervalMs: 4000,
  });
  const flush = () => new Promise((r) => setImmediate(r));
  const advance = async (ms: number) => {
    now += ms;
    for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await flush();
  };
  return { w, reads, reports, advance, flush, timers };
}

test('meldet einen Programmwechsel (pwsh → vim → pwsh) genau einmal je Wechsel', async () => {
  const h = harness(['pwsh.exe', 'vim.exe', 'vim.exe', 'pwsh.exe']);
  h.w.poke('a'); await h.flush();
  await h.advance(5000); h.w.poke('a'); await h.flush();
  await h.advance(5000); h.w.poke('a'); await h.flush();   // weiterhin vim → keine Meldung
  await h.advance(5000); h.w.poke('a'); await h.flush();
  assert.deepEqual(h.reports, ['pwsh.exe', 'vim.exe', 'pwsh.exe']);
});

test('drosselt: viele Ausgabe-Pausen in kurzer Zeit = eine Abfrage plus EINE nachlaufende', async () => {
  const h = harness(['opencode.exe', 'pwsh.exe']);
  h.w.poke('a'); await h.flush();
  for (let i = 0; i < 10; i++) { await h.advance(300); h.w.poke('a'); }
  assert.equal(h.reads.length, 1, 'innerhalb der Sperrzeit keine weitere PowerShell');
  assert.equal(h.timers.length, 1, 'genau eine nachlaufende Prüfung geplant');
  await h.advance(1500); // Sperrzeit vorbei → nachlaufende Prüfung
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.reports, ['opencode.exe', 'pwsh.exe'], 'das Ende von OpenCode geht nicht verloren');
});

test('ein beendetes Terminal meldet nichts mehr und hinterlässt keinen Timer', async () => {
  const h = harness(['vim.exe', 'pwsh.exe']);
  h.w.poke('a'); await h.flush();
  await h.advance(100); h.w.poke('a');
  h.w.forget('a');
  await h.advance(10000);
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.reports, ['vim.exe']);
});
