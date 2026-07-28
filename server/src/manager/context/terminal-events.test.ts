import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalEventDetector } from './terminal-events';

const MIN = 60_000;

test('a terminal that was busy and then falls quiet is reported once', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);

  det.noteOutput('s1', true);
  assert.deepEqual(det.pollFinished(), [], 'still busy');

  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1'], 'quiet for over two minutes');
  assert.deepEqual(det.pollFinished(), [], 'reported once, not every poll');
});

test('a terminal that was never busy is not reported', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', false);
  t += 10 * MIN;
  assert.deepEqual(det.pollFinished(), [], 'idle chatter is not "finished"');
});

test('new output before the threshold resets the clock', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  t += 90_000;
  det.noteOutput('s1', true);
  t += 90_000;
  assert.deepEqual(det.pollFinished(), [], 'never quiet for a full two minutes');
  t += 40_000;
  assert.deepEqual(det.pollFinished(), ['s1']);
});

test('becoming busy again re-arms the report', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1']);
  det.noteOutput('s1', true);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1'], 'a second run reports again');
});

test('quiet output after busy work still counts as finished', () => {
  // The last chunk of a build is often plain text, not "busy" — the run as a
  // whole was work, so it must still be reported.
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  t += 10_000;
  det.noteOutput('s1', false);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), ['s1']);
});

test('terminals are tracked independently and clear forgets one', () => {
  let t = 1_000_000;
  const det = new TerminalEventDetector(() => t);
  det.noteOutput('s1', true);
  det.noteOutput('s2', true);
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished().sort(), ['s1', 's2']);
  det.noteOutput('s1', true);
  det.clear('s1');
  t += 3 * MIN;
  assert.deepEqual(det.pollFinished(), [], 'cleared session is gone');
});
