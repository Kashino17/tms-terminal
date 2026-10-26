/**
 * Wire format between the server and the terminal keeper daemon (ptyd):
 * one JSON object per line over a Unix socket. JSON escapes every control
 * byte and newline inside terminal output, so a line break can only ever be
 * a message boundary.
 *
 * Server → daemon
 *   { t:'attach' }               first message: "I am the server now" (a bare
 *                                connect is only a liveness probe)
 *   { t:'info' }                 instead of attach: one-shot status for the CLI,
 *                                answered with { t:'info', pid, startedAt,
 *                                serverAttached, sessions } — never attaches
 *   { t:'create', id, file, args, cwd, env, cols, rows }
 *   { t:'in', id, d }            keystrokes / pasted text
 *   { t:'rs', id, c, r }         resize
 *   { t:'kill', id }             the user closed the terminal
 * Daemon → server
 *   { t:'hello', v, pid }        on every (re)connect
 *   { t:'list', sessions:[{ id, pid, cols, rows }] }   right after hello
 *   { t:'created', id, pid }     answer to create
 *   { t:'fail', id, error }      create failed
 *   { t:'out', id, d }           terminal output (buffered while no server was attached)
 *   { t:'exit', id, code, signal }
 *
 * The protocol must stay backward compatible: a running daemon outlives
 * server updates on purpose, so a newer server talks to an older daemon.
 */
export const PTYD_PROTOCOL_VERSION = 1;

export type WireMessage = { t: string; [key: string]: unknown };

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg) + '\n';
}

export interface Decoder { push(chunk: string): void }

export function createDecoder(onMessage: (msg: WireMessage) => void): Decoder {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      let nl = rest.indexOf('\n');
      while (nl !== -1) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (line) {
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { msg = null; }
          if (msg && typeof (msg as WireMessage).t === 'string') onMessage(msg as WireMessage);
        }
        nl = rest.indexOf('\n');
      }
    },
  };
}
