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

  // The Python sidecar handles requests one after another. A request abandoned
  // by the watchdog kept it busy, so every later dictation queued behind it.
  it('kills a stalled sidecar so later requests are not stuck behind it', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const stalled = mod.transcribe('AAAA');
    await flush();
    const first = spawned.at(-1);
    vi.advanceTimersByTime(45_001);
    await expect(stalled).rejects.toThrow(/Timeout/i);
    expect(first.kill).toHaveBeenCalledWith('SIGKILL');
  });

  // Review I5: the sidecar is serial. A request merely WAITING behind a long,
  // healthy one (progress keeps coming) must neither fail nor kill the sidecar.
  it('does not time out a queued request while the sidecar keeps producing output', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const a = mod.transcribe('AAAA', { onProgress: () => {} });
    const b = mod.transcribe('BBBB');
    await flush();
    const child = spawned.at(-1);
    for (let t = 0; t < 3; t++) {
      vi.advanceTimersByTime(30_000);
      child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', progress: true, chunk: t + 1, total: 4, text: 'x' }) + '\n'));
      await flush();
    }
    child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', text: 'a' }) + '\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-2', text: 'b' }) + '\n'));
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(child.kill).not.toHaveBeenCalled();
  });

  // Review M3: after the SIGKILL a new request may already have started a new
  // sidecar before the old one's 'exit' fires — that exit must not orphan it.
  it("a killed sidecar's late exit does not replace the new sidecar", async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const stalled = mod.transcribe('AAAA');
    await flush();
    const first = spawned.at(-1);
    vi.advanceTimersByTime(45_001);
    await expect(stalled).rejects.toThrow(/Timeout/i);
    const next = mod.transcribe('CCCC');
    await flush();
    expect(spawned.length).toBe(2);
    const exitCall = first.on.mock.calls.find((c: any[]) => c[0] === 'exit');
    exitCall[1](null);
    await flush();
    const third = mod.transcribe('DDDD');
    await flush();
    expect(spawned.length).toBe(2);
    const second = spawned.at(-1);
    second.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-2', text: 'c' }) + '\n'));
    second.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-3', text: 'd' }) + '\n'));
    await expect(next).resolves.toBe('c');
    await expect(third).resolves.toBe('d');
  });

  it('restarts sidecar and retries the request once on crash', async () => {
    const mod = await import('../src/audio/whisper-sidecar');
    const p = mod.transcribe('AAAA');
    await flush();
    const first = spawned.at(-1);

    // Grab the exit handler the module registered, then simulate a crash.
    const exitCall = first.on.mock.calls.find((c: any[]) => c[0] === 'exit');
    expect(exitCall).toBeTruthy();
    exitCall[1](1); // exit code 1
    await flush();

    // A new sidecar was spawned and becomes ready.
    expect(spawned.length).toBe(2);
    const second = spawned.at(-1);
    second.stderr.emit('data', Buffer.from('[whisper-mlx] Ready for requests.\n'));
    await flush();

    // The retried request now resolves.
    second.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'req-1', text: 'recovered' }) + '\n'));
    await expect(p).resolves.toBe('recovered');
  });
});
