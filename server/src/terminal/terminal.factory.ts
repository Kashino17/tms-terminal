import * as pty from 'node-pty';
import { getDefaultShell, getShellArgs, getTermEnv, getPlatform } from '../utils/platform';
import { logger } from '../utils/logger';
import * as os from 'os';
import * as fs from 'fs';

export function createPty(
  cols: number,
  rows: number,
  extraEnv: Record<string, string> = {},
  cwd?: string,
): pty.IPty {
  const shell = getDefaultShell();
  const args = getShellArgs();
  // extraEnv carries per-session vars (e.g. TMS_SESSION_ID) that the cached,
  // process-global getTermEnv() can't know.
  const env = { ...getTermEnv(), ...extraEnv };
  const isWin = getPlatform() === 'win32';

  logger.info(`Spawning shell: ${shell} ${args.join(' ')} (${cols}x${rows})`);

  const opts: pty.IPtyForkOptions = {
    cols,
    rows,
    // Ein vorgegebenes Verzeichnis wird beim Start gesetzt statt hinterher per
    // "cd" hineingeschrieben: kein Eintrag in der Shell-History, kein Wettlauf
    // mit der Shell-Initialisierung, und die Karte zeigt sofort den Pfad.
    // Ein verschwundener Ordner fällt still auf Home zurück — das Terminal muss
    // trotzdem zurückkommen.
    cwd: cwd !== undefined && fs.existsSync(cwd) ? cwd : os.homedir(),
    env,
  };

  if (isWin) {
    // Use ConPTY on Windows 10 1809+ — handles ANSI sequences properly
    (opts as any).useConpty = true;
    (opts as any).conptyInheritCursor = false;
  } else {
    // TERM name is only meaningful on Unix
    opts.name = 'xterm-256color';
  }

  return pty.spawn(shell, args, opts);
}
