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

test('questionScript: exactly one question prompt with options and a multiSelect flag', () => {
  const script = DATA.demo.questionScript;
  assert.ok(Array.isArray(script) && script.length > 3);
  const prompts = script.filter(e => e.type === 'prompt');
  assert.equal(prompts.length, 1);
  const q = prompts[0].data;
  assert.equal(q.kind, 'question');
  assert.ok(typeof q.question === 'string' && q.question.length > 5);
  assert.equal(typeof q.multiSelect, 'boolean');
  assert.ok(Array.isArray(q.options) && q.options.length >= 3);
  for (const o of q.options) assert.ok(o.id && o.label);
  assert.ok(script.some(e => e.type === 'done'));
});

test('per-session notes/todos and dictation demo present', () => {
  for (const s of DATA.sessions) {
    assert.ok(Array.isArray(s.notes) && Array.isArray(s.todos));
    for (const t of s.todos) assert.ok(t.id && t.text && typeof t.done === 'boolean');
  }
  assert.ok(DATA.sessions.filter(s => s.todos.length > 0).length >= 3);
  assert.ok(typeof DATA.demo.dictation === 'string' && DATA.demo.dictation.length > 5);
});

test('cloud accounts: both providers seeded as connected with masked keys', () => {
  const acc = DATA.cloudAccounts;
  assert.ok(acc && acc.vercel && acc.render);
  assert.equal(acc.vercel.connected, true);
  assert.equal(acc.render.connected, true);
  // Masked keys must never contain a full secret — middle is elided.
  assert.match(acc.vercel.maskedKey, /••••…/);
  assert.match(acc.render.maskedKey, /^rnd_/);
});

test('cloud org seed: folders, assignments, favorites, start folder, filters', () => {
  const org = DATA.cloudOrg;
  assert.ok(Array.isArray(org.folders) && org.folders.length >= 2);
  for (const f of org.folders) assert.ok(f.id && f.name && /^#/.test(f.color) && typeof f.order === 'number');
  const ids = new Set(DATA.cloudProjects.map(p => p.id));
  for (const pid of Object.keys(org.assignments)) assert.ok(ids.has(pid));
  for (const pid of Object.keys(org.favorites)) assert.ok(ids.has(pid));
  assert.ok(['fav', 'all', 'unsorted'].includes(org.startFolderId) || org.folders.some(f => f.id === org.startFolderId));
  assert.ok(['all', 'vercel', 'render'].includes(org.defaultFilters.provider));
  assert.ok(['all', 'active', 'attention'].includes(org.defaultFilters.status));
});
