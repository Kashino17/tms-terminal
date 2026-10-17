import { execFile, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { helperBinaryPath } from '../remote/paths';
import { logger } from '../utils/logger';

const KEYCHAIN_SERVICE = 'tms-terminal-mac-unlock';

function currentAccount(): string {
  try {
    return os.userInfo().username || process.env.USER || 'default';
  } catch {
    return process.env.USER || 'default';
  }
}

/**
 * Checks whether a Mac unlock password is stored in the macOS login Keychain.
 */
export function hasMacUnlockPassword(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const account = currentAccount();
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
      { timeout: 4000 },
      (err) => resolve(!err),
    );
  });
}

/**
 * Retrieves the Mac unlock password from the macOS login Keychain.
 * Never leaves the Mac — used only locally to unlock the screen or answer sudo.
 */
export function getMacUnlockPassword(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const account = currentAccount();
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const pw = stdout.replace(/\r?\n$/, '');
        resolve(pw.length > 0 ? pw : null);
      },
    );
  });
}

/**
 * Stores or updates the Mac unlock password in the macOS login Keychain (`-U`).
 */
export function setMacUnlockPassword(password: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !password) return Promise.resolve(false);
  const account = currentAccount();
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', password],
      { timeout: 5000 },
      (err) => {
        if (err) {
          logger.warn(`Mac-Unlock: Keychain save failed — ${err.message}`);
          resolve(false);
          return;
        }
        logger.success(`Mac-Unlock: Passwort sicher im macOS-Schlüsselbund hinterlegt (${account})`);
        resolve(true);
      },
    );
  });
}

/**
 * Removes the stored Mac unlock password from the macOS login Keychain.
 */
export function deleteMacUnlockPassword(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const account = currentAccount();
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
      { timeout: 4000 },
      (err) => resolve(!err),
    );
  });
}

/**
 * Wakes the Mac display, types the stored Keychain password at the HID level
 * (works on the macOS lock screen AND inside SecurityAgent password dialogs),
 * and presses Return.
 */
export async function unlockMacScreen(explicitPassword?: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Nur auf macOS unterstützt' };
  }

  const pw = explicitPassword ?? (await getMacUnlockPassword());
  if (!pw) {
    return { ok: false, error: 'not_configured' };
  }

  // Wake display first via caffeinate -u so loginwindow / lock screen is ready for keystrokes
  await new Promise<void>((resolve) => {
    execFile('/usr/bin/caffeinate', ['-u', '-t', '2'], { timeout: 1500 }, () => resolve());
  });

  const helper = helperBinaryPath();
  if (fs.existsSync(helper)) {
    return new Promise((resolve) => {
      const proc = spawn(helper, ['--unlock'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({ ok: false, error: 'Zeitüberschreitung beim Entsperren' });
      }, 6000);

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.stdin?.on('error', () => {});
      proc.stdin?.write(pw + '\n');
      proc.stdin?.end();

      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          logger.info('Mac-Unlock: Bildschirm/Dialog per Fingerabdruck entsperrt');
          resolve({ ok: true });
        } else {
          logger.warn(`Mac-Unlock: Helfer beendet (${code}) — ${stderr.trim()}`);
          resolve({ ok: false, error: stderr.trim() || `Helfer-Fehler (${code})` });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
    });
  }

  // Fallback via osascript (System Events) passing password via environment variable
  return new Promise((resolve) => {
    const script = 'tell application "System Events" to keystroke (system attribute "TMS_UNLOCK_PW") & return';
    execFile(
      '/usr/bin/osascript',
      ['-e', script],
      { timeout: 5000, env: { ...process.env, TMS_UNLOCK_PW: pw } },
      (err) => {
        if (err) {
          resolve({ ok: false, error: err.message });
        } else {
          logger.info('Mac-Unlock: Bildschirm per AppleScript entsperrt');
          resolve({ ok: true });
        }
      },
    );
  });
}
