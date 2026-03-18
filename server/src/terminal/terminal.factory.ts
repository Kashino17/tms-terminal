import * as pty from 'node-pty';
import { getDefaultShell, getShellArgs, getTermEnv } from '../utils/platform';
import { logger } from '../utils/logger';
import * as os from 'os';

export function createPty(cols: number, rows: number): pty.IPty {
  const shell = getDefaultShell();
  const args = getShellArgs();
  const env = getTermEnv();

  logger.info(`Spawning shell: ${shell} ${args.join(' ')} (${cols}x${rows})`);

  return pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env,
  });
}
