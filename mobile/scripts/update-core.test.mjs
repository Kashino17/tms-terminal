import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheck, shouldReport, apkFileName, CHECK_EVERY_MS, RESUME_GAP_MS } from '../src/services/update.core.mjs';

test('Suchen: beim ersten Mal sofort, danach erst nach der Pause', () => {
  assert.equal(shouldCheck(1_000_000, 0, RESUME_GAP_MS), true);
  assert.equal(shouldCheck(1_000_000, 1_000_000 - RESUME_GAP_MS + 1, RESUME_GAP_MS), false);
  assert.equal(shouldCheck(1_000_000, 1_000_000 - RESUME_GAP_MS, RESUME_GAP_MS), true);
  assert.ok(CHECK_EVERY_MS <= 15 * 60_000, 'regelmäßig, ohne Neustart');
  assert.ok(CHECK_EVERY_MS >= 5 * 60_000, 'GitHub-Limit (60/h) bleibt weit weg');
});

test('Fortschritt: höchstens ~5×/s, das Ende immer', () => {
  assert.equal(shouldReport(1000, 900, 10, 100), false);
  assert.equal(shouldReport(1000, 750, 10, 100), true);
  assert.equal(shouldReport(1000, 990, 100, 100), true, 'fertig wird immer gemeldet');
});

test('Dateiname: nur sichere Zeichen', () => {
  assert.equal(apkFileName('v1.139.0'), 'TMS-Terminal-1.139.0.apk');
  assert.equal(apkFileName('../x y'), 'TMS-Terminal-xy.apk', 'kein Pfad aus dem Tag');
});
