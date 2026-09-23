import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PtyDaemonClient, type RemotePty } from './client';

const DAEMON = path.join(__dirname, 'daemon.ts');

function tmpSock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-'));
  return path.join(dir, 's.sock');
}

function collect(p: RemotePty): { text: () => string } {
  let buf = '';
  p.onData((d) => { buf += d; });
  return { text: () => buf };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitueberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;

// Der Kern: ein Server-Neustart (Verbindung weg, neue Verbindung) laesst die
// Terminals weiterlaufen. Frueher starb mit dem Server jedes Terminal — samt
// dem Claude darin.
test('Terminals ueberleben den Wechsel des Servers, verpasste Ausgabe kommt nach', async () => {
  const sock = tmpSock();
  const a = await PtyDaemonClient.start(sock, DAEMON);
  assert.ok(a, 'Waechter erreichbar');
  const daemonPid = a!.daemonPid;
  try {
    const cat = a!.spawn('eins', { file: '/bin/cat', args: [], cwd: os.tmpdir(), env, cols: 80, rows: 24 });
    const out1 = collect(cat);
    cat.write('hallo\r');
    await until(() => out1.text().includes('hallo'));
    await until(() => cat.pid > 0);
    const catPid = cat.pid;

    // Gibt Ausgabe erst aus, wenn der "Server" schon weg ist.
    a!.spawn('zwei', { file: '/bin/sh', args: ['-c', 'sleep 0.6; echo spaet-ausgegeben; sleep 30'], cwd: os.tmpdir(), env, cols: 80, rows: 24 });

    a!.release();                                            // Server "stirbt"
    await new Promise((r) => setTimeout(r, 1200));

    const b = await PtyDaemonClient.start(sock, DAEMON);     // neuer Server
    assert.ok(b);
    assert.equal(b!.daemonPid, daemonPid, 'derselbe Waechter, kein neuer');
    const ids = b!.adopted.map((x) => x.id).sort();
    assert.deepEqual(ids, ['eins', 'zwei']);
    assert.equal(b!.adopted.find((x) => x.id === 'eins')!.pid, catPid, 'derselbe Prozess lebt weiter');

    const zwei = b!.adopted.find((x) => x.id === 'zwei')!.pty;
    const out2 = collect(zwei);
    await until(() => out2.text().includes('spaet-ausgegeben'));

    const eins = b!.adopted.find((x) => x.id === 'eins')!.pty;
    const out3 = collect(eins);
    eins.write('weiter\r');
    await until(() => out3.text().includes('weiter'));

    let exited = false;
    eins.onExit(() => { exited = true; });
    eins.kill();                                             // nur ausdruecklich beenden
    await until(() => exited);
    b!.release();
  } finally {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* schon weg */ }
  }
});

test('ein Terminal, das endet, waehrend kein Server da ist, wird beim naechsten gemeldet', async () => {
  const sock = tmpSock();
  const a = await PtyDaemonClient.start(sock, DAEMON);
  assert.ok(a);
  const daemonPid = a!.daemonPid;
  try {
    a!.spawn('kurz', { file: '/bin/sh', args: ['-c', 'sleep 0.3; echo tschuess; exit 3'], cwd: os.tmpdir(), env, cols: 80, rows: 24 });
    a!.release();
    await new Promise((r) => setTimeout(r, 900));
    const b = await PtyDaemonClient.start(sock, DAEMON);
    assert.ok(b);
    assert.deepEqual(b!.adopted, [], 'es lebt nichts mehr');
    b!.release();
  } finally {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* */ }
  }
});

// Ueber den echten TerminalManager: Server A legt eine Shell an, "stirbt",
// Server B uebernimmt sie. Dieselbe Shell (gleiche PID) arbeitet weiter.
test('TerminalManager: Shell ueberlebt den Serverwechsel und wird uebernommen', async () => {
  const { TerminalManager } = await import('../terminal.manager');
  const { usePtyKeeper } = await import('../terminal.factory');
  const sock = tmpSock();
  const a = await PtyDaemonClient.start(sock, DAEMON);
  assert.ok(a);
  const daemonPid = a!.daemonPid;
  try {
    usePtyKeeper(a);
    const mA = new TerminalManager();
    let outA = '';
    const s = mA.createSession({ cols: 80, rows: 24 }, (_id, d) => { outA += d; }, () => {});
    mA.write(s.id, 'echo vor-dem-neustart-$((20+22))\r');
    await until(() => outA.includes('vor-dem-neustart-42'), 10000);
    await until(() => s.pty.pid > 0);
    const shellPid = s.pty.pid;

    mA.detachSession(s.id);          // App weg (Nacht) — frueher tickten jetzt 4 Stunden
    mA.releaseAllSessions();          // Server faehrt herunter
    a!.release();
    usePtyKeeper(null);

    const b = await PtyDaemonClient.start(sock, DAEMON);
    assert.ok(b);
    usePtyKeeper(b);
    const mB = new TerminalManager();
    const t = b!.adopted.find((x) => x.id === s.id)!;
    assert.ok(t, 'Terminal ist noch da');
    assert.equal(t.pid, shellPid, 'dieselbe Shell');
    mB.adoptSession(t.id, t.pty, t.cols, t.rows);
    let outB = '';
    mB.reattachSession(t.id, (_id, d) => { outB += d; }, () => {});
    mB.write(t.id, 'echo nach-dem-neustart-$((40+2))\r');
    await until(() => outB.includes('nach-dem-neustart-42'), 10000);

    mB.closeSession(t.id);            // nur ausdruecklich
    b!.release();
    usePtyKeeper(null);
  } finally {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* */ }
  }
});

// Ein zweiter Waechter prueft beim Start per blossem Verbinden, ob schon einer
// laeuft. Diese Probe darf den echten Server NICHT verdraengen — der hielte
// sonst jedes Terminal fuer tot.
test('eine Probe-Verbindung verdraengt den verbundenen Server nicht', async () => {
  const net = await import('node:net');
  const sock = tmpSock();
  const a = await PtyDaemonClient.start(sock, DAEMON);
  assert.ok(a);
  const daemonPid = a!.daemonPid;
  try {
    const cat = a!.spawn('p', { file: '/bin/cat', args: [], cwd: os.tmpdir(), env, cols: 80, rows: 24 });
    const out = collect(cat);
    let died = false;
    cat.onExit(() => { died = true; });
    await new Promise<void>((resolve) => {
      const probe = net.createConnection(sock);
      probe.on('connect', () => { probe.destroy(); resolve(); });
      probe.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(a!.connected, true, 'Server bleibt verbunden');
    assert.equal(died, false, 'Terminal gilt nicht als tot');
    cat.write('lebt-noch\r');
    await until(() => out.text().includes('lebt-noch'));
    a!.release();
  } finally {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* */ }
  }
});
