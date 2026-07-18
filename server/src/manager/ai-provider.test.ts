import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiProviderRegistry, defaultContextFor } from './ai-provider';
import type { LmModelInfo } from './lmstudio.manager';

function info(entries: Array<Partial<LmModelInfo> & { key: string; type: string }>): Map<string, LmModelInfo> {
  const m = new Map<string, LmModelInfo>();
  for (const e of entries) {
    m.set(e.key, {
      key: e.key, displayName: e.displayName ?? e.key, type: e.type,
      maxContext: e.maxContext ?? 8192, loadedContext: e.loadedContext ?? null, state: e.state ?? 'not-loaded',
    });
  }
  return m;
}

test('refreshLocalProviders: creates chat models, skips embeddings, keeps cloud', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([
    { key: 'qwen/q27b', type: 'llm', displayName: 'Qwen 27B' },
    { key: 'meta/vision', type: 'vlm' },
    { key: 'nomic/embed', type: 'embeddings' },
  ]));
  const ids = reg.list().map(p => p.id);
  assert.ok(ids.includes('lmstudio:qwen/q27b'));
  assert.ok(ids.includes('lmstudio:meta/vision'));
  assert.ok(!ids.includes('lmstudio:nomic/embed'));
  assert.ok(ids.includes('glm')); // cloud unberührt
  assert.equal(reg.list().find(p => p.id === 'lmstudio:qwen/q27b')!.name, 'Qwen 27B');
});

test('refreshLocalProviders: removes stale local providers when uninstalled', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([{ key: 'qwen/q27b', type: 'llm' }]));
  assert.ok(reg.list().some(p => p.id === 'lmstudio:qwen/q27b'));
  reg.refreshLocalProviders(new Map());
  assert.ok(!reg.list().some(p => p.isLocal));
  assert.ok(reg.list().some(p => p.id === 'glm'));
});

test('getLocalModelKey resolves lmstudio: prefix', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([{ key: 'qwen/q27b', type: 'llm' }]));
  assert.equal(reg.getLocalModelKey('lmstudio:qwen/q27b'), 'qwen/q27b');
  assert.equal(reg.getLocalModelKey('glm'), null);
});

test('getActive falls back to configured cloud when active local model gone', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.refreshLocalProviders(info([{ key: 'qwen/q27b', type: 'llm' }]));
  reg.setActive('lmstudio:qwen/q27b');
  reg.refreshLocalProviders(new Map()); // Modell verschwindet
  assert.equal(reg.getActive().id, 'glm');
});

test('rememberContext + getSavedContext round-trip', () => {
  const reg = new AiProviderRegistry({ glmApiKey: 'k' });
  reg.rememberContext('qwen/q27b', 20000);
  assert.equal(reg.getSavedContext('qwen/q27b'), 20000);
  assert.equal(reg.getModelContextMap()['qwen/q27b'], 20000);
});

test('defaultContextFor: moderate default, never exceeds model max', () => {
  assert.equal(defaultContextFor(128000), 16384);
  assert.equal(defaultContextFor(8192), 8192);
  assert.equal(defaultContextFor(4096), 4096);
  assert.equal(defaultContextFor(2048), 2048); // respektiert kleines Modell-Max, kein Über-Max-Default
  assert.equal(defaultContextFor(0), 16384);   // unknown max
});
