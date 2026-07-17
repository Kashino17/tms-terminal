import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { getTermEnv } from './platform';

test('getTermEnv injects the browser-bridge shim', () => {
  const env = getTermEnv();
  assert.ok(env.BROWSER && env.BROWSER.endsWith('tms-open'), 'BROWSER points at tms-open');
  assert.ok(env.TMS_BROWSERBRIDGE_SECRET && env.TMS_BROWSERBRIDGE_SECRET.length >= 16);
  const shimDir = path.dirname(env.BROWSER);
  assert.equal(env.PATH.split(path.delimiter)[0], shimDir, 'shim dir is first on PATH');
  assert.ok(env.TMS_SERVER_PORT && env.TMS_SERVER_PORT.length > 0);
});
