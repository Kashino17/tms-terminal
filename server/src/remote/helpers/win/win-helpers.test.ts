/**
 * Windows helpers are C# inside PowerShell double-quoted here-strings
 * (Add-Type @" ... "@). PowerShell rewrites such strings before the C#
 * compiler sees them: `$name` is expanded, and a backtick is an escape —
 * "`r" becomes a carriage return, which C# reads as a line break. A single
 * "`rel`" in a C# comment once broke the input helper's compile on the PC
 * (the mouse did not move at all) while every check on the Mac passed.
 *
 * And the server runs without a console on Windows: every child process
 * started without `windowsHide` opens its own visible console window there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HELPERS = __dirname;
const REMOTE = path.join(__dirname, '..', '..');

test('Add-Type C# contains nothing PowerShell would rewrite ($ or backtick)', () => {
  const scripts = fs.readdirSync(HELPERS).filter((f) => f.endsWith('.ps1'));
  assert.ok(scripts.length >= 5, 'helper scripts found');
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(HELPERS, f), 'utf8');
    if (!src.includes('Add-Type')) continue;
    const blocks = [...src.matchAll(/@"\r?\n([\s\S]*?)\r?\n"@/g)].map((m) => m[1]);
    assert.ok(blocks.length > 0, `${f}: Add-Type block found`);
    for (const body of blocks) {
      body.split('\n').forEach((line, i) => {
        assert.ok(!line.includes('`'), `${f}, C# line ${i + 1}: backtick — PowerShell treats it as an escape: ${line.trim()}`);
        assert.ok(!line.includes('$'), `${f}, C# line ${i + 1}: $ — PowerShell expands it: ${line.trim()}`);
      });
    }
  }
});

test('every Windows remote child process starts hidden (no console window on the PC)', () => {
  for (const rel of ['capture/capture.win32.ts', 'input/input.win32.ts']) {
    const src = fs.readFileSync(path.join(REMOTE, rel), 'utf8');
    const calls = src.split(/\b(?:spawn|execFileSync)\(/).slice(1);
    assert.ok(calls.length > 0, `${rel}: process starts found`);
    for (const call of calls) {
      const args = call.slice(0, call.indexOf('}') + 1);
      assert.match(args, /windowsHide: true/, `${rel}: started without windowsHide: ${args.slice(0, 80)}`);
    }
  }
});

test('virtual display setup: both downloads pinned to a version AND a SHA-256', () => {
  const src = fs.readFileSync(path.join(HELPERS, 'display-setup.ps1'), 'utf8');
  for (const name of ['Driver', 'Nefcon']) {
    assert.match(src, new RegExp(`\\$${name}Url\\s*=\\s*'https://github\\.com/[^']+/releases/download/[^/']+/[^']+\\.zip'`), `${name}: fixed release URL`);
    assert.match(src, new RegExp(`\\$${name}Sha\\s*=\\s*'[0-9A-F]{64}'`), `${name}: SHA-256`);
  }
  assert.match(src, /Get-FileHash/, 'checksum is actually checked');
});

test('virtual display: the SYSTEM task script only ever reads on/off', () => {
  const src = fs.readFileSync(path.join(HELPERS, 'display-task.ps1'), 'utf8');
  assert.match(src, /if \(\$w -eq 'on'\) \{ \$want = 'on' \}/);
  assert.doesNotMatch(src, /Invoke-Expression|iex |Start-Process|& \$/, 'nothing from the want file is executed');
});
