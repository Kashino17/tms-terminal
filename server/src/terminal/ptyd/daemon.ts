/**
 * Terminal keeper daemon (ptyd).
 *
 * Owns every terminal (PTY + shell + whatever runs in it, e.g. Claude Code)
 * so that they survive the TMS server going away — a restart, an update, a
 * crash, Ctrl+C in the server's window. Before this, every PTY was a child
 * of the server process: any server restart killed every terminal, and the
 * restore afterwards only brought back empty shells (Claude's running task
 * was gone).
 *
 * It runs detached (own session, no controlling terminal), so signals aimed
 * at the server's window never reach it. Exactly one server is attached at a
 * time; a new connection replaces the old one. While no server is attached,
 * output is kept (tail, per terminal) and handed over on the next connect.
 *
 * Deliberately small and dependency-free apart from node-pty: this process
 * is meant to run for weeks, and it keeps running across server updates —
 * so its protocol (wire.ts) only ever grows backward compatibly.
 *
 *   node daemon.js <socketPath>
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as pty from 'node-pty';
import { encode, createDecoder, PTYD_PROTOCOL_VERSION, type WireMessage } from './wire';

const SOCK = process.argv[2];
/** Output kept per terminal while no server is attached. */
const BUFFER_MAX = 1_000_000;
/** With no terminals and no server for this long, there is nothing to keep. */
const IDLE_EXIT_MS = Number(process.env.PTYD_IDLE_EXIT_MS) || 10 * 60 * 1000;

interface Held { pty: pty.IPty; cols: number; rows: number; buffer: string }

const held = new Map<string, Held>();
/** Exits that happened while no server was attached — reported on the next connect. */
const pendingExits: WireMessage[] = [];
let client: net.Socket | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function send(msg: WireMessage): boolean {
  if (!client || client.destroyed) return false;
  client.write(encode(msg));
  return true;
}

function armIdleExit(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (held.size > 0 || client) return;
  idleTimer = setTimeout(() => {
    if (held.size === 0 && !client) { log('leer und unbenutzt — beende mich'); cleanupAndExit(0); }
  }, IDLE_EXIT_MS);
}

function cleanupAndExit(code: number): void {
  try { fs.unlinkSync(SOCK); } catch { /* already gone */ }
  process.exit(code);
}

function create(msg: WireMessage): void {
  const id = String(msg.id);
  if (held.has(id)) { send({ t: 'fail', id, error: 'id already exists' }); return; }
  const cols = Number(msg.cols) || 80, rows = Number(msg.rows) || 24;
  let p: pty.IPty;
  try {
    p = pty.spawn(String(msg.file), (msg.args as string[]) ?? [], {
      name: 'xterm-256color',
      cols, rows,
      cwd: typeof msg.cwd === 'string' ? msg.cwd : process.env.HOME,
      env: (msg.env as Record<string, string>) ?? process.env as Record<string, string>,
    });
  } catch (e) {
    send({ t: 'fail', id, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const h: Held = { pty: p, cols, rows, buffer: '' };
  held.set(id, h);
  p.onData((d) => {
    if (send({ t: 'out', id, d })) return;
    h.buffer += d;
    if (h.buffer.length > BUFFER_MAX) h.buffer = h.buffer.slice(h.buffer.length - BUFFER_MAX);
  });
  p.onExit(({ exitCode, signal }) => {
    held.delete(id);
    const exit = { t: 'exit', id, code: exitCode, signal: signal ?? 0 };
    // Output still sitting in the buffer belongs before the exit.
    if (!client && h.buffer) pendingExits.push({ t: 'out', id, d: h.buffer });
    if (!send(exit)) pendingExits.push(exit);
    log(`Terminal ${id} beendet (code ${exitCode}, signal ${signal ?? 0})`);
    armIdleExit();
  });
  log(`Terminal ${id} gestartet (pid ${p.pid}, ${cols}x${rows})`);
  send({ t: 'created', id, pid: p.pid });
  armIdleExit();
}

function handle(msg: WireMessage): void {
  const h = typeof msg.id === 'string' ? held.get(msg.id) : undefined;
  switch (msg.t) {
    case 'create': create(msg); break;
    case 'in': if (h && typeof msg.d === 'string') h.pty.write(msg.d); break;
    case 'rs': {
      const c = Number(msg.c), r = Number(msg.r);
      if (h && c > 0 && r > 0) { h.cols = c; h.rows = r; try { h.pty.resize(c, r); } catch { /* exiting */ } }
      break;
    }
    case 'kill':
      if (h) { log(`Terminal ${msg.id} wird auf Wunsch beendet`); try { h.pty.kill(); } catch { /* gone */ } }
      break;
    default: break;
  }
}

/**
 * A connection only becomes THE server after it says `attach`. A bare
 * connect (another keeper probing whether this one is alive) must not
 * displace the real server — that server would think every terminal died.
 */
function accept(sock: net.Socket): void {
  sock.setEncoding('utf8');
  let attached = false;
  const dec = createDecoder((m) => {
    if (attached) { handle(m); return; }
    if (m.t === 'attach') { attached = true; attach(sock); }
  });
  sock.on('data', (chunk: string) => dec.push(chunk));
  sock.on('error', () => { /* 'close' follows */ });
}

function attach(sock: net.Socket): void {
  if (client && !client.destroyed) {
    log('neuer Server verbindet sich — alte Verbindung wird ersetzt');
    client.destroy();
  }
  client = sock;
  const gone = () => {
    if (client === sock) { client = null; log('Server getrennt — Terminals laufen weiter'); armIdleExit(); }
  };
  sock.on('close', gone);
  sock.on('error', gone);

  send({ t: 'hello', v: PTYD_PROTOCOL_VERSION, pid: process.pid });
  send({ t: 'list', sessions: [...held].map(([id, h]) => ({ id, pid: h.pty.pid, cols: h.cols, rows: h.rows })) });
  for (const [id, h] of held) {
    if (h.buffer) { send({ t: 'out', id, d: h.buffer }); h.buffer = ''; }
  }
  for (const m of pendingExits.splice(0)) send(m);
  log(`Server verbunden — ${held.size} Terminal(s) uebergeben`);
  armIdleExit();
}

function main(): void {
  if (!SOCK) { log('Aufruf: daemon.js <socket>'); process.exit(2); }
  // Never die with the server's window: those signals are meant for the server.
  process.on('SIGINT', () => {});
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => { log('SIGTERM — beende alle Terminals'); for (const h of held.values()) { try { h.pty.kill(); } catch { /* */ } } cleanupAndExit(0); });
  process.on('uncaughtException', (e) => { log(`Fehler (ignoriert): ${e.stack ?? e}`); });

  // Never take over a socket another keeper still answers on — deleting it
  // would orphan that keeper's terminals (alive, but unreachable forever).
  const probe = net.createConnection(SOCK);
  probe.once('connect', () => { probe.destroy(); log('es laeuft bereits ein Waechter — beende mich'); process.exit(0); });
  probe.once('error', () => listen());
}

function listen(): void {
  try { fs.unlinkSync(SOCK); } catch { /* no stale socket */ }
  const server = net.createServer(accept);
  server.on('error', (e) => { log(`Socket-Fehler: ${e.message}`); process.exit(1); });
  server.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o600); } catch { /* best effort */ }
    log(`bereit auf ${SOCK} (pid ${process.pid}, Protokoll v${PTYD_PROTOCOL_VERSION})`);
    armIdleExit();
  });
}

main();
