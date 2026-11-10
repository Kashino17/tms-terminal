import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DictationStatsStore, DictationStat } from './dictation.stats';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tms-dict-stats-')), 'dictation-stats.json');
const stat = (waitMs: number): DictationStat => ({ at: 1, audioSecs: 30, waitMs, restSecs: 4, specHit: false });
const store = () => new DictationStatsStore(tmpFile());

test('keeps only the newest 50', () => {
  const st = store();
  for (let i = 0; i < 60; i++) st.record(stat(i));
  assert.strictEqual(st.summary().count, 50);
  assert.strictEqual(st.summary().waits[0], 10);
});

test('summary: median and share at or under 700ms', () => {
  const st = store();
  [300, 500, 900, 700].forEach((w) => st.record(stat(w)));
  assert.strictEqual(st.summary().medianMs, 600);
  assert.strictEqual(st.summary().under700, 0.75);
});

test('survives a restart', () => {
  const f = tmpFile();
  new DictationStatsStore(f).record(stat(400));
  assert.strictEqual(new DictationStatsStore(f).summary().count, 1);
});

test('a corrupt file is kept aside, not overwritten silently', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{oops');
  const st = new DictationStatsStore(f);
  st.record(stat(400));
  assert.ok(fs.existsSync(f + '.bad'));
  assert.strictEqual(st.summary().count, 1);
});

test('empty store has a neutral summary', () => {
  assert.deepStrictEqual(store().summary(), { count: 0, medianMs: 0, under700: 0, waits: [] });
});

test('the file holds numbers only', () => {
  const f = tmpFile();
  new DictationStatsStore(f).record(stat(400));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { version: 1, stats: [stat(400)] });
});
