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
    // Prefer PowerShell 7 (pwsh) > Windows PowerShell > cmd.exe
    const pwsh = process.env.PROGRAMFILES
      ? `${process.env.PROGRAMFILES}\\PowerShell\\7\\pwsh.exe`
      : null;
    try {
      if (pwsh && require('fs').existsSync(pwsh)) return pwsh;
    } catch { /* ignore */ }
    return 'powershell.exe';
  }

  return process.env.SHELL || '/bin/zsh';
}

export function getShellArgs(): string[] {
  const platform = getPlatform();

  if (platform === 'win32') {
    const shell = getDefaultShell().toLowerCase();
    if (shell.includes('pwsh') || shell.includes('powershell')) {
      return ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8'];
    }
    // cmd.exe — set UTF-8 codepage
    return ['/k', 'chcp 65001 >nul'];
  }

  return ['-l']; // login shell on unix
}

const SENSITIVE_VARS = ['JWT_SECRET', 'TMS_PASSWORD', 'FIREBASE_PRIVATE_KEY'];

let cachedEnv: Record<string, string> | null = null;

export function getTermEnv(): Record<string, string> {
  if (cachedEnv) return { ...cachedEnv }; // shallow copy of cached

  const platform = getPlatform();
  const filtered = Object.fromEntries(
    Object.entries(process.env).filter(([key, v]) => v !== undefined && !SENSITIVE_VARS.includes(key))
  ) as Record<string, string>;
  const env: Record<string, string> = {
    ...filtered,
    COLORTERM: 'truecolor',
  };

  if (platform === 'win32') {
    // Force UTF-8 for Windows programs that check these
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.LANG = 'en_US.UTF-8';
    // Don't set TERM on Windows — ConPTY doesn't use it
  } else {
    env.TERM = 'xterm-256color';
  }

  cachedEnv = env;
  return { ...cachedEnv };
}
