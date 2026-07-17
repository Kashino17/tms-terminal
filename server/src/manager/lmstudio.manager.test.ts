import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDisplayName, parseModelsResponse } from './lmstudio.manager';

test('deriveDisplayName: strips vendor prefix and prettifies', () => {
  assert.equal(deriveDisplayName('qwen/qwen3.6-27b'), 'Qwen3.6 27b');
  assert.equal(deriveDisplayName('google/gemma-4-31b'), 'Gemma 4 31b');
  assert.equal(deriveDisplayName('llama-3'), 'Llama 3');
});

test('parseModelsResponse: keeps all types incl. embeddings, fills fields', () => {
  const json = { data: [
    { id: 'qwen/qwen3.6-27b', type: 'llm', max_context_length: 8192, loaded_context_length: 4096, state: 'loaded' },
    { id: 'nomic/embed', type: 'embeddings', max_context_length: 512, state: 'not-loaded' },
  ] };
  const m = parseModelsResponse(json);
  assert.equal(m.size, 2);
  const llm = m.get('qwen/qwen3.6-27b')!;
  assert.equal(llm.type, 'llm');
  assert.equal(llm.displayName, 'Qwen3.6 27b');
  assert.equal(llm.maxContext, 8192);
  assert.equal(llm.loadedContext, 4096);
  assert.equal(llm.state, 'loaded');
  const emb = m.get('nomic/embed')!;
  assert.equal(emb.type, 'embeddings');
  assert.equal(emb.loadedContext, null);
});
