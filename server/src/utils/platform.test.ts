import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { getTermEnv, scrubInheritedSession } from './platform';

test('getTermEnv injects the browser-bridge shim', () => {
  const env = getTermEnv();
  assert.ok(env.BROWSER && env.BROWSER.endsWith('tms-open'), 'BROWSER points at tms-open');
  assert.ok(env.TMS_BROWSERBRIDGE_SECRET && env.TMS_BROWSERBRIDGE_SECRET.length >= 16);
  const shimDir = path.dirname(env.BROWSER);
  assert.equal(env.PATH.split(path.delimiter)[0], shimDir, 'shim dir is first on PATH');
  assert.ok(env.TMS_SERVER_PORT && env.TMS_SERVER_PORT.length > 0);
});

/**
 * Wird der Server aus einem Terminal gestartet, in dem Claude Code läuft (z. B.
 * `tms-terminal update` aus einer Claude-Sitzung), erbt er deren Kennzeichen —
 * und reichte sie an JEDES neue Terminal weiter. Jede dort gestartete
 * Claude-Sitzung hielt sich dann für eine Unter-Sitzung der fremden:
 * „Transcript saving is off — inherited CLAUDE…", kein Verlauf, kein /resume.
 * Am Mac nachgewiesen: Claude-Prozesse in TMS-Terminals trugen
 * CLAUDE_CODE_CHILD_SESSION=1 und die Sitzungs-ID einer anderen Sitzung.
 */
test('scrubInheritedSession: Kennzeichen einer fremden Claude-Sitzung gehen nicht an neue Terminals', () => {
  const env = scrubInheritedSession({
    PATH: '/usr/bin', HOME: '/Users/x',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: '82f3ff74',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_EXECPATH: '/x/claude',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'geheim',
    CLAUDE_PID: '62113',
    CLAUDE_EFFORT: 'high',
    // Einstellungen des Nutzers bleiben:
    CLAUDE_CONFIG_DIR: '/Users/x/.claude',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    ANTHROPIC_API_KEY: 'sk-test',
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH',
  ]);
});
