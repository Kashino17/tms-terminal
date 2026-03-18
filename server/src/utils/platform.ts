import * as os from 'os';

export type Platform = 'darwin' | 'win32' | 'linux';

export function getPlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  return 'linux'; // fallback
}

export function getDefaultShell(): string {
  const platform = getPlatform();

  if (platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }

  return process.env.SHELL || '/bin/zsh';
}

export function getShellArgs(): string[] {
  const platform = getPlatform();

  if (platform === 'win32') {
    const shell = getDefaultShell().toLowerCase();
    if (shell.includes('powershell')) {
      return ['-NoLogo'];
    }
    return [];
  }

  return ['-l']; // login shell on unix
}

const SENSITIVE_VARS = ['JWT_SECRET', 'TMS_PASSWORD', 'FIREBASE_PRIVATE_KEY'];

export function getTermEnv(): Record<string, string> {
  const platform = getPlatform();
  const filtered = Object.fromEntries(
    Object.entries(process.env).filter(([key, v]) => v !== undefined && !SENSITIVE_VARS.includes(key))
  ) as Record<string, string>;
  const env: Record<string, string> = {
    ...filtered,
    COLORTERM: 'truecolor',
  };

  if (platform !== 'win32') {
    env.TERM = 'xterm-256color';
  }

  return env;
}
