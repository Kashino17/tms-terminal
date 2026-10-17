import fs from 'fs';
import os from 'os';
import path from 'path';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
let logCalls = 0;

function rotateLogsIfNeeded(): void {
  if (++logCalls % 500 !== 1) return;
  try {
    const logDir = path.join(os.homedir(), 'Library', 'Logs');
    for (const file of ['tms-terminal.log', 'tms-terminal-error.log']) {
      const full = path.join(logDir, file);
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      if (st.size > MAX_LOG_BYTES) {
        fs.copyFileSync(full, `${full}.1`);
        fs.truncateSync(full, 0);
      }
    }
  } catch {
    // ignore log rotation errors
  }
}

/** Local time of the machine (the log is read by a person in that time zone —
 *  UTC stamps had to be converted by hand, e.g. +8 h in Bali). */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    rotateLogsIfNeeded();
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.blue}INFO${colors.reset}  ${msg}`, ...args);
  },
  success(msg: string, ...args: unknown[]): void {
    rotateLogsIfNeeded();
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.green}OK${colors.reset}    ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    rotateLogsIfNeeded();
    console.warn(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.yellow}WARN${colors.reset}  ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    rotateLogsIfNeeded();
    console.error(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.red}ERROR${colors.reset} ${msg}`, ...args);
  },
};
