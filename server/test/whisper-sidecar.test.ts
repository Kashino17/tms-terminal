import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('fs', async (orig) => {
  const real = (await orig()) as typeof import('fs');
  return { ...real, existsSync: vi.fn(() => true) };
});

function makeChild() {
  const child: any = {
    stdin: { write: vi.fn(), writable: true },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: vi.fn(function (this: any) { this.killed = true; }),
    on: vi.fn(),
  };
  return child;
}

let spawned: any[] = [];
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = makeChild();
    spawned.push(child);
    setImmediate(() => child.stderr.emit('data', Buffer.from('[whisper-mlx] Ready for requests.\n')));
    return child;
  }),
}));

async function flush() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); }

describe('whisper-sidecar watchdog', () => {
  // Only fake setTimeout/clearTimeout so the fake clock drives the watchdog, while
  // setImmediate stays real (the mock sidecar's "ready" emit and flush() rely on it).
  beforeEach(() => { vi.resetModules(); spawned = []; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('resets the stall timeout on each progress message', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const p = mod.transcribe('AAAA', { onProgress: () => {} });
    await flush();
    const child = spawned.at(-1);

    // 40s pass, then a progress message resets the watchdog
    vi.advanceTimersByTime(40_000);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', progress: true, chunk: 1, total: 2, text: 'a' }) + '\n'));
    await flush();

    // another 40s (would have exceeded 45s total, but timer was reset) then final result
    vi.advanceTimersByTime(40_000);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', text: 'a b' }) + '\n'));

    await expect(p).resolves.toBe('a b');
  });

  it('rejects when no progress arrives within the stall window', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const p = mod.transcribe('AAAA');
    await flush();

    vi.advanceTimersByTime(45_001);
    await expect(p).rejects.toThrow(/Timeout/i);
  });
});
