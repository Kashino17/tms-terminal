import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLines } from './lines';

test('vollstaendige Zeilen kommen sofort durch, der Rest bleibt liegen', () => {
  const { lines, rest } = splitLines('', 'eins\nzwei\ndrei-angefangen');
  assert.deepEqual(lines, ['eins', 'zwei']);
  assert.equal(rest, 'drei-angefangen');
});

test('der liegengebliebene Rest wird beim naechsten Aufruf vorangestellt', () => {
  const first = splitLines('', 'Stream #0:0: Video: bgra, 25');
  assert.deepEqual(first.lines, [], 'noch keine vollstaendige Zeile');
  assert.equal(first.rest, 'Stream #0:0: Video: bgra, 25');

  const second = splitLines(first.rest, '60x1440, 30 fps\n');
  assert.deepEqual(second.lines, ['Stream #0:0: Video: bgra, 2560x1440, 30 fps']);
  assert.equal(second.rest, '');
});

test('leere Eingabe liefert keine Zeilen und keinen Rest', () => {
  assert.deepEqual(splitLines('', ''), { lines: [], rest: '' });
});
