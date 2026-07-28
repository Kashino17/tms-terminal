import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOscTitles, OscTitleTracker } from './osc';

const BEL = '\x07';
const ST = '\x1b\\';

test('extracts a title from an OSC 0 sequence', () => {
  assert.deepEqual(extractOscTitles(`vor\x1b]0;Mein Titel${BEL}nach`), ['Mein Titel']);
});

test('accepts OSC 1 and 2 and the ST terminator', () => {
  assert.deepEqual(extractOscTitles(`\x1b]2;Zwei${ST}`), ['Zwei']);
  assert.deepEqual(extractOscTitles(`\x1b]1;Eins${BEL}`), ['Eins']);
});

test('ignores OSC 7 (working directory) and OSC 8 (hyperlinks)', () => {
  // Both really occur in the stream — the probe on 2026-07-28 caught an OSC 7.
  assert.deepEqual(extractOscTitles(`\x1b]7;file://host/tmp${BEL}`), []);
  assert.deepEqual(extractOscTitles(`\x1b]8;;https://example.com${BEL}Text\x1b]8;;${BEL}`), []);
});

test('reads the real Claude Code startup title', () => {
  // Captured verbatim from /tmp/osc-probe.raw.
  assert.deepEqual(extractOscTitles(`\x1b]0;✳ Claude Code${BEL}`), ['✳ Claude Code']);
});

test('returns several titles in order', () => {
  assert.deepEqual(
    extractOscTitles(`\x1b]0;A${BEL}mitte\x1b]0;B${BEL}`),
    ['A', 'B'],
  );
});

test('plain output yields nothing', () => {
  assert.deepEqual(extractOscTitles('npm run build\nfertig\n'), []);
});

test('an empty title is ignored — the shell clears the title that way', () => {
  // The probe caught a bare `ESC ] 0 ; BEL` when the shell prompt returned.
  assert.deepEqual(extractOscTitles(`\x1b]0;${BEL}`), []);
});

test('the tracker reports only real changes', () => {
  const t = new OscTitleTracker();
  assert.equal(t.feed('s1', `\x1b]0;Erstes Thema${BEL}`), 'Erstes Thema');
  assert.equal(t.feed('s1', `\x1b]0;Erstes Thema${BEL}`), null, 'same title is not a change');
  assert.equal(t.feed('s1', `\x1b]0;Zweites Thema${BEL}`), 'Zweites Thema');
  assert.equal(t.getTitle('s1'), 'Zweites Thema');
});

test('a sequence split across two chunks is still recognised', () => {
  const t = new OscTitleTracker();
  assert.equal(t.feed('s1', '\x1b]0;Halb'), null, 'incomplete — nothing yet');
  assert.equal(t.feed('s1', `er Titel${BEL}`), 'Halber Titel');
});

test('sessions do not bleed into each other', () => {
  const t = new OscTitleTracker();
  t.feed('s1', `\x1b]0;A${BEL}`);
  t.feed('s2', `\x1b]0;B${BEL}`);
  assert.equal(t.getTitle('s1'), 'A');
  assert.equal(t.getTitle('s2'), 'B');
  t.clear('s1');
  assert.equal(t.getTitle('s1'), undefined);
  assert.equal(t.getTitle('s2'), 'B');
});

test('a runaway partial buffer cannot grow without bound', () => {
  const t = new OscTitleTracker();
  t.feed('s1', '\x1b]0;' + 'x'.repeat(50_000)); // never terminated
  assert.equal(t.feed('s1', `${BEL}`), null, 'oversized partial is dropped, not kept forever');
});
