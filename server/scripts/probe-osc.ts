/**
 * Records raw PTY bytes to find out whether anything actually emits OSC title
 * sequences (ESC ] 0/1/2 ; text BEL). Spawns its own pty — the running server
 * and its terminal sessions are never touched.
 *
 * Usage: node --require ts-node/register scripts/probe-osc.ts [seconds]
 *
 * Drives an interactive `claude` non-interactively: waits for it to come up,
 * sends one short prompt, waits, then quits. Titles, if any, appear during that.
 */
import * as fs from 'fs';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty');

const OUT = '/tmp/osc-probe.raw';
const TOTAL_SECONDS = Number(process.argv[2] ?? '45');

fs.writeFileSync(OUT, '');

const term = pty.spawn(process.env.SHELL ?? '/bin/zsh', [], {
  name: 'xterm-256color',
  cols: 120, rows: 30,
  cwd: os.homedir(),
  env: { ...process.env, TERM: 'xterm-256color' },
});

let bytes = 0;
term.onData((d: string) => {
  bytes += d.length;
  fs.appendFileSync(OUT, d);
});

const say = (msg: string): void => console.log(`[probe] ${msg}`);

// A plain shell escape first — proves the pty passes OSC through at all, which
// separates "node-pty swallows it" from "Claude Code never sends one".
setTimeout(() => { say('sending a control OSC from the shell'); term.write("printf '\\033]0;PROBE-CONTROL\\007'\r"); }, 1500);
setTimeout(() => { say('starting claude'); term.write('claude\r'); }, 3500);
setTimeout(() => { say('sending a short prompt'); term.write('sag nur hallo\r'); }, 14000);
setTimeout(() => { say('quitting claude'); term.write('\x03'); }, TOTAL_SECONDS * 1000 - 6000);
setTimeout(() => { term.write('/exit\r'); }, TOTAL_SECONDS * 1000 - 4000);
setTimeout(() => { term.write('exit\r'); }, TOTAL_SECONDS * 1000 - 2000);

setTimeout(() => {
  say(`captured ${bytes} bytes → ${OUT}`);
  try { term.kill(); } catch { /* already gone */ }
  process.exit(0);
}, TOTAL_SECONDS * 1000);
