const { test } = require('node:test');
const assert = require('node:assert');
const DATA = require('./data.js');

test('servers: one online, one offline', () => {
  assert.equal(DATA.servers.length, 2);
  assert.equal(DATA.servers.filter(s => s.status === 'online').length, 1);
});

test('sessions: 4 named sessions, exactly one live claude session', () => {
  assert.equal(DATA.sessions.length, 4);
  for (const s of DATA.sessions) {
    assert.ok(s.id && s.name && s.description && s.colorTag && s.status);
    assert.ok(Array.isArray(s.buffer) && s.buffer.length > 0);
  }
  assert.equal(DATA.sessions.filter(s => s.live).length, 1);
  assert.ok(DATA.sessions.find(s => s.live).script.length > 5);
});

test('wrapped link demo present in a session buffer', () => {
  const all = DATA.sessions.flatMap(s => s.buffer).join('\n');
  assert.ok(all.includes(DATA.demo.wrappedLinkUrl.slice(0, 30)));
  assert.ok(DATA.demo.wrappedLinkUrl.startsWith('https://'));
});

test('cloud: 6 projects across vercel+render with env/logs/favorites/folders', () => {
  assert.equal(DATA.cloudProjects.length, 6);
  assert.ok(DATA.cloudProjects.some(p => p.provider === 'vercel'));
  assert.ok(DATA.cloudProjects.some(p => p.provider === 'render'));
  assert.ok(DATA.cloudProjects.some(p => p.favorite));
  for (const p of DATA.cloudProjects) {
    assert.ok(p.env.length >= 3 && p.logs.length >= 8 && typeof p.folder === 'string');
  }
});

test('manager conversation has voice message, artifact and memory', () => {
  assert.ok(DATA.manager.messages.some(m => m.type === 'voice'));
  assert.ok(DATA.manager.artifacts.length >= 2);
  assert.ok(DATA.manager.memory.length >= 3);
});

test('aux data present', () => {
  assert.equal(DATA.prayerTimes.length, 5);
  assert.ok(DATA.snippets.length >= 4 && DATA.notes.length >= 2);
  assert.ok(DATA.processes.length >= 6 && DATA.watchers.length >= 2);
  assert.equal(DATA.update.latest, '2.0.0');
});

test('per-session notes/todos and dictation demo present', () => {
  for (const s of DATA.sessions) {
    assert.ok(Array.isArray(s.notes) && Array.isArray(s.todos));
    for (const t of s.todos) assert.ok(t.id && t.text && typeof t.done === 'boolean');
  }
  assert.ok(DATA.sessions.filter(s => s.todos.length > 0).length >= 3);
  assert.ok(typeof DATA.demo.dictation === 'string' && DATA.demo.dictation.length > 5);
});
