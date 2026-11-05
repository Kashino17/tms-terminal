import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCwd, pickForegroundFromTable } from './cwd.utils';

// Windows process table rows as "pid,parentPid,name" (Get-CimInstance Win32_Process).
test('pickForegroundFromTable: npm-installed OpenCode on Windows → the deepest descendant', () => {
  const table = [
    '100,1,OpenConsole.exe',
    '200,100,pwsh.exe',          // the TMS shell
    '300,200,node.exe',          // npm launcher
    '400,300,opencode.exe',      // the real TUI
    '500,1,explorer.exe',
  ].join('\r\n');
  assert.equal(pickForegroundFromTable(table, 200), 'opencode.exe');
});

test('pickForegroundFromTable: idle shell → its own name', () => {
  assert.equal(pickForegroundFromTable('200,100,pwsh.exe\r\n500,1,explorer.exe', 200), 'pwsh.exe');
});

test('pickForegroundFromTable: console helpers are not the foreground program', () => {
  const table = '200,100,pwsh.exe\r\n210,200,conhost.exe\r\n220,200,claude.exe';
  assert.equal(pickForegroundFromTable(table, 200), 'claude.exe');
});

test('pickForegroundFromTable: garbage and unknown pids → null', () => {
  assert.equal(pickForegroundFromTable('', 200), null);
  assert.equal(pickForegroundFromTable('x,y,z\r\n1,0,System', 200), null);
});

const HOME = '/Users/ayysir';

test('normalizeCwd: home itself -> ~', () => {
  assert.equal(normalizeCwd('/Users/ayysir', HOME), '~');
  assert.equal(normalizeCwd('/Users/ayysir/', HOME), '~');
});

test('normalizeCwd: under home -> ~/rest', () => {
  assert.equal(normalizeCwd('/Users/ayysir/Desktop/TMS Terminal', HOME), '~/Desktop/TMS Terminal');
  assert.equal(normalizeCwd('/Users/ayysir/projects/api/', HOME), '~/projects/api');
});

test('normalizeCwd: outside home unchanged', () => {
  assert.equal(normalizeCwd('/etc/nginx', HOME), '/etc/nginx');
  assert.equal(normalizeCwd('/', HOME), '/');
});

test('normalizeCwd: home-prefixed but not a path boundary stays literal', () => {
  // "/Users/ayysir-backup" must NOT become "~-backup"
  assert.equal(normalizeCwd('/Users/ayysir-backup/x', HOME), '/Users/ayysir-backup/x');
});

test('normalizeCwd: empty stays empty', () => {
  assert.equal(normalizeCwd('', HOME), '');
});
