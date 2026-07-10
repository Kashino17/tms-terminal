var test = require('node:test');
var assert = require('node:assert/strict');
var { reconcilePredictions } = require('./predictionReconcile');

test('empty queue returns empty confirmed and pending', function () {
  var result = reconcilePredictions([], 1000, 5000);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.pending, []);
});

test('entry older than the RTT window is confirmed', function () {
  var queue = [{ op: 'insert', char: 'a', sentAt: 1000 }];
  // now=5000, rtt=1000 -> watermark=4000; sentAt(1000) <= 4000 -> confirmed
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.pending.length, 0);
  assert.equal(result.confirmed[0].char, 'a');
});

test('entry newer than the RTT window is pending', function () {
  var queue = [{ op: 'insert', char: 'b', sentAt: 4800 }];
  // now=5000, rtt=1000 -> watermark=4000; sentAt(4800) > 4000 -> pending
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].char, 'b');
});

test('entry exactly at the watermark counts as confirmed', function () {
  var queue = [{ op: 'delete', sentAt: 4000 }];
  // now=5000, rtt=1000 -> watermark=4000; sentAt(4000) <= 4000 -> confirmed
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.pending.length, 0);
});

test('mixed queue splits and preserves order within each bucket', function () {
  var queue = [
    { op: 'insert', char: 'a', sentAt: 1000 }, // confirmed
    { op: 'insert', char: 'b', sentAt: 4800 }, // pending
    { op: 'delete', sentAt: 2000 },            // confirmed
    { op: 'insert', char: 'c', sentAt: 4900 }, // pending
  ];
  var result = reconcilePredictions(queue, 1000, 5000);
  assert.deepEqual(result.confirmed.map(function (e) { return e.sentAt; }), [1000, 2000]);
  assert.deepEqual(result.pending.map(function (e) { return e.sentAt; }), [4800, 4900]);
});
