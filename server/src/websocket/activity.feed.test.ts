import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityFeed } from './activity.feed';
import type { Activity } from '../terminal/activity';

function rig(initial: Record<string, Activity> = {}) {
  const sent: Array<Record<string, Activity | null>> = [];
  const feed = createActivityFeed((changes) => { sent.push(changes); }, initial);
  return { feed, sent };
}
const work = (task: string): Activity => ({ task, state: 'working' });
const done = (task: string): Activity => ({ task, state: 'done' });

test('beim Verbinden: der ganze Stand in einer Nachricht — leer heißt keine Nachricht', () => {
  const a = rig({ s1: work('A'), s2: done('B') });
  a.feed.start();
  assert.deepEqual(a.sent, [{ s1: work('A'), s2: done('B') }]);
  const b = rig();
  b.feed.start();
  assert.deepEqual(b.sent, []);
});

test('im Vordergrund geht jeder Wechsel sofort raus', () => {
  const { feed, sent } = rig();
  feed.start();
  feed.note('s1', work('A'));
  feed.note('s1', done('A'));
  feed.note('s1', null);
  assert.deepEqual(sent, [{ s1: work('A') }, { s1: done('A') }, { s1: null }]);
});

test('App im Hintergrund: NICHTS wird gesendet — beim Zurückkehren eine Nachricht mit dem Endstand', () => {
  const { feed, sent } = rig({ s1: work('A') });
  feed.start();
  feed.setForeground(false);
  feed.note('s1', done('A'));
  feed.note('s2', work('B'));
  feed.note('s2', done('B'));
  feed.note('s3', work('C'));
  feed.note('s3', null); // kam und ging, während niemand hinsah
  assert.equal(sent.length, 1, 'nur die Start-Nachricht');
  feed.setForeground(true);
  assert.deepEqual(sent[1], { s1: done('A'), s2: done('B') }, 's3 hat die App nie gekannt — also auch kein Löschen');
  feed.setForeground(true);
  assert.equal(sent.length, 2, 'kein zweites Mal');
});

test('im Hintergrund hin und zurück zum bekannten Stand: nichts zu melden', () => {
  const { feed, sent } = rig({ s1: done('A') });
  feed.start();
  feed.setForeground(false);
  feed.note('s1', work('A'));
  feed.note('s1', done('A'));
  feed.setForeground(true);
  assert.equal(sent.length, 1);
});
