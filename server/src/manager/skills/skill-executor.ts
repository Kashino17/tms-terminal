import { exec } from 'child_process';
import * as fs from 'fs';
import { logger } from '../../utils/logger';

const EXEC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Execute a skill script and return structured results.
 */
export function executeSkillScript(scriptPath: string, args: string[] = []): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    if (!fs.existsSync(scriptPath)) {
      resolve({
        success: false,
        output: '',
        error: `Script nicht gefunden: ${scriptPath}`,
        exitCode: null,
        durationMs: 0,
      });
      return;
    }

    const start = Date.now();

    // Determine how to run the script
    const ext = scriptPath.split('.').pop()?.toLowerCase();
    let command: string;
    if (ext === 'py') {
      command = `python3 "${scriptPath}" ${args.map(a => `"${a}"`).join(' ')}`;
    } else if (ext === 'js' || ext === 'mjs') {
      command = `node "${scriptPath}" ${args.map(a => `"${a}"`).join(' ')}`;
    } else {
      // Default: shell script
      command = `bash "${scriptPath}" ${args.map(a => `"${a}"`).join(' ')}`;
    }

    logger.info(`SkillExec: running ${command}`);

    exec(command, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const output = (stdout || '').trim();
      const errOutput = (stderr || '').trim();

      if (error) {
        const exitCode = error.code ?? null;
        const errorMsg = error.killed
          ? `Timeout nach ${Math.round(EXEC_TIMEOUT_MS / 1000)}s`
          : errOutput || error.message;

        logger.warn(`SkillExec: failed (${exitCode}) in ${durationMs}ms — ${errorMsg.slice(0, 200)}`);
        resolve({
          success: false,
          output,
          error: errorMsg,
          exitCode,
          durationMs,
        });
      } else {
        logger.info(`SkillExec: success in ${durationMs}ms — ${output.slice(0, 100)}`);
        resolve({
          success: true,
          output,
          error: errOutput || undefined,
          exitCode: 0,
          durationMs,
        });
      }
    });
  });
}

/**
 * Check if a system dependency is available.
 */
export function checkDependency(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`which "${command}" 2>/dev/null || where "${command}" 2>nul`, { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Check multiple dependencies and return missing ones.
 */
export async function checkDependencies(deps: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const dep of deps) {
    const available = await checkDependency(dep);
    if (!available) missing.push(dep);
  }
  return missing;
}
