process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Outbox } from './outbox';

const MIN = 60_000;
const HOUR = 60 * MIN;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-outbox-'));
}

function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/** Outbox on a temp dir with a hand-cranked clock. */
function makeOutbox(startNow: number) {
  const dir = tmpDir();
  let now = startNow;
  const outbox = new Outbox(() => now, dir);
  return { outbox, dir, advance(ms: number) { now += ms; }, setNow(t: number) { now = t; } };
}

test('a reminder always gets through', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  const msg = h.outbox.push({ kind: 'reminder', text: 'Zahnarzt um 14 Uhr' });
  assert.notEqual(msg, null);
  assert.equal(h.outbox.unreadCount(), 1);
});

test('five reminders at the same minute all get through — the cap is for the agent, not the user', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  for (let i = 0; i < 5; i++) {
    assert.notEqual(h.outbox.push({ kind: 'reminder', text: `Erinnerung ${i}`, sessionId: 's1' }), null);
  }
  assert.equal(h.outbox.unreadCount(), 5);
});

test('a second suggestion for the same terminal within the hour is refused', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'Idee A', sessionId: 's1' }), null);
  h.advance(30 * MIN);
  assert.equal(h.outbox.push({ kind: 'suggestion', text: 'Idee B', sessionId: 's1' }), null);
  h.advance(31 * MIN); // now more than an hour after the first
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'Idee C', sessionId: 's1' }), null);
});

test('the hourly cap is per terminal, not global', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'A', sessionId: 's1' }), null);
  assert.notEqual(h.outbox.push({ kind: 'suggestion', text: 'B', sessionId: 's2' }), null);
});

test('check-ins ignore the per-terminal cap because they belong to no terminal', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.push({ kind: 'suggestion', text: 'Idee', sessionId: 's1' });
  assert.notEqual(h.outbox.push({ kind: 'checkin', text: 'Das steht heute an' }), null);
});

test('the same topic is never delivered twice', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.notEqual(h.outbox.push({ kind: 'stuck', text: 'Hängst du?', topicKey: 'stuck:abc' }), null);
  h.advance(5 * HOUR); // long past the hourly cap
  assert.equal(h.outbox.push({ kind: 'stuck', text: 'Hängst du immer noch?', topicKey: 'stuck:abc' }), null);
});

test('a suppressed topic is refused forever', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.suppressTopic('stuck:xyz');
  h.advance(30 * 24 * HOUR);
  assert.equal(h.outbox.push({ kind: 'stuck', text: 'Vorschlag', topicKey: 'stuck:xyz' }), null);
});

test('dismissing a message suppresses its topic', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  const msg = h.outbox.push({ kind: 'suggestion', text: 'Idee', topicKey: 'sug:1' })!;
  h.outbox.dismiss(msg.id);
  h.advance(5 * HOUR);
  assert.equal(h.outbox.push({ kind: 'suggestion', text: 'Idee nochmal', topicKey: 'sug:1' }), null);
});

test('quiet hours suppress the push but not the message', () => {
  const h = makeOutbox(at(2026, 8, 4, 23, 30)); // inside 23:00–07:00
  const msg = h.outbox.push({ kind: 'checkin', text: 'Nachts' })!;
  assert.notEqual(msg, null, 'the message is still created');
  assert.equal(h.outbox.unreadCount(), 1, 'and it still counts in the badge');
  assert.equal(h.outbox.shouldPush(msg), false, 'only the push is withheld');
});

test('a reminder pushes even at night — the user asked to be woken', () => {
  const h = makeOutbox(at(2026, 8, 5, 6, 0)); // inside quiet hours
  const msg = h.outbox.push({ kind: 'reminder', text: 'Aufstehen' })!;
  assert.equal(h.outbox.shouldPush(msg), true);
});

test('outside quiet hours everything pushes', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  const msg = h.outbox.push({ kind: 'suggestion', text: 'Tagsüber' })!;
  assert.equal(h.outbox.shouldPush(msg), true);
});

test('markAllRead clears the badge', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  h.outbox.push({ kind: 'reminder', text: 'A' });
  h.outbox.push({ kind: 'reminder', text: 'B' });
  assert.equal(h.outbox.unreadCount(), 2);
  h.outbox.markAllRead();
  assert.equal(h.outbox.unreadCount(), 0);
});

test('the outbox is capped at 500, dropping read messages first', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  for (let i = 0; i < 400; i++) h.outbox.push({ kind: 'reminder', text: `alt ${i}` });
  h.outbox.markAllRead();
  for (let i = 0; i < 200; i++) {
    h.advance(MIN);
    h.outbox.push({ kind: 'reminder', text: `neu ${i}` });
  }
  const all = h.outbox.list(1000);
  assert.equal(all.length, 500);
  assert.equal(h.outbox.unreadCount(), 200, 'unread messages must survive the cap');
});

test('state survives a fresh Outbox on the same directory', () => {
  const h = makeOutbox(at(2026, 8, 4, 10, 0));
  h.outbox.push({ kind: 'reminder', text: 'Persistiert' });
  h.outbox.suppressTopic('t:1');
  const reopened = new Outbox(() => at(2026, 8, 4, 11, 0), h.dir);
  assert.equal(reopened.unreadCount(), 1);
  assert.equal(reopened.push({ kind: 'stuck', text: 'x', topicKey: 't:1' }), null);
});

test('canAccept agrees with push', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  assert.equal(h.outbox.canAccept({ kind: 'stuck', topicKey: 'k', sessionId: 's1' }), true);
  h.outbox.push({ kind: 'stuck', text: 'A', topicKey: 'k', sessionId: 's1' });
  assert.equal(h.outbox.canAccept({ kind: 'stuck', topicKey: 'k', sessionId: 's1' }), false);
});

test('canAccept does not itself create a message', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.canAccept({ kind: 'stuck', topicKey: 'k' });
  assert.equal(h.outbox.unreadCount(), 0);
});

test('canAccept sees a suppressed topic', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.suppressTopic('tot');
  assert.equal(h.outbox.canAccept({ kind: 'suggestion', topicKey: 'tot' }), false);
});

test('canAccept lets reminders through regardless of the terminal cooldown', () => {
  const h = makeOutbox(at(2026, 8, 4, 14, 0));
  h.outbox.push({ kind: 'suggestion', text: 'Idee', sessionId: 's1' });
  assert.equal(h.outbox.canAccept({ kind: 'reminder', sessionId: 's1' }), true);
});
