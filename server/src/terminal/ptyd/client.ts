/**
 * Server side of the terminal keeper daemon (see daemon.ts): connects to it
 * (starting it if nobody is listening), hands out PtyLike proxies for new
 * terminals, and — after a server restart — the terminals that kept running.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { encode, createDecoder, type WireMessage } from './wire';
import type { PtyLike } from '../terminal.types';

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;

/**
 * One terminal held by the daemon. Output that arrives before anyone listens
 * (the daemon flushes its buffer right after connecting, before the manager
 * has wired the adopted session) is kept and delivered to the first listener.
 */
export class RemotePty implements PtyLike {
  private dataListeners: DataListener[] = [];
  private exitListeners: ExitListener[] = [];
  private early: string[] = [];
  private exited: { exitCode: number; signal?: number } | null = null;

  constructor(
    readonly id: string,
    private _pid: number,
    private readonly sendMsg: (m: WireMessage) => void,
  ) {}

  get pid(): number { return this._pid; }
  /** @internal */ setPid(pid: number): void { this._pid = pid; }

  onData(listener: DataListener) {
    this.dataListeners.push(listener);
    if (this.early.length) { const e = this.early.splice(0); for (const d of e) listener(d); }
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== listener); } };
  }

  onExit(listener: ExitListener) {
    this.exitListeners.push(listener);
    if (this.exited) listener(this.exited);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== listener); } };
  }

  write(data: string): void { this.sendMsg({ t: 'in', id: this.id, d: data }); }
  resize(cols: number, rows: number): void { this.sendMsg({ t: 'rs', id: this.id, c: cols, r: rows }); }
  kill(): void { this.sendMsg({ t: 'kill', id: this.id }); }

  /** @internal */ deliver(data: string): void {
    if (this.dataListeners.length === 0) { this.early.push(data); return; }
    for (const l of this.dataListeners) l(data);
  }

  /** @internal */ finish(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = { exitCode, signal };
    for (const l of this.exitListeners) l(this.exited);
  }
}

export interface AdoptedTerminal { id: string; pid: number; cols: number; rows: number; pty: RemotePty }

export interface SpawnSpec { file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }

export class PtyDaemonClient {
  private ptys = new Map<string, RemotePty>();
  private sock: net.Socket | null = null;
  private closedByUs = false;
  /** Terminals the daemon already held when we connected (filled from its `list`). */
  adopted: AdoptedTerminal[] = [];
  daemonPid = 0;
  protocol = 0;

  private constructor() {}

  /**
   * Connects to the daemon at `socketPath`, starting `daemonScript` first if
   * nobody listens there. Resolves null if no daemon could be reached — the
   * caller then falls back to plain child PTYs (old behaviour).
   */
  static async start(socketPath: string, daemonScript: string, logFile?: string): Promise<PtyDaemonClient | null> {
    const c = new PtyDaemonClient();
    if (await c.connect(socketPath)) return c;

    const nodeArgs = daemonScript.endsWith('.ts') ? ['--require', 'ts-node/register', daemonScript] : [daemonScript];
    const out = logFile ? fs.openSync(logFile, 'a') : 'ignore';
    // detached = own session: Ctrl+C / SIGHUP in the server's window can't reach it.
    const child = spawn(process.execPath, [...nodeArgs, socketPath], {
      detached: true,
      stdio: ['ignore', out, out],
      cwd: path.dirname(daemonScript),
      env: process.env,
    });
    child.unref();
    if (typeof out === 'number') fs.closeSync(out);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (await c.connect(socketPath)) return c;
    }
    return null;
  }

  private connect(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection(socketPath);
      let settled = false;
      const fail = () => { if (!settled) { settled = true; sock.destroy(); resolve(false); } };
      sock.once('error', fail);
      sock.setEncoding('utf8');
      const dec = createDecoder((m) => {
        if (!settled) {
          // Wait for hello + list so `adopted` is complete when start() resolves.
          if (m.t === 'hello') { this.daemonPid = Number(m.pid) || 0; this.protocol = Number(m.v) || 0; return; }
          if (m.t === 'list') {
            for (const s of (m.sessions as { id: string; pid: number; cols: number; rows: number }[]) ?? []) {
              const p = new RemotePty(s.id, s.pid, (x) => this.send(x));
              this.ptys.set(s.id, p);
              this.adopted.push({ ...s, pty: p });
            }
            settled = true;
            sock.removeListener('error', fail);
            this.sock = sock;
            sock.on('error', () => { /* 'close' follows */ });
            sock.on('close', () => this.onLost());
            resolve(true);
            return;
          }
        }
        this.handle(m);
      });
      sock.on('data', (chunk: string) => dec.push(chunk));
      // Only an explicit attach makes us the daemon's server (see daemon.ts accept()).
      sock.once('connect', () => sock.write(encode({ t: 'attach' })));
      setTimeout(fail, 2000);
    });
  }

  private send(m: WireMessage): void {
    if (this.sock && !this.sock.destroyed) this.sock.write(encode(m));
  }

  private handle(m: WireMessage): void {
    const p = typeof m.id === 'string' ? this.ptys.get(m.id) : undefined;
    switch (m.t) {
      case 'out': if (p && typeof m.d === 'string') p.deliver(m.d); break;
      case 'created': if (p) p.setPid(Number(m.pid) || 0); break;
      case 'fail':
        if (p) { this.ptys.delete(p.id); p.finish(1); }
        break;
      case 'exit':
        if (p) { this.ptys.delete(p.id); p.finish(Number(m.code) || 0, Number(m.signal) || 0); }
        break;
      default: break;
    }
  }

  /** The daemon went away (it died, or was killed): its terminals died with it. */
  private onLost(): void {
    this.sock = null;
    if (this.closedByUs) return;
    for (const p of this.ptys.values()) p.finish(1);
    this.ptys.clear();
  }

  /** New terminal, held by the daemon. pid is known once the daemon answers. */
  spawn(id: string, spec: SpawnSpec): RemotePty {
    const p = new RemotePty(id, 0, (x) => this.send(x));
    this.ptys.set(id, p);
    this.send({ t: 'create', id, ...spec });
    return p;
  }

  get connected(): boolean { return !!this.sock && !this.sock.destroyed; }

  /** Server shutdown: let go WITHOUT touching the terminals — they keep running. */
  release(): void {
    this.closedByUs = true;
    this.sock?.end();
    this.sock = null;
  }
}
