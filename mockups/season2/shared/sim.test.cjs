const { test } = require('node:test');
const assert = require('node:assert');
const { createSession } = require('./sim.js');

const SCRIPT = [
  { t: 10, type: 'status', data: 'running' },
  { t: 10, type: 'out', data: 'hello ' },
  { t: 10, type: 'prompt', data: { tool: 'Edit', question: 'Erlauben?' } },
  { t: 10, type: 'out', data: 'world' },
  { t: 10, type: 'status', data: 'done' },
  { t: 10, type: 'done', data: null },
];

test('immediate mode pauses at prompt, respond() continues', () => {
  const events = [];
  const s = createSession(SCRIPT, { immediate: true });
  for (const ev of ['out', 'status', 'prompt', 'done']) s.on(ev, d => events.push([ev, d]));
  s.start();
  assert.equal(s.state, 'awaiting-prompt');
  assert.deepEqual(events.map(e => e[0]), ['status', 'out', 'prompt']);
  s.respond();
  assert.equal(s.state, 'done');
  assert.deepEqual(events.map(e => e[0]), ['status', 'out', 'prompt', 'out', 'status', 'done']);
});

test('autoApprove runs through without respond()', () => {
  const s = createSession(SCRIPT, { immediate: true, autoApprove: true });
  s.start();
  assert.equal(s.state, 'done');
});

test('reset() allows replay', () => {
  const s = createSession(SCRIPT, { immediate: true, autoApprove: true });
  s.start(); s.reset();
  assert.equal(s.state, 'idle');
  s.start();
  assert.equal(s.state, 'done');
});
