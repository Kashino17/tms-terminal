import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Finds the server package root by walking up from `startDir` until a
 * directory containing `package.json` is found.
 *
 * This matters because `tsc` compiles with `rootDir: ..` (to also pick up
 * `../shared`), which puts compiled output one directory deeper than the
 * source: this very file lives at `server/src/remote/paths.ts` under
 * `ts-node`, but at `server/dist/server/src/remote/paths.ts` once compiled.
 * `tsc` also never copies `package.json` into `dist`, so walking up to the
 * nearest one lands on `server/` from either location — that's the anchor
 * every helper-path lookup in this module is built on.
 *
 * @param startDir Directory to start searching from. Defaults to this
 *   file's own directory, which is the value that makes the trick work.
 */
export function serverRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root without finding a package.json — bail
      // loudly instead of silently returning a bogus path.
      throw new Error(
        `Could not locate the server package root: no package.json found above ${startDir}`,
      );
    }
    dir = parent;
  }
}

/** `<root>/bin/tms-remote-helper` — the compiled macOS capture/input helper binary. */
export function helperBinaryPath(): string {
  return path.join(serverRoot(), 'bin', 'tms-remote-helper');
}

/** `<root>/src/remote/helpers/mac/build.sh` — builds the macOS helper binary. */
export function macBuildScriptPath(): string {
  return path.join(serverRoot(), 'src', 'remote', 'helpers', 'mac', 'build.sh');
}

/** `<root>/src/remote/helpers/win/input-helper.ps1` — the Windows input-injection script. */
export function winInputScriptPath(): string {
  return path.join(serverRoot(), 'src', 'remote', 'helpers', 'win', 'input-helper.ps1');
}
