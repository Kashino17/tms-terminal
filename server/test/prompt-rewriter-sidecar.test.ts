import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child: any = {
      stdin: { write: vi.fn((_d: string, cb?: (err?: Error) => void) => { cb && cb(); }), writable: true },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(function (this: any) { this.killed = true; }),
      on: vi.fn(),
    };
    setImmediate(() => child.stderr.emit('data', Buffer.from('[rewriter-sidecar] Ready for requests.\n')));
    return child;
  }),
}));

vi.mock('fs', async (orig) => {
  const real = (await orig()) as typeof import('fs');
  return { ...real, existsSync: vi.fn(() => true) };
});

describe('prompt-rewriter-sidecar', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('returns rewritten text for a transcript', async () => {
    const mod = await import('../src/audio/prompt-rewriter-sidecar');
    const child = (await import('child_process')).spawn as any;
    const promise = mod.rewrite('also ähm ich will halt');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const last = (child as any).mock.results.at(-1).value as any;
    last.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 'req-1', text: 'Bitte erweitere die Transkription.' }) + '\n'),
    );

    const text = await promise;
    expect(text).toBe('Bitte erweitere die Transkription.');
  });

  it('rejects on sidecar error response', async () => {
    const mod = await import('../src/audio/prompt-rewriter-sidecar');
    const child = (await import('child_process')).spawn as any;
    const promise = mod.rewrite('etwas');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const last = (child as any).mock.results.at(-1).value as any;
    last.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 'req-1', error: 'kaputt' }) + '\n'),
    );

    await expect(promise).rejects.toThrow(/kaputt/);
  });

  it('throws RewriterBusyError when a request is already in flight', async () => {
    const mod = await import('../src/audio/prompt-rewriter-sidecar');
    const child = (await import('child_process')).spawn as any;
    const first = mod.rewrite('eins');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await expect(mod.rewrite('zwei')).rejects.toThrow(/bereits/i);

    const last = (child as any).mock.results.at(-1).value as any;
    last.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 'req-1', text: 'fertig' }) + '\n'),
    );
    await first;
  });
});
