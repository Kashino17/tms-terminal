import { test } from 'node:test';
import assert from 'node:assert';
import { rewriteTimeoutFor } from './prompt-rewriter-sidecar';

// Review M2: the output budget now scales with the input (2x tokens); a fixed
// 30s timeout would kill the rewriter on long dictations and fall back to raw text.
test('short transcripts keep the 30s timeout', () => {
  assert.strictEqual(rewriteTimeoutFor(200), 30_000);
});

test('a 4-minute dictation (~3600 chars) gets more time', () => {
  assert.ok(rewriteTimeoutFor(3600) >= 60_000);
});

test('the timeout is capped at 3 minutes', () => {
  assert.strictEqual(rewriteTimeoutFor(1_000_000), 180_000);
});
