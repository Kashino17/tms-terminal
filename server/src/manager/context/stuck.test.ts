import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErrorLine, errorSignature, StuckDetector } from './stuck';

const MIN = 60_000;

test('the same error with different line numbers and paths normalises identically', () => {
  const a = "TypeError: Cannot read properties of undefined (reading 'x') at /Users/ayysir/Desktop/Foo/src/a.ts:42:11";
  const b = "TypeError: Cannot read properties of undefined (reading 'x') at /Users/ayysir/Desktop/Foo/src/a.ts:87:3";
  assert.equal(normalizeErrorLine(a), normalizeErrorLine(b));
  assert.equal(errorSignature(a), errorSignature(b));
});

test('two genuinely different errors get different signatures', () => {
  assert.notEqual(
    errorSignature('Error: ENOENT: no such file or directory'),
    errorSignature('Error: connect ECONNREFUSED'),
  );
});

test('ordinary output is not an error', () => {
  assert.equal(errorSignature('npm run build'), null);
  assert.equal(errorSignature('✓ 42 tests passed'), null);
  assert.equal(errorSignature(''), null);
});

test('common error shapes are recognised', () => {
  for (const line of [
    'Error: something broke',
    'TypeError: x is not a function',
    'npm ERR! code ELIFECYCLE',
    'FAILED src/test_thing.py::test_a',
    'Traceback (most recent call last):',
    'fatal: not a git repository',
  ]) {
    assert.notEqual(errorSignature(line), null, `should be an error: ${line}`);
  }
});

test('the third occurrence within the window raises a signal', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: connect ECONNREFUSED 127.0.0.1:5432\n';

  assert.equal(det.feed('s1', err), null, 'first');
  t += 2 * MIN;
  assert.equal(det.feed('s1', err), null, 'second');
  t += 2 * MIN;
  const signal = det.feed('s1', err);
  assert.notEqual(signal, null, 'third must trigger');
  assert.equal(signal!.count, 3);
  assert.equal(signal!.sessionId, 's1');
  assert.match(signal!.sample, /ECONNREFUSED/);
});

test('occurrences spread wider than the window never accumulate', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: gleich bleibender Fehler\n';
  for (let i = 0; i < 5; i++) {
    assert.equal(det.feed('s1', err), null, `occurrence ${i} is too far apart`);
    t += 25 * MIN; // window is 20 min
  }
});

test('a signature signals only once — repeating it would be nagging', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: immer derselbe\n';
  det.feed('s1', err); t += MIN;
  det.feed('s1', err); t += MIN;
  assert.notEqual(det.feed('s1', err), null, 'first signal');
  t += MIN;
  assert.equal(det.feed('s1', err), null, 'must stay quiet afterwards');
});

test('terminals are counted separately', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: geteilt\n';
  det.feed('s1', err); det.feed('s2', err);
  det.feed('s1', err); det.feed('s2', err);
  assert.notEqual(det.feed('s1', err), null);
  assert.notEqual(det.feed('s2', err), null, 's2 has its own count');
});

test('several errors in one chunk are all counted', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const chunk = 'Error: wiederholt sich\nirgendwas\nError: wiederholt sich\n';
  assert.equal(det.feed('s1', chunk), null, 'two so far');
  assert.notEqual(det.feed('s1', 'Error: wiederholt sich\n'), null, 'third triggers');
});

test('clear forgets a terminal', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  const err = 'Error: weg damit\n';
  det.feed('s1', err); det.feed('s1', err);
  det.clear('s1');
  assert.equal(det.feed('s1', err), null, 'counting starts over');
});

test('a timestamped log line still matches itself across occurrences', () => {
  // Real build output carries a clock; without normalising it every repeat
  // would look like a brand new problem.
  const a = '[2026-07-28 08:03:17] ERROR  Cannot resolve module "foo"';
  const b = '[2026-07-28 09:41:02] ERROR  Cannot resolve module "foo"';
  assert.equal(errorSignature(a), errorSignature(b));
});

test('memory does not grow without bound on a noisy terminal', () => {
  let t = 1_000_000;
  const det = new StuckDetector(() => t);
  for (let i = 0; i < 5000; i++) {
    det.feed('s1', `Error: einzigartiger Fehler Nummer ${i}-${'x'.repeat(i % 7)}\n`);
    t += 1000;
  }
  assert.ok(det.trackedSignatures('s1') <= 500,
    `expected the signature table to stay bounded, got ${det.trackedSignatures('s1')}`);
});

test('a clean build that reports "0 errors" is not treated as a problem', () => {
  // The plural is the tell: "errors" as a count, "Error"/"TypeError" as a failure.
  assert.equal(errorSignature('✓ compiled with 0 errors, 0 warnings'), null);
  assert.equal(errorSignature('Found 0 errors.'), null);
  assert.notEqual(errorSignature('TypeError: x is not a function'), null);
});
