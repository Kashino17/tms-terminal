import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The stamp the build wrote next to itself (dist/build-info.json, see
 * bin/update-runner.js writeBuildInfo). Read ONCE at startup: it describes
 * the code this process is running, even if a newer build lands on disk
 * later. null when started from source or from a build without a stamp.
 */
export interface BuildInfo { short: string; branch: string; subject: string; builtAt: string }

export function readBuildInfo(distDir: string): BuildInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(distDir, 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    if (typeof raw.short !== 'string' || !raw.short) return null;
    return {
      short: raw.short, branch: String(raw.branch ?? ''), subject: String(raw.subject ?? ''), builtAt: String(raw.builtAt ?? ''),
    };
  } catch { return null; }
}

/** dist/server/src/utils → dist */
export const RUNNING_BUILD = readBuildInfo(path.resolve(__dirname, '..', '..', '..'));
export const STARTED_AT = new Date().toISOString();
