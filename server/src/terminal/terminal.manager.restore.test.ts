import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import { globalManager } from './terminal.manager';

const noop = (): void => {};

test('a preset id is used verbatim — the app finds its tabs by it', () => {
  const wanted = 'vorgegebene-id-123';
  const session = globalManager.createSession({ cols: 80, rows: 24, id: wanted }, noop, noop);
  try {
    assert.equal(session.id, wanted);
    assert.equal(globalManager.getSession(wanted)?.id, wanted);
  } finally {
    globalManager.closeSession(session.id);
  }
});

test('without an id a fresh uuid is generated as before', () => {
  const a = globalManager.createSession({ cols: 80, rows: 24 }, noop, noop);
  const b = globalManager.createSession({ cols: 80, rows: 24 }, noop, noop);
  try {
    assert.notEqual(a.id, b.id);
    assert.match(a.id, /^[0-9a-f-]{36}$/);
  } finally {
    globalManager.closeSession(a.id);
    globalManager.closeSession(b.id);
  }
});

test('listSessions reports the live sessions', () => {
  const before = globalManager.listSessions().length;
  const s = globalManager.createSession({ cols: 80, rows: 24 }, noop, noop);
  try {
    assert.equal(globalManager.listSessions().length, before + 1);
    assert.ok(globalManager.listSessions().some(x => x.id === s.id));
  } finally {
    globalManager.closeSession(s.id);
  }
  assert.equal(globalManager.listSessions().length, before);
});

test('a vanished cwd falls back to home instead of failing to start', () => {
  const s = globalManager.createSession(
    { cols: 80, rows: 24, cwd: '/definitiv/nicht/da' }, noop, noop);
  try {
    assert.ok(s.pty.pid > 0, 'die Shell läuft trotzdem');
  } finally {
    globalManager.closeSession(s.id);
  }
});

test('a real cwd is honoured', async () => {
  const target = os.tmpdir();
  // macOS meldet /private/var/... für /var/... — beide Formen zulassen.
  const bare = target.replace(/^\/private/, '');
  const seen = (out: string): boolean => out.includes(bare) || out.includes(`/private${bare}`);

  let output = '';
  const s = globalManager.createSession(
    { cols: 80, rows: 24, cwd: target },
    (_id, data) => { output += data; },
    noop,
  );

  try {
    // Auf die Ausgabe warten statt auf die Uhr. Ein festes setTimeout direkt
    // nach dem Anlegen schreibt in eine Shell, die noch .zshrc lädt — der
    // Befehl geht verloren. Genau dafür gibt es looksReady() im Feature.
    const deadline = Date.now() + 8000;
    let sent = false;
    while (Date.now() < deadline) {
      if (!sent && /[$%>#❯›]\s*$/.test(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd())) {
        sent = true;
        globalManager.write(s.id, 'pwd\r');
      }
      if (sent && seen(output)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(seen(output), `erwartete ${bare} in der Ausgabe, bekam: ${output.slice(-300)}`);
  } finally {
    globalManager.closeSession(s.id);
  }
});
