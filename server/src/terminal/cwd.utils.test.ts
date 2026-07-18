import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCwd } from './cwd.utils';

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
