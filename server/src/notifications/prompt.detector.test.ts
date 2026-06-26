import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptDetector } from './prompt.detector';

// Real Claude Code v2.1.193 prompts arrive ANSI-glued after the server's ANSI_STRIP
// (every word is positioned with \x1b[NG, which the strip deletes). These fixtures are
// already in that post-strip, space-collapsed form so the unit tests match production.
const promptGlued = (cmd: string): string =>
  `Bashcommand\n${cmd}\nDoyouwanttoproceed?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend\n`;

const PAST_GRACE = 2000; // STARTUP_GRACE_MS is 1500

test('auto-approve fires for EACH of two back-to-back distinct prompts', () => {
  let t = 100_000;
  const det = new PromptDetector(() => t);
  const fires: string[] = [];
  det.watch('s1', (snip) => { fires.push(snip); det.noteApproved('s1'); });

  t += PAST_GRACE;
  det.feed('s1', promptGlued('rmfoo'));
  assert.equal(fires.length, 1, 'first prompt should fire');

  // Second, DISTINCT prompt arrives shortly after (typical agent/workflow burst).
  t += 700;
  det.feed('s1', promptGlued('rmbar'));
  assert.equal(fires.length, 2, 'second back-to-back prompt must also fire');

  det.unwatch('s1');
});

test('does NOT re-fire on the just-approved prompt being redrawn/torn down', () => {
  let t = 100_000;
  const det = new PromptDetector(() => t);
  const fires: string[] = [];
  det.watch('s1', (snip) => { fires.push(snip); det.noteApproved('s1'); });

  t += PAST_GRACE;
  det.feed('s1', promptGlued('rmfoo'));
  assert.equal(fires.length, 1);

  // Same prompt text fed again within the refractory window (residual redraw).
  t += 50;
  det.feed('s1', promptGlued('rmfoo'));
  assert.equal(fires.length, 1, 'identical residual of the approved prompt must not re-fire');

  det.unwatch('s1');
});

test('rewatch (reattach) preserves the grace window — a prompt right after reattach still fires', () => {
  let t = 100_000;
  const det = new PromptDetector(() => t);
  const fires: number[] = [];
  det.watch('s1', () => fires.push(1));

  t += PAST_GRACE;
  det.feed('s1', promptGlued('rmfoo'));
  assert.equal(fires.length, 1);

  // Reattach 500ms later: past the 400ms refractory, but FAR under a fresh 1500ms
  // startup grace. Old code (unwatch + watch) reset grace and dropped this prompt.
  t += 500;
  det.rewatch('s1', () => fires.push(2));
  det.feed('s1', promptGlued('rmbar'));
  assert.equal(fires.length, 2, 'prompt shortly after reattach must fire — no fresh blind window');

  det.unwatch('s1');
});

test('a large lingering prompt is not re-notified by the silence fallback (_check)', () => {
  let t = 100_000;
  const det = new PromptDetector(() => t);
  const fires: number[] = [];
  det.watch('s1', () => fires.push(1)); // notify-only style (no noteApproved)

  t += PAST_GRACE;
  // A prompt whose box exceeds SCAN_TAIL (1200) so the fast-path window (4000)
  // and the _check tail (1200) hash DIFFERENT substrings of the same screen.
  const bigPrompt = 'Bashcommand\n' + 'echo-stuff '.repeat(180) +
    '\nDoyouwanttoproceed?\n❯1.Yes\n2.No\nEsctocancel\n';
  det.feed('s1', bigPrompt);
  assert.equal(fires.length, 1, 'fast-path fires once');

  // Silence fallback fires later with the SAME screen still up — must dedup.
  t += 1300;
  (det as unknown as { _check(id: string): void })._check('s1');
  assert.equal(fires.length, 1, 'same on-screen prompt must not be re-notified by _check');

  det.unwatch('s1');
});

test('matches a freshly rendered prompt even when the rolling-window tail is past it', () => {
  let t = 100_000;
  const det = new PromptDetector(() => t);
  const fires: number[] = [];
  det.watch('s1', () => fires.push(1));

  t += PAST_GRACE;
  // Seed the rolling window with a large non-matching redraw burst.
  det.feed('s1', 'x'.repeat(6000));
  assert.equal(fires.length, 0);

  // One fat frame: prompt at the TOP, then a long diff body. The combined
  // window slice(-FAST_WINDOW) ends inside the diff (no match token), but the
  // chunk itself plainly contains the prompt — per-chunk matching must catch it.
  det.feed('s1', 'Doyouwanttoproceed?\n❯1.Yes\nEsctocancel\n' + 'd'.repeat(6000));
  assert.equal(fires.length, 1, 'prompt in a single fat frame must match despite window overflow');

  det.unwatch('s1');
});
