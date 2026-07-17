import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isForwardableUrl, isLoopbackCallbackUrl } from './url.utils';

test('isForwardableUrl: only http/https', () => {
  assert.equal(isForwardableUrl('https://vercel.com/oauth'), true);
  assert.equal(isForwardableUrl('http://example.com'), true);
  assert.equal(isForwardableUrl('/Users/x/file.txt'), false); // `open file`
  assert.equal(isForwardableUrl('.'), false);                 // `open .`
  assert.equal(isForwardableUrl('-a'), false);                // `open -a App`
  assert.equal(isForwardableUrl('file:///tmp/x'), false);
  assert.equal(isForwardableUrl(''), false);
});

test('isLoopbackCallbackUrl: only localhost hosts', () => {
  assert.equal(isLoopbackCallbackUrl('http://localhost:51763/cb?code=1'), true);
  assert.equal(isLoopbackCallbackUrl('http://127.0.0.1:8976/cb'), true);
  assert.equal(isLoopbackCallbackUrl('http://[::1]:9000/cb'), true);
  assert.equal(isLoopbackCallbackUrl('https://vercel.com/cb'), false);
  assert.equal(isLoopbackCallbackUrl('http://100.64.0.1:9000/cb'), false); // Tailscale IP is NOT loopback
  assert.equal(isLoopbackCallbackUrl('not a url'), false);
});
