import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serverRoot } from './paths';

/** Builds a fake package root plus both directory shapes that `serverRoot`
 *  needs to resolve equally well: the ts-node layout (`src/remote`) and the
 *  compiled layout (`dist/server/src/remote`, one level deeper because of
 *  `rootDir: ..`). Returns the root and both leaf directories. */
function makeFakePackage(): { root: string; tsNodeDir: string; distDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-paths-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  const tsNodeDir = path.join(root, 'src', 'remote');
  fs.mkdirSync(tsNodeDir, { recursive: true });

  const distDir = path.join(root, 'dist', 'server', 'src', 'remote');
  fs.mkdirSync(distDir, { recursive: true });

  return { root, tsNodeDir, distDir };
}

test('serverRoot findet dieselbe Wurzel unter der ts-node- und der dist-Ordnerlage', () => {
  const { root, tsNodeDir, distDir } = makeFakePackage();

  const fromTsNode = serverRoot(tsNodeDir);
  const fromDist = serverRoot(distDir);

  assert.equal(fs.realpathSync(fromTsNode), fs.realpathSync(root));
  assert.equal(fs.realpathSync(fromDist), fs.realpathSync(root));
});

test('serverRoot wirft eine sprechende Fehlermeldung statt still einen falschen Pfad zu liefern', () => {
  // A directory tree with no package.json anywhere above it.
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-paths-orphan-'));
  const nested = path.join(orphan, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });

  assert.throws(() => serverRoot(nested), /Could not locate the server package root/);
});
