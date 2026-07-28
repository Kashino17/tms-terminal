import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listEntries, addEntry, updateEntry, completeEntry, deleteEntry, openCount,
} from './entries.store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-entries-'));
}

test('an added entry survives a reload', () => {
  const dir = tmpDir();
  const created = addEntry({ text: 'Server neu bauen', checkable: true }, dir);
  const [loaded] = listEntries(undefined, dir);
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.text, 'Server neu bauen');
  assert.equal(loaded.checkable, true);
  assert.equal(loaded.done, false);
});

test('entries default to being a note, not a to-do', () => {
  const dir = tmpDir();
  const e = addEntry({ text: 'Idee: Manager könnte Wetter zeigen' }, dir);
  assert.equal(e.checkable, false, 'without an explicit flag it is a note');
});

test('onlyOpen excludes notes and finished to-dos', () => {
  const dir = tmpDir();
  addEntry({ text: 'Notiz', checkable: false }, dir);
  const todo = addEntry({ text: 'Offenes To-do', checkable: true }, dir);
  const doneOne = addEntry({ text: 'Erledigtes To-do', checkable: true }, dir);
  completeEntry(doneOne.id, true, dir);

  const open = listEntries({ onlyOpen: true }, dir);
  assert.equal(open.length, 1);
  assert.equal(open[0].id, todo.id);
  assert.equal(openCount(dir), 1);
});

test('the project filter narrows the list', () => {
  const dir = tmpDir();
  addEntry({ text: 'A', project: 'proj-a' }, dir);
  addEntry({ text: 'B', project: 'proj-b' }, dir);
  addEntry({ text: 'C' }, dir);
  assert.equal(listEntries({ project: 'proj-a' }, dir).length, 1);
});

test('completing bumps updatedAt and is reversible', () => {
  const dir = tmpDir();
  const e = addEntry({ text: 'X', checkable: true }, dir);
  const before = e.updatedAt;
  const done = completeEntry(e.id, true, dir)!;
  assert.equal(done.done, true);
  assert.ok(done.updatedAt >= before);
  const undone = completeEntry(e.id, false, dir)!;
  assert.equal(undone.done, false);
});

test('updating cannot rewrite id or createdAt', () => {
  const dir = tmpDir();
  const e = addEntry({ text: 'Original' }, dir);
  const patched = updateEntry(e.id, {
    text: 'Geändert', id: 'gefälscht', createdAt: 0,
  } as Partial<import('./entries.types').Entry>, dir)!;
  assert.equal(patched.text, 'Geändert');
  assert.equal(patched.id, e.id);
  assert.equal(patched.createdAt, e.createdAt);
});

test('unknown ids report failure instead of throwing', () => {
  const dir = tmpDir();
  assert.equal(updateEntry('nope', { text: 'x' }, dir), null);
  assert.equal(completeEntry('nope', true, dir), null);
  assert.equal(deleteEntry('nope', dir), false);
});

test('deleting removes exactly one entry', () => {
  const dir = tmpDir();
  const a = addEntry({ text: 'A' }, dir);
  addEntry({ text: 'B' }, dir);
  assert.equal(deleteEntry(a.id, dir), true);
  assert.deepEqual(listEntries(undefined, dir).map(e => e.text), ['B']);
});

test('entries are never capped — user data must not silently vanish', () => {
  const dir = tmpDir();
  for (let i = 0; i < 600; i++) addEntry({ text: `Eintrag ${i}` }, dir);
  assert.equal(listEntries(undefined, dir).length, 600);
});
